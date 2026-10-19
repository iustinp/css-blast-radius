// Live-site base on a branch (§7.2): only the branch's own changes count,
// not newer commits of the deployed branch that the branch doesn't have yet.

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
import { Git } from "../src/daemon/diffBase.js";
import { browserModel } from "../src/css/model.js";
import { appliedFilter, diffModels } from "../src/css/diff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSiteDir = path.resolve(__dirname, "../../../fixtures/site");

const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
function initRepo(dir: string, branch = "main"): void {
  git(dir, `init -b ${branch}`);
  git(dir, 'config user.name "Branch Test"');
  git(dir, "config user.email test@example.com");
}
function commitAll(dir: string, msg: string): string {
  git(dir, "add -A");
  git(dir, `commit -q -m "${msg}"`);
  return git(dir, "rev-parse HEAD");
}

describe("appliedFilter: branch changes the site already has", () => {
  it("keeps only the changes that would still change the site", () => {
    const from = browserModel(".a { color: red; }\n.b { color: red; }\n.gone { color: red; }\n");
    const cur = browserModel(".a { color: blue; }\n.b { color: green; }\n.c { margin: 0; }\n");
    const live = browserModel(".a { color: blue; }\n.b { color: red; }\n.c { margin: 0; }\n");
    const changes = diffModels(from, cur, 3);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    const kept = appliedFilter(live)(changes, cur);
    expect(kept.map((c) => (c.after ?? c.before)?.selectorText)).toEqual([".b"]);
  });

  it("narrows an edit to what the site lacks, and drops it when the site has all of it", () => {
    const from = browserModel(":root {\n  --gap: 1px;\n}\n.a {\n  color: red;\n  margin: 0;\n}\n");
    const cur = browserModel(":root {\n  --gap: 1px;\n  --hero-max: 42px;\n  --stat: 78.8px;\n}\n.a {\n  color: red;\n  margin: 4px;\n}\n");
    // The site got --hero-max and margin another way (and its own newer color).
    const live = browserModel(":root {\n  --gap: 1px;\n  --hero-max: 42px;\n  --stat: 78.75px;\n}\n.a {\n  color: blue;\n  margin: 4px;\n}\n");
    const kept = appliedFilter(live)(diffModels(from, cur, 9), cur);
    expect(kept.map((c) => [c.after?.selectorText, c.changedProps])).toEqual([[":root", ["--stat"]]]);
    expect(kept[0].live?.selectorText).toBe(":root");
  });
});

