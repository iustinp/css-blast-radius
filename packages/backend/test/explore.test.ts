// J2 (#5): the scan tries each page's interactions and records which script
// code runs after them; script edits count those pages as exact. J3b: page
// diffs and assessments do those interactions again, with and without the edits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Store, type PageRow } from "../src/index/store.js";
import { SiteIndex } from "../src/index/siteIndex.js";
import { Capturer } from "../src/capture/capture.js";
import type { ExploredAction } from "../src/capture/explore.js";
import { Session } from "../src/daemon/session.js";
import type { AssessProgress } from "../src/rpc/protocol.js";
import { ranIn, unionSegments, type Segments } from "../src/util/coverage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(__dirname, "../../../fixtures/explore");

describe.skipIf(!!process.env.CBR_NO_BROWSER)("interactions (J2)", () => {
  let tmp: string;
  let ws: string;
  let notes: any;
  let rows: Map<string, PageRow>;
  let acts: Map<string, ExploredAction[]>;
  let loadRan: Map<string, Record<string, Segments>>;
  let session: Session;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-explore-"));
    ws = path.join(tmp, "site");
    fs.cpSync(fixture, ws, { recursive: true });
    for (const c of ["git init -b main", 'git config user.name "T"', 'git config user.email "t@example.com"', "git add .", 'git commit -m "init"'])
      execSync(c, { cwd: ws, stdio: "ignore" });
    const cfg = loadConfig(ws, { dataDir: path.join(tmp, "data") });
    const store = new Store(cfg.dataDir);
    notes = (await new Capturer(cfg, store).run({})).notes;
    const idx = SiteIndex.load(store)!;
    rows = new Map(idx.pages.map((p) => [p.url.replace(/^.*\//, ""), p]));
    acts = new Map(idx.pages.map((p) => [p.url.replace(/^.*\//, ""), idx.actions(p)]));
    loadRan = new Map(idx.pages.map((p) => [p.url.replace(/^.*\//, ""), Object.fromEntries(Object.entries(p.coverage ?? {}).map(([k, h]) => [k, idx.coverage(h)!]))]));
    store.close();
    session = await Session.create({ workspaceRoot: ws, dataDir: path.join(tmp, "data"), watch: false, l1Workers: 0 });
  }, 120_000);

  afterAll(async () => {
    await session?.dispose();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Offsets of a function's body in a fixture script. */
  const body = (file: string, fn: string): [number, number] => {
    const text = fs.readFileSync(path.join(fixture, file), "utf8");
    const at = text.indexOf(`function ${fn}(`);
    expect(at).toBeGreaterThanOrEqual(0);
    return [text.indexOf("{", at) + 1, text.indexOf("\n}", at)];
  };
  const ranAfter = (page: string, key: string, fn: string): boolean => {
    const segs = (acts.get(page) ?? []).reduce<Segments>((u, a) => unionSegments(u, a.ran[key] ?? []), []);
    return ranIn(segs, ...body(key.slice(1), fn));
  };

  it("tries the interactions, keeps the page, and shares what pages repeat", () => {
    expect(notes.explore).toMatchObject({ depth: 3, actions: 30, pages: 5 });
    expect(notes.explore.inherited).toBeGreaterThanOrEqual(2);

    // The menu: a button that reveals another (two steps in a row).
    const a = acts.get("a.html")!;
    const menu = a.findIndex((x) => x.label === "Menu");
    expect(a[menu]).toMatchObject({ depth: 1, parent: -1, kind: "click" });
    expect(a.find((x) => x.label === "More")).toMatchObject({ depth: 2, parent: menu });
    expect(ranAfter("a.html", "/js/header.js", "moreClicked")).toBe(true);

    // The same header on the later pages: its outcome is reused, not tried again.
    expect(rows.get("d.html")!.explored).toMatchObject({ tried: 0 });
    expect(acts.get("d.html")!.every((x) => x.inherited)).toBe(true);
    expect(ranAfter("d.html", "/js/header.js", "moreClicked")).toBe(true);

    const index = rows.get("index.html")!;
    for (const fn of ["searched", "picked", "hovered", "opened", "blocked", "dot", "awayClicked"]) expect([fn, ranAfter("index.html", "/js/page.js", fn)]).toEqual([fn, true]);
    // The POST was stopped, the form not sent, the link didn't leave the page.
    for (const fn of ["saved", "submitted", "neverCalled"]) expect([fn, ranAfter("index.html", "/js/page.js", fn)]).toEqual([fn, false]);
    expect(Object.keys(index.loaded ?? {})).not.toContain("/js/a-only.js");
    // A script loaded on a click is recorded as loaded, with what ran.
    expect(index.loaded?.["/js/lazy.js"]).toBeTruthy();
    expect(index.explored?.coverage["/js/lazy.js"]).toBeTruthy();
    // Buttons alike stop being tried once they bring nothing new.
    expect(acts.get("index.html")!.filter((x) => /^\d$/.test(x.label)).length).toBeLessThanOrEqual(4);
    // A timer just after load counts as load.
    expect(ranIn(loadRan.get("index.html")!["/js/page.js"], ...body("js/page.js", "soon"))).toBe(true);
  });

  it("script edits count the pages where the code ran after an interaction", async () => {
    const edit = async (file: string, from: string, to: string) => {
      const p = path.join(ws, file);
      const text = fs.readFileSync(p, "utf8");
      expect(text).toContain(from);
      const res = await session.open(p, text.replace(from, to), 1);
      await session.close(p);
      expect(res.answer.changes).toHaveLength(1);
      return res.answer.changes[0];
    };

    const search = await edit("js/page.js", '"searching "', '"finding "');
    expect(search).toMatchObject({ reasons: ["script-runs-after"], pages: { exact: 1, possible: 0 } });
    expect(search.after).toEqual({ pages: 1, example: { url: expect.stringMatching(/index\.html$/), steps: ["type in “Search”"] } });

    const more = await edit("js/header.js", '" +"', '" ++"');
    expect(more).toMatchObject({ reasons: ["script-runs-after"], pages: { exact: 5, possible: 0 } });
    expect(more.after).toEqual({ pages: 5, example: { url: expect.stringMatching(/a\.html$/), steps: ["click “Menu”", "click “More”"] } });

    const never = await edit("js/page.js", '"never"', '"not ever"');
    expect(never).toMatchObject({ reasons: ["script-not-reached"], pages: { exact: 0, possible: 1 } });
    expect(never.after).toBeUndefined();

    const soon = await edit("js/page.js", 'dataset.soon = "1"', 'dataset.soon = "2"');
    expect(soon).toMatchObject({ reasons: ["script-runs"], pages: { exact: 1 } });
  }, 30_000);

  /** Runs `fn` with the files edited in the session (each swap done once). */
  const editing = async <T>(files: Record<string, Array<[string, string]>>, fn: () => Promise<T>): Promise<T> => {
    const opened: string[] = [];
    try {
      for (const [file, swaps] of Object.entries(files)) {
        const p = path.join(ws, file);
        let text = fs.readFileSync(p, "utf8");
        for (const [from, to] of swaps) {
          expect(text).toContain(from);
          text = text.replace(from, to);
        }
        await session.open(p, text, 1);
        opened.push(p);
      }
      return await fn();
    } finally {
      for (const p of opened) await session.close(p);
    }
  };
  const pageDiff = (page: string) => session.pageDiff({ url: rows.get(page)!.url });

  it("page diffs do the interactions that run the edited code again, comparing after each step", async () => {
    const search = await editing({ "js/page.js": [['"searching "', '"finding "']] }, async () => {
      const d = await pageDiff("index.html");
      // Assessing counts what changes after the interaction too.
      const done = new Promise<AssessProgress>((resolve) => {
        const on = (p: AssessProgress) => {
          if (p.running) return;
          session.off("assess", on);
          resolve(p);
        };
        session.on("assess", on);
      });
      const p = path.join(ws, "js/page.js");
      if ((await session.assess({ path: p })).running) await done;
      const list = await session.getPages({ path: p });
      expect(list.pages.map((x) => [x.url.replace(/^.*\//, ""), x.impact?.status])).toEqual([["index.html", "changed"]]);
      expect(list.pages[0].impact!.changed).toBeGreaterThan(0);
      return d;
    });
    // Nothing on load: the text changes once something is typed in the search box.
    expect(search).toMatchObject({ scripts: true, status: "unchanged", changedElements: 0 });
    expect(search.steps).toMatchObject([{ path: 0, step: 1, label: "type in “Search”", status: "changed" }]);
    const typed = search.steps![0];
    expect(typed.changedElements).toBeGreaterThan(0);
    expect(typed.zones.length).toBeGreaterThan(0);
    expect(typed.before).toMatch(/^data:image\/jpeg;base64,/);
    expect(typed.after).toMatch(/^data:image\/jpeg;base64,/);
    expect(typed.after).not.toBe(typed.before);

    // A script the click loads is served edited too.
    const lazy = await editing({ "js/lazy.js": [['"lazy"', '"lazier"']] }, () => pageDiff("index.html"));
    expect(lazy.steps).toMatchObject([{ label: "click “Load”", status: "changed" }]);

    // The POST is stopped as when the scan tried it: “blocked” shows, never “saved” (the same on both sides).
    const save = await editing({ "js/page.js": [['"blocked"', '"blocked!"']] }, () => pageDiff("index.html"));
    expect(save.steps).toMatchObject([{ label: "click “Save”", status: "changed" }]);
  }, 120_000);

  it("a step the edited page can't do any more shows as a change", async () => {
    // The menu no longer opens, so its More button can't be clicked.
    const d = await editing({ "js/header.js": [["= !open", "= true"], ['" +"', '" ++"']] }, () => pageDiff("a.html"));
    const at = d.steps!.find((x) => x.label === "click “More”")!;
    expect(at).toBeTruthy();
    expect(d.steps!.filter((x) => x.path === at.path)).toMatchObject([
      { step: 1, label: "click “Menu”", status: "changed" },
      { step: 2, status: "changed", reason: expect.stringMatching(/With your edits, “More” can't be done/), changedElements: 0 },
    ]);
    expect(at.before).toMatch(/^data:image\/jpeg;base64,/);
  }, 120_000);

  it("an action a page inherited is done with the steps after it that ran the code, as on the template's pages", async () => {
    // d.html tried nothing itself: its Menu inherits what Menu → More ran on the pages before.
    const d = await editing({ "js/header.js": [['document.title += " +";', 'document.title += " +"; document.querySelector("main h1").textContent = "More";']] }, () =>
      pageDiff("d.html"),
    );
    expect(d.steps).toMatchObject([
      { path: 0, step: 1, label: "click “Menu”", status: "unchanged" },
      { path: 0, step: 2, label: "click “More”", status: "changed" },
    ]);
    expect(d.steps![1].zones.map((z) => z.label).join(" ")).toMatch(/h1/);
  }, 120_000);
});
