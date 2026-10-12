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
import { ERR, RpcError } from "../src/rpc/protocol.js";
import { ResyncNeeded } from "../src/daemon/documents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSiteDir = path.resolve(__dirname, "../../../fixtures/site");

const skipBrowser = !!process.env.CBR_NO_BROWSER;

describe.skipIf(skipBrowser)("Session integration on fixture site", () => {
  let tempDir: string;
  let ws: string;
  let dataDir: string;
  let mainCssPath: string;
  let originalCssText: string;
  let session: Session;
  let docVersion = 1;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-session-test-"));
    ws = path.join(tempDir, "site");
    dataDir = path.join(tempDir, "data");

    // Copy fixture site
    fs.cpSync(fixtureSiteDir, ws, { recursive: true });

    // Initialize git repo and commit
    execSync("git init -b main", { cwd: ws, stdio: "ignore" });
    execSync('git config user.name "Session Test"', { cwd: ws, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: ws, stdio: "ignore" });
    execSync("git add .", { cwd: ws, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: ws, stdio: "ignore" });

    mainCssPath = path.join(ws, "css", "main.css");
    originalCssText = fs.readFileSync(mainCssPath, "utf8");

    // Run real capture
    const cfg = loadConfig(ws, { dataDir });
    const store = new Store(cfg.dataDir);
    const capturer = new Capturer(cfg, store);
    await capturer.run({});
    store.close();

    // Create session (in-process L1 workers: l1Workers: 0, watch: false)
    session = await Session.create({
      workspaceRoot: ws,
      dataDir,
      watch: false,
      l1Workers: 0,
    });
  }, 120_000);

  afterAll(async () => {
    if (session) {
      await session.dispose();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // a. Open unchanged file
  it("a. open unchanged file -> total 0/0/0 with totalReasons non-empty (zero-invariant)", async () => {
    const res = await session.open(mainCssPath, originalCssText, docVersion);
    expect(res.answer.total).toEqual({
      exact: 0,
      possible: 0,
      unknown: 0,
      complete: true,
    });
    expect(res.answer.totalReasons.length).toBeGreaterThan(0);
    expect(res.answer.totalReasons).toContain("no-effective-change");
    expect(res.answer.changes).toHaveLength(0);
  });

  // b. Declaration edit on a class used by N pages
  it("b. declaration edit on a class used by N pages -> total.exact === N, complete === true", async () => {
    // .btn is in index.html and about.html (2 pages), but not in contact.html
    const edited = originalCssText.replace(
      ".btn {\n  color: blue;\n  padding: 8px 16px;\n}",
      ".btn {\n  color: blue;\n  padding: 24px 48px;\n}",
    );
    docVersion++;
    const res = await session.change(mainCssPath, docVersion, [{ text: edited }]);

    expect(res.answer.total.exact).toBe(2);
    expect(res.answer.total.possible).toBe(0);
    expect(res.answer.total.complete).toBe(true);

    const declChange = res.answer.changes.find((c) => c.kind === "declarations");
    expect(declChange).toBeDefined();
    expect(declChange!.selector).toBe(".btn");
    expect(declChange!.pages.exact).toBe(2);
    expect(declChange!.pages.complete).toBe(true);
  });

  // c. Selector rename
  it("c. selector rename -> change kind 'selector', lost equals pages that had old selector", async () => {
    // Rename .btn to .btn-renamed
    const edited = originalCssText.replace(".btn {\n  color: blue;", ".btn-renamed {\n  color: blue;");
    docVersion++;
    const res = await session.change(mainCssPath, docVersion, [{ text: edited }]);

    const selChange = res.answer.changes.find((c) => c.kind === "selector");
    expect(selChange).toBeDefined();
    expect(selChange!.oldSelector).toBe(".btn");
    expect(selChange!.selector).toBe(".btn-renamed");

    // Old selector .btn matched 2 pages (index.html, about.html), so lost count should be 2
    expect(selChange!.lost).toBeDefined();
    expect(selChange!.lost!.exact).toBe(2);
  });

  // d. Brand-new complex selector
  it("d. brand-new complex selector -> resolves to exact true matches after l1Idle", async () => {
    // div.card > span.title is in index.html and about.html (2 pages)
    const edited = originalCssText + "\ndiv.card > span.title {\n  font-size: 20px;\n}\n";
    docVersion++;
    await session.change(mainCssPath, docVersion, [{ text: edited }]);

    // Wait for L1 to finish resolving the complex selector
    const idle = await session.l1Idle(10_000);
    expect(idle).toBe(true);

    const ans = session.fileAnswer(mainCssPath);
    expect(ans.total.possible).toBe(0);
    expect(ans.total.complete).toBe(true);
    expect(ans.total.exact).toBe(2);
  });

  // e. ZERO INVARIANT: ~15 varied edits with zero count must carry reasons
  it("e. zero invariant: every count of 0/0/0 carries at least one reason code", async () => {
    const edits: Array<{ label: string; text: string }> = [
      { label: "empty text (all rules removed)", text: "" },
      { label: "whitespace/comment only", text: originalCssText + "/* a harmless comment */\n" },
      { label: "adding unused class selector", text: originalCssText + "\n.completely-unused-class-xyz { color: red; }\n" },
      { label: "editing unused selector declaration", text: originalCssText + "\n.unused-1 { color: red; }\n" },
      { label: "unused nested selector", text: originalCssText + "\n.unused-parent .unused-child { margin: 0; }\n" },
      { label: "editing @media with unused class", text: originalCssText + "\n@media (max-width: 300px) { .unused-mobile { color: pink; } }\n" },
      { label: "unused @keyframes definition", text: originalCssText + "\n@keyframes unusedPulse { from { opacity: 0; } to { opacity: 1; } }\n" },
      { label: "unused custom property definition", text: originalCssText + "\n:root { --unused-custom-prop: 10px; }\n" },
      { label: "unused @supports rule", text: originalCssText + "\n@supports (display: subgrid) { .unused-subgrid { display: subgrid; } }\n" },
      { label: "unused @container rule", text: originalCssText + "\n@container (min-width: 100px) { .unused-box { width: 100%; } }\n" },
      { label: "unused @counter-style definition", text: originalCssText + "\n@counter-style unused-c { system: cyclic; symbols: 'A'; }\n" },
      { label: "unused @font-face definition", text: originalCssText + '\n@font-face { font-family: "UnusedFont"; src: local("Arial"); }\n' },
      { label: "empty rule block", text: originalCssText + "\n.empty-rule { }\n" },
      { label: "invalid selector while typing", text: originalCssText + "\n.broken-typing > > { color: red; }\n" },
      { label: "parse error while typing", text: originalCssText + "\n.broken { color: red; } }\n" },
    ];

    for (const { label, text } of edits) {
      docVersion++;
      const res = await session.change(mainCssPath, docVersion, [{ text }]);
      const ans = res.answer;

      // Invariant on FileAnswer.total
      const totalCount = ans.total.exact + ans.total.possible + ans.total.unknown;
      if (totalCount === 0) {
        expect(
          ans.totalReasons.length,
          `Edit "${label}" produced total 0 without any totalReasons`,
        ).toBeGreaterThan(0);
      }

      // Invariant on each ChangeAnswer
      for (const change of ans.changes) {
        const changeCount = change.pages.exact + change.pages.possible + change.pages.unknown;
        if (changeCount === 0) {
          expect(
            change.reasons.length,
            `Edit "${label}" change ${change.kind}:${change.selector} produced 0 pages without reasons`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  // f. Never-mix: editRevision strictly increases; stale editRevision rejected with -32002
  it("f. never-mix: editRevision strictly increases, stale getPages rejects with -32002", async () => {
    // Reset to original
    docVersion++;
    const res1 = await session.change(mainCssPath, docVersion, [{ text: originalCssText }]);
    const rev1 = res1.answer.editRevision;

    docVersion++;
    const res2 = await session.change(mainCssPath, docVersion, [
      { text: originalCssText.replace(".btn {", ".btn {\n  outline: 1px solid green;") },
    ]);
    const rev2 = res2.answer.editRevision;
    expect(rev2).toBeGreaterThan(rev1);

    // Calling getPages with the stale revision rev1 should throw RpcError with code ERR.superseded (-32002)
    try {
      await session.getPages({
        path: mainCssPath,
        editRevision: rev1,
      });
      expect.fail("Should have rejected stale editRevision");
    } catch (err: any) {
      expect(err).toBeInstanceOf(RpcError);
      expect(err.code).toBe(ERR.superseded); // -32002
    }
  });

  // g. Resync: ranged change with version gap rejects with -32001
  it("g. resync: ranged change with version gap rejects with -32001", async () => {
    const currentVersion = docVersion;
    const gapVersion = currentVersion + 5; // skipped versions

    try {
      await session.change(mainCssPath, gapVersion, [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          text: ".btn-gap",
        },
      ]);
      expect.fail("Should have rejected version gap");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ResyncNeeded);
      expect(err.code).toBe(-32001);
    }
  });

  // h. getPages pagination and set filter
  it("h. getPages pagination and set filter consistency with counts", async () => {
    // Edit .btn (matches 2 pages: index.html and about.html)
    docVersion++;
    await session.change(mainCssPath, docVersion, [
      { text: originalCssText.replace(".btn {", ".btn {\n  color: cyan;") },
    ]);
    await session.l1Idle(5_000);

    const allPages = await session.getPages({ path: mainCssPath, set: "all" });
    expect(allPages.count.exact).toBe(2);
    expect(allPages.total).toBe(2);
    expect(allPages.pages).toHaveLength(2);

    // Pagination: limit 1, offset 0
    const page1 = await session.getPages({ path: mainCssPath, limit: 1, offset: 0 });
    expect(page1.total).toBe(2);
    expect(page1.pages).toHaveLength(1);
    expect(page1.offset).toBe(0);

    // Pagination: limit 1, offset 1
    const page2 = await session.getPages({ path: mainCssPath, limit: 1, offset: 1 });
    expect(page2.total).toBe(2);
    expect(page2.pages).toHaveLength(1);
    expect(page2.offset).toBe(1);
    expect(page2.pages[0].url).not.toBe(page1.pages[0].url);

    // Filter by set "exact" vs "possible"
    const exactPages = await session.getPages({ path: mainCssPath, set: "exact" });
    expect(exactPages.pages).toHaveLength(2);
    expect(exactPages.pages.every((p) => p.set === "exact")).toBe(true);

    const possiblePages = await session.getPages({ path: mainCssPath, set: "possible" });
    expect(possiblePages.pages).toHaveLength(0);
  });

  // i. diff bases: setDiffBase("saved") vs "HEAD" vs "session"
  it("i. diff bases: setDiffBase('saved') vs 'HEAD' vs 'session' on closed modified file", async () => {
    // Close main.css so it becomes a closed file
    await session.close(mainCssPath);

    // Modify main.css on disk directly
    const modifiedDiskText = originalCssText + "\n.closed-disk-edit { color: orange; }\n";
    fs.writeFileSync(mainCssPath, modifiedDiskText);

    // In HEAD diff base, disk modification shows as a changed file
    const headTotal = await session.setDiffBase("HEAD");
    const headFile = headTotal.files.find((f) => path.resolve(f.file) === path.resolve(mainCssPath));
    expect(headFile).toBeDefined();
    expect(headFile!.changes).toBeGreaterThan(0);

    // In saved diff base, closed file compares against itself on disk, so 0 changes
    const savedTotal = await session.setDiffBase("saved");
    const savedFile = savedTotal.files.find((f) => path.resolve(f.file) === path.resolve(mainCssPath));
    expect(savedFile).toBeUndefined();

    // Restore disk file and test session diff base
    fs.writeFileSync(mainCssPath, originalCssText);
    await session.setDiffBase("session");
  });
});