describe("Git branch point", () => {
  let dir: string;
  let forkSha: string;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbr-branch-git-")));
    initRepo(dir);
    fs.mkdirSync(path.join(dir, "css"));
    fs.writeFileSync(path.join(dir, "css", "a.css"), ".a { color: red; }\n");
    fs.writeFileSync(path.join(dir, "css", "b.css"), ".b { color: red; }\n");
    forkSha = commitAll(dir, "A");
    git(dir, "branch feature");
    fs.writeFileSync(path.join(dir, "css", "b.css"), ".b { color: blue; }\n");
    const mainSha = commitAll(dir, "B on main");
    git(dir, "remote add origin https://example.invalid/repo.git");
    git(dir, `update-ref refs/remotes/origin/main ${mainSha}`);
    git(dir, "checkout -q feature");
    fs.writeFileSync(path.join(dir, "css", "a.css"), ".a { color: orange; }\n");
    commitAll(dir, "C on feature");
    fs.writeFileSync(path.join(dir, "css", "new.css"), ".n { color: red; }\n");
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("finds where the branch left origin/main and how far behind it is", async () => {
    const g = (await Git.find(dir))!;
    expect(await g.branchPoint()).toEqual({ mainRef: "origin/main", mergeBase: forkSha, behind: 1, branch: "feature", head: git(dir, "rev-parse HEAD") });
  });

  it("knows which versions of a file the branch's history has", async () => {
    const g = (await Git.find(dir))!;
    const head = git(dir, "rev-parse HEAD");
    const b = path.join(dir, "css", "b.css");
    expect(await g.committed(head, b, Buffer.from(".b { color: red; }\n"))).toBe(true);
    // Only main has it.
    expect(await g.committed(head, b, Buffer.from(".b { color: blue; }\n"))).toBe(false);
    expect(await g.committed(head, path.join(dir, "css", "a.css"), Buffer.from(".a { color: orange; }\n"))).toBe(true);
    expect(await g.committed(head, path.join(dir, "css", "new.css"), Buffer.from(".n { color: red; }\n"))).toBe(false);
  });

  it("prefers the remote's default branch when it is known", async () => {
    git(dir, "update-ref refs/remotes/origin/live HEAD");
    git(dir, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/live");
    try {
      expect(await (await Git.find(dir))!.mainRef()).toBe("origin/live");
    } finally {
      git(dir, "symbolic-ref --delete refs/remotes/origin/HEAD");
    }
  });

  it("lists only the files the branch changed (committed, uncommitted or new)", async () => {
    const g = (await Git.find(dir))!;
    const changed = (await g.changedSince(forkSha, [path.join(dir, "css")])).sort();
    expect(changed).toEqual([path.join(dir, "css", "a.css"), path.join(dir, "css", "new.css")]);
    expect(await g.show(path.join(dir, "css", "b.css"), forkSha)).toBe(".b { color: red; }\n");
  });

  it("merges the branch's changes into the site's copy as git would", async () => {
    const g = (await Git.find(dir))!;
    const from = ".a {\n  color: red;\n}\n\n.b {\n  color: blue;\n}\n\n.c {\n  color: green;\n}\n\n.d {\n  color: black;\n}\n";
    const live = from.replace("color: black", "color: gray") + "\n.e {\n  margin: 0;\n}\n";
    const cur = from.replace("color: red", "color: orange");
    expect(await g.mergeFile(live, from, cur)).toBe(live.replace("color: red", "color: orange"));
    // The same change on both sides (e.g. squash-merged): nothing is duplicated.
    expect(await g.mergeFile(cur, from, cur)).toBe(cur);
    // Both sides changed the same lines differently.
    expect(await g.mergeFile(from.replace("color: red", "color: purple"), from, cur)).toBeUndefined();
  });

  it("has no branch point without a deployed branch", async () => {
    const lone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbr-branch-lone-")));
    try {
      initRepo(lone, "work");
      fs.writeFileSync(path.join(lone, "x.css"), "x {}\n");
      commitAll(lone, "only");
      expect(await (await Git.find(lone))!.branchPoint()).toBeUndefined();
    } finally {
      fs.rmSync(lone, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!!process.env.CBR_NO_BROWSER)("Session: live-site base on a branch behind main", () => {
  let tempDir: string;
  let ws: string;
  let cssPath: string;
  let session: Session;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-branch-session-"));
    ws = path.join(tempDir, "site");
    const dataDir = path.join(tempDir, "data");
    fs.cpSync(fixtureSiteDir, ws, { recursive: true });
    cssPath = path.join(ws, "css", "main.css");
    initRepo(ws);
    commitAll(ws, "A");
    git(ws, "branch feature");
    // main moves on (and is what the site serves): .card .title changes there.
    const original = fs.readFileSync(cssPath, "utf8");
    const heroGreen = (t: string) => t.replace("color: darkred;", "color: green;");
    fs.writeFileSync(cssPath, heroGreen(original.replace("font-weight: bold;", "font-weight: 300;")));
    const mainSha = commitAll(ws, "B on main");
    git(ws, "remote add origin https://example.invalid/site.git");
    git(ws, `update-ref refs/remotes/origin/main ${mainSha}`);

    const cfg = loadConfig(ws, { dataDir });
    const store = new Store(cfg.dataDir);
    await new Capturer(cfg, store).run({});
    store.close();

    // The branch started before B: its #hero change already reached main (squash-merged), .btn is new.
    git(ws, "checkout -q feature");
    fs.writeFileSync(cssPath, heroGreen(original.replace("padding: 8px 16px;", "padding: 8px 16px;\n  border: 3px solid red;")));
    commitAll(ws, "C on feature");

    session = await Session.create({ workspaceRoot: ws, dataDir, watch: false, l1Workers: 0 });
  }, 120_000);

  afterAll(async () => {
    await session?.dispose();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("counts the branch's .btn change, not main's newer .card .title nor the already-live #hero", async () => {
    const total = session.sessionTotal();
    expect(total.branch).toEqual({ name: "feature", mainRef: "origin/main", behind: 1, mainShown: false });
    expect(total.files).toHaveLength(1);
    expect(total.files[0].changes).toBe(1);
    expect(total.total.exact).toBe(2);

    const res = await session.open(cssPath, fs.readFileSync(cssPath, "utf8"), 1);
    expect(res.answer.changes.map((c) => c.selector)).toEqual([".btn"]);
    expect(res.answer.freshness?.stale).toBe(false);
  });

  it("can also count main's newer changes (a plain comparison with the site), and stop again", async () => {
    let total = await session.setTab("all", true);
    expect(total.branch).toEqual({ name: "feature", mainRef: "origin/main", behind: 1, mainShown: true });
    const res = await session.open(cssPath, fs.readFileSync(cssPath, "utf8"), 2);
    expect(res.answer.changes.map((c) => c.selector).sort()).toEqual([".btn", ".card .title"]);
    total = await session.setTab("all", false);
    expect(total.branch?.mainShown).toBe(false);
    expect(total.files[0].changes).toBe(1);
  });

  it("Committed counts the branch's commits; Uncommitted adds saved edits, not unsaved typing", async () => {
    const committed = fs.readFileSync(cssPath, "utf8");
    const saved = `/* saved */\n${committed.replace("#hero {", "#hero {\n  outline: 1px solid blue;")}`;
    const typed = saved.replace(".btn.btn-primary {", ".btn.btn-primary {\n  margin: 2px;");
    const selectors = () => session.fileAnswer(cssPath).changes.map((c) => c.selector).sort();
    await session.close(cssPath);
    fs.writeFileSync(cssPath, saved);
    try {
      let total = await session.setTab("committed");
      expect(total.tab).toBe("committed");
      expect(total.branch).toMatchObject({ name: "feature", behind: 1 });
      expect(total.files.map((f) => [f.open, f.changes])).toEqual([[false, 1]]);
      // Closed, its HEAD lines aren't the file's on disk (a comment added above): jumping opens the file on disk.
      const lineOf = (t: string) => t.split("\n").findIndex((l) => l.includes("border: 3px solid red")) + 1;
      expect(lineOf(saved)).toBe(lineOf(committed) + 1);
      expect(session.changeDetail(cssPath, session.fileAnswer(cssPath).changes[0].id).line).toBe(lineOf(saved));
      const res = await session.open(cssPath, typed, 10);
      expect(res.answer.changes.map((c) => c.selector)).toEqual([".btn"]);
      expect(res.answer.matchesEditor).toBe(false);

      await session.setTab("uncommitted");
      expect(selectors()).toEqual(["#hero", ".btn"]);
      // The saved version's #hero is a line higher than the editor's (typing above it): jumping lands in the editor's.
      const hero = session.fileAnswer(cssPath).changes.find((c) => c.selector === "#hero")!;
      const heroLine = typed.split("\n").findIndex((l) => l.startsWith("#hero {")) + 1;
      expect(session.changeDetail(cssPath, hero.id).rule).toMatchObject({ line: heroLine });
      expect(session.changeDetail(cssPath, hero.id).line).toBe(heroLine + 1);
      await session.setTab("all");
      expect(selectors()).toEqual(["#hero", ".btn", ".btn.btn-primary"]);

      await session.setTab("uncommitted");
      const after = await session.save(cssPath, typed);
      expect(after.answer.changes.map((c) => c.selector).sort()).toEqual(["#hero", ".btn", ".btn.btn-primary"]);
      expect(after.answer.matchesEditor).toBeUndefined();

      git(ws, "checkout -q -b feature-tabs");
      fs.writeFileSync(cssPath, typed);
      commitAll(ws, "D on feature-tabs");
      await session.setTab("committed");
      expect(selectors()).toEqual(["#hero", ".btn", ".btn.btn-primary"]);
    } finally {
      git(ws, "checkout -q -f feature");
      git(ws, "branch -q -D feature-tabs 2>/dev/null || true");
      await session.open(cssPath, committed, 11);
      await session.setTab("all");
    }
  });

  it("shows the edit on the live page with main's newer CSS kept", async () => {
    const url = session.index!.pages.find((p) => !/about|contact/.test(p.url))!.url;
    const view = await session.pageDiff({ url });
    expect(view.warnings.filter((w) => w.includes("also changed"))).toEqual([]);
    expect(view.status).toBe("changed");
    expect(view.zones.length).toBeGreaterThan(0);
    expect(view.zones.every((z) => z.label.includes("button.btn"))).toBe(true);
  }, 60_000);

  it("lists the edits the live site doesn't have, with their lines, whatever the tab", async () => {
    const text = fs.readFileSync(cssPath, "utf8");
    const lineOf = (t: string, s: string) => t.split("\n").findIndex((l) => l.includes(s)) + 1;
    await session.setTab("uncommitted");
    expect(session.sessionTotal().files.map((f) => f.changes)).toEqual([1]);

    let live = await session.liveEdits();
    expect(live.branch?.name).toBe("feature");
    expect(live.files.map((f) => f.file)).toEqual([path.resolve(cssPath)]);
    expect(live.files[0].edits.map((e) => [e.selector, e.ranges])).toEqual([[".btn", [[lineOf(text, "border: 3px solid red"), lineOf(text, "border: 3px solid red")]]]]);
    expect(live.files[0].pages.exact).toBe(2);

    // The change bars' original: the live site's CSS, with the already-live #hero change kept.
    expect((await session.liveOriginal(cssPath)).text).toBe(text.replace("\n  border: 3px solid red;", ""));
    expect((await session.liveOriginal(path.join(ws, "css", "nope.css"))).text).toBeNull();

    // Unsaved typing counts too; the tab's own list is untouched.
    const typed = text.replace("#hero {", "#hero {\n  outline: 1px solid blue;");
    expect((await session.open(cssPath, typed, 3)).answer.matchesEditor).toBe(false);
    live = await session.liveEdits();
    expect(live.files[0].edits.map((e) => e.selector).sort()).toEqual(["#hero", ".btn"]);
    const hero = live.files[0].edits.find((e) => e.selector === "#hero")!;
    expect(hero.ranges).toEqual([[lineOf(typed, "outline: 1px"), lineOf(typed, "outline: 1px")]]);
    expect(session.sessionTotal().files.map((f) => f.changes)).toEqual([1]);

    // Main changed .card .title's font-weight since the branch began: only the line typed here is marked, not the older weight.
    const title = typed.replace("font-weight: bold;", "font-weight: bold;\n  letter-spacing: 1px;");
    await session.open(cssPath, title, 4);
    live = await session.liveEdits();
    expect(live.files[0].edits.find((e) => e.selector === ".card .title")!.ranges).toEqual([[lineOf(title, "letter-spacing"), lineOf(title, "letter-spacing")]]);

    // Typing main's own value too (already live) plus a new one: the All tab, its card and the highlight show only the new one.
    await session.setTab("all");
    const both = typed.replace("font-weight: bold;", "font-weight: 300;\n  letter-spacing: 1px;");
    const res = await session.open(cssPath, both, 5);
    const ch = res.answer.changes.find((c) => c.selector === ".card .title")!;
    expect(ch.changedProps).toEqual(["letter-spacing"]);
    expect(session.changeDetail(cssPath, ch.id).rule!.decls.map((d) => `${d.state} ${d.text}`)).toEqual(["same font-weight: 300", "changed letter-spacing: 1px"]);
    live = await session.liveEdits();
    expect(live.files[0].edits.find((e) => e.selector === ".card .title")!.ranges).toEqual([[lineOf(both, "letter-spacing"), lineOf(both, "letter-spacing")]]);
    await session.setTab("uncommitted");
    await session.open(cssPath, typed, 6);

    // Closed: the file on disk.
    await session.close(cssPath);
    live = await session.liveEdits();
    expect(live.files.map((f) => [f.open, f.edits.map((e) => e.selector)])).toEqual([[false, [".btn"]]]);
    await session.setTab("all");
    expect((await session.liveEdits()).files.map((f) => f.edits.length)).toEqual([1]);
  });

  it("on main itself, or a branch started after the scan, commits made since the scan count", async () => {
    git(ws, "checkout -q main");
    const scanned = fs.readFileSync(cssPath, "utf8");
    fs.writeFileSync(cssPath, scanned.replace("font-weight: 300;", "font-weight: 500;"));
    commitAll(ws, "D on main, after the scan");
    git(ws, "update-ref refs/remotes/origin/main HEAD");
    let total = await session.setTab("all");
    expect(total.branch).toMatchObject({ name: "main", behind: 0 });
    expect(total.files.map((f) => f.changes)).toEqual([1]);
    expect((await session.liveEdits()).files[0].edits.map((e) => e.selector)).toEqual([".card .title"]);

    git(ws, "checkout -q -b later");
    fs.writeFileSync(cssPath, fs.readFileSync(cssPath, "utf8").replace("#hero {", "#hero {\n  outline: 1px solid blue;"));
    total = await session.setTab("all");
    expect(total.branch).toMatchObject({ name: "later", behind: 0 });
    const res = await session.open(cssPath, fs.readFileSync(cssPath, "utf8"), 7);
    expect(res.answer.changes.map((c) => c.selector).sort()).toEqual(["#hero", ".card .title"]);
    await session.close(cssPath);
  });
});
