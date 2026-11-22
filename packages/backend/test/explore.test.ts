// J2 (#5): the scan tries each page's interactions and records which script
// code runs after them; script edits count those pages as exact.
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
});
