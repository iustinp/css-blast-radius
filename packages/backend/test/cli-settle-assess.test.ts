// The `impact` and `assess` commands: CSS edited on disk (no open document), counted once L1
// has refined new selectors, then checked visually.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/index/store.js";
import { Capturer } from "../src/capture/capture.js";
import { Session } from "../src/daemon/session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSiteDir = path.resolve(__dirname, "../../../fixtures/site");

describe.skipIf(!!process.env.CBR_NO_BROWSER)("CLI: settled totals and assess", () => {
  let tempDir: string;
  let ws: string;
  let dataDir: string;
  let cssPath: string;
  let original: string;
  let session: Session | undefined;

  // A new selector: L0 can only say "possible" until L1 checks it on the stored trees.
  const NEW_RULE = "\ndiv.card > span.title {\n  color: green;\n}\n";
  // Applies to the same elements without changing how they look.
  const INVISIBLE_RULE = "\ndiv.card > span.title {\n  letter-spacing: normal;\n}\n";

  const sessionFor = async (css: string) => {
    fs.writeFileSync(cssPath, css);
    session = await Session.create({ workspaceRoot: ws, dataDir, watch: false, l1Workers: 0 });
    return session;
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-cli-"));
    ws = path.join(tempDir, "site");
    dataDir = path.join(tempDir, "data");
    fs.cpSync(fixtureSiteDir, ws, { recursive: true });
    execSync('git init -q -b main && git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -q -m A', { cwd: ws, stdio: "ignore", shell: "/bin/sh" });
    cssPath = path.join(ws, "css", "main.css");
    original = fs.readFileSync(cssPath, "utf8");
    const cfg = loadConfig(ws, { dataDir });
    const store = new Store(cfg.dataDir);
    await new Capturer(cfg, store).run({});
    store.close();
  }, 120_000);

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("waiting for L1 before asking for the total leaves a new selector possible", async () => {
    const s = await sessionFor(original + NEW_RULE);
    // What `impact` did: nothing is queued yet, so this returns at once.
    expect(await s.l1Idle(5_000)).toBe(true);
    expect(s.sessionTotal().total).toMatchObject({ exact: 0, possible: 2, complete: false });
  });

  it("settledTotal() asks first, then waits: the new selector is exact", async () => {
    const s = await sessionFor(original + NEW_RULE);
    const total = await s.settledTotal(30_000);
    expect(total.total).toEqual({ exact: 2, possible: 0, unknown: 0, complete: true });
    expect(total.files.map((f) => path.basename(f.file))).toEqual(["main.css"]);
  });

  it("assessAll() checks every reached page: a visible edit looks different", async () => {
    const s = await sessionFor(original + NEW_RULE);
    await s.settledTotal(30_000);
    const summary = await s.assessAll({});
    expect(summary).toMatchObject({ running: false, assessed: 2, pending: 0, changed: 2 });
    const { pages } = await s.getPages({ limit: 100 });
    expect(pages.map((p) => [path.basename(p.url), p.impact?.status])).toEqual([
      ["about.html", "changed"],
      ["index.html", "changed"],
    ]);
  }, 60_000);

  it("assessAll() puts an edit that changes nothing visible as no visual change", async () => {
    const s = await sessionFor(original + INVISIBLE_RULE);
    expect((await s.settledTotal(30_000)).total).toMatchObject({ exact: 2, complete: true });
    const summary = await s.assessAll({});
    expect(summary).toMatchObject({ running: false, assessed: 2, changed: 0 });
    const { pages } = await s.getPages({ limit: 100 });
    expect(pages.map((p) => p.impact?.status)).toEqual(["unchanged", "unchanged"]);
  }, 60_000);
});
