// Picking edits in the panel: page lists, impact assessment and the diff
// viewer apply only the selected edits.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/index/store.js";
import { Capturer } from "../src/capture/capture.js";
import { Session } from "../src/daemon/session.js";
import type { AssessProgress } from "../src/rpc/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSiteDir = path.resolve(__dirname, "../../../fixtures/site");

describe.skipIf(!!process.env.CBR_NO_BROWSER)("Session: selected edits", () => {
  let tempDir: string;
  let cssPath: string;
  let original: string;
  let session: Session;
  let version = 1;
  let hero = "";
  let title = "";

  const edit = (text: string) => session.change(cssPath, ++version, [{ text }]);
  const names = async () => (await session.getPages({})).pages.map((p) => path.basename(p.url));
  const urlOf = async (name: string) => {
    session.setSelection(undefined);
    const url = (await session.getPages({})).pages.find((p) => path.basename(p.url) === name)?.url;
    if (!url) throw new Error(`${name} not listed`);
    return url;
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-select-"));
    const ws = path.join(tempDir, "site");
    const dataDir = path.join(tempDir, "data");
    fs.cpSync(fixtureSiteDir, ws, { recursive: true });
    execSync('git init -q -b main && git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -q -m A', { cwd: ws, stdio: "ignore", shell: "/bin/sh" });
    cssPath = path.join(ws, "css", "main.css");
    original = fs.readFileSync(cssPath, "utf8");
    const cfg = loadConfig(ws, { dataDir });
    const store = new Store(cfg.dataDir);
    await new Capturer(cfg, store).run({});
    store.close();
    session = await Session.create({ workspaceRoot: ws, dataDir, watch: false, l1Workers: 0 });
    await session.open(cssPath, original, version);
    // #hero is on index.html only; .card .title on both pages.
    await edit(original.replace("color: darkred;", "color: green;").replace("font-weight: bold;", "font-weight: bold;\n  color: red;"));
    const changes = session.fileAnswer(cssPath).changes;
    hero = changes.find((c) => c.selector === "#hero")!.id;
    title = changes.find((c) => c.selector === ".card .title")!.id;
  }, 120_000);

  afterAll(async () => {
    await session?.dispose();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists the pages of the selected edits only", async () => {
    session.setSelection(undefined);
    expect(await names()).toEqual(["about.html", "index.html"]);
    session.setSelection([{ path: cssPath, changeIds: [hero] }]);
    expect(await names()).toEqual(["index.html"]);
    expect((await session.getPages({})).count.exact).toBe(1);
    session.setSelection([{ path: cssPath }]);
    expect(await names()).toEqual(["about.html", "index.html"]);
    session.setSelection([]);
    expect(await names()).toEqual([]);
    // A path still lists that file or change, whatever is selected.
    expect((await session.getPages({ path: cssPath, changeId: title })).pages).toHaveLength(2);
  });

  it("keeps change ids while the rule is edited, so a selection survives typing", async () => {
    await edit(original.replace("color: darkred;", "color: purple;").replace("font-weight: bold;", "font-weight: bold;\n  color: red;"));
    const changes = session.fileAnswer(cssPath).changes;
    expect(changes.find((c) => c.selector === "#hero")!.id).toBe(hero);
    expect(changes.find((c) => c.selector === ".card .title")!.id).toBe(title);
  });

  it("shows only the selected edits in the diff viewer", async () => {
    const index = await urlOf("index.html");
    const all = await session.pageDiff({ url: index });
    expect(all.status).toBe("changed");
    expect(all.changedElements).toBe(2);
    expect(all.edits).toEqual([{ file: "css/main.css", changes: 2, of: 2 }]);
    expect(all.editsTotal).toBe(2);

    session.setSelection([{ path: cssPath, changeIds: [title] }]);
    const one = await session.pageDiff({ url: index });
    expect(one.status).toBe("changed");
    expect(one.changedElements).toBe(1);
    expect(one.edits).toEqual([{ file: "css/main.css", changes: 1, of: 2 }]);
    expect(one.zones.map((z) => z.props.map((p) => p.prop)).flat()).toEqual(["color"]);
    expect(one.zones.every((z) => !/hero/.test(z.label))).toBe(true);
    expect(one.warnings).toEqual([]);

    session.setSelection([]);
    const none = await session.pageDiff({ url: index });
    expect(none.status).toBe("unchanged");
    expect(none.reason).toMatch(/None of your edits are picked/);
    expect(none.editsTotal).toBe(2);
  });

  it("assesses the selected edits and keeps results per selection", async () => {
    const finished = () =>
      new Promise<AssessProgress>((resolve) => {
        const on = (p: AssessProgress) => {
          if (p.running) return;
          session.off("assess", on);
          resolve(p);
        };
        session.on("assess", on);
      });
    session.setSelection([{ path: cssPath, changeIds: [hero] }]);
    const done = finished();
    expect((await session.assess({})).running).toBe(true);
    await done;
    const ranked = await session.getPages({});
    expect(ranked.pages.map((p) => [path.basename(p.url), p.impact?.status, p.impact?.changed])).toEqual([["index.html", "changed", 1]]);

    session.setSelection(undefined);
    expect((await session.getPages({})).assessment).toMatchObject({ assessed: 0, pending: 2 });
    session.setSelection([{ path: cssPath, changeIds: [hero] }]);
    expect((await session.getPages({})).assessment).toMatchObject({ assessed: 1, pending: 0 });
  });
});
