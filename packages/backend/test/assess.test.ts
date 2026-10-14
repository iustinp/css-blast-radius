// "Assess impact": every listed page checked visually in the background,
// then the list ranked by how much each page changes.

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

describe.skipIf(!!process.env.CBR_NO_BROWSER)("Session: assess impact", () => {
  let tempDir: string;
  let cssPath: string;
  let original: string;
  let session: Session;
  let version = 1;

  const finished = () =>
    new Promise<AssessProgress>((resolve) => {
      const on = (p: AssessProgress) => {
        if (p.running) return;
        session.off("assess", on);
        resolve(p);
      };
      session.on("assess", on);
    });
  const edit = (text: string) => session.change(cssPath, ++version, [{ text }]);
  const assessAll = async () => {
    const done = finished();
    const started = await session.assess({ path: cssPath });
    if (!started.running) return started;
    return done;
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-assess-"));
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
  }, 120_000);

  afterAll(async () => {
    await session?.dispose();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ranks the pages by changed elements once the assessment is done", async () => {
    await edit(original.replace("color: darkred;", "color: green;").replace("font-weight: bold;", "font-weight: bold;\n  color: red;"));
    const before = await session.getPages({ path: cssPath });
    expect(before.pages.map((p) => path.basename(p.url))).toEqual(["about.html", "index.html"]);
    expect(before.assessment).toMatchObject({ running: false, assessed: 0, pending: 2 });
    expect(before.pages.every((p) => !p.impact)).toBe(true);

    const p = await assessAll();
    expect(p).toMatchObject({ running: false, done: 2, total: 2 });
    const after = await session.getPages({ path: cssPath });
    expect(after.pages.map((x) => path.basename(x.url))).toEqual(["index.html", "about.html"]);
    expect(after.pages.map((x) => [x.impact?.status, x.impact?.changed])).toEqual([
      ["changed", 2],
      ["changed", 1],
    ]);
    expect(after.pages[0].impact?.devices.map((d) => d.name)).toEqual(["desktop"]);
    expect(after.assessment).toMatchObject({ running: false, assessed: 2, pending: 0, changed: 2, maxChanged: 2 });

    // Nothing left to do: no new job.
    expect((await session.assess({ path: cssPath })).running).toBe(false);
  });

  it("puts pages that don't look different last, and forgets results on the next edit", async () => {
    await edit(original.replace("color: blue;", "color: green;"));
    const fresh = await session.getPages({ path: cssPath });
    expect(fresh.assessment).toMatchObject({ assessed: 0, pending: 2 });
    expect(fresh.pages.every((p) => !p.impact)).toBe(true);

    await assessAll();
    const after = await session.getPages({ path: cssPath });
    // index.html's button is .btn-primary: white either way.
    expect(after.pages.map((x) => [path.basename(x.url), x.impact?.status])).toEqual([
      ["about.html", "changed"],
      ["index.html", "unchanged"],
    ]);
    expect(after.assessment).toMatchObject({ assessed: 2, changed: 1, maxChanged: 1 });
  });

  it("stops when an edit makes it out of date", async () => {
    await edit(original.replace("color: darkred;", "color: blue;"));
    const done = finished();
    const started = await session.assess({ path: cssPath });
    expect(started.running).toBe(true);
    await edit(original.replace("color: darkred;", "color: purple;"));
    const end = await done;
    expect(end.running).toBe(false);
    const list = await session.getPages({ path: cssPath });
    expect(list.assessment.assessed).toBe(0);
  });
});
