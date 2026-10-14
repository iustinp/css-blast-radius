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
    expect(await g.branchPoint()).toEqual({ mainRef: "origin/main", mergeBase: forkSha, behind: 1, branch: "feature" });
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

    session = await Session.create({ workspaceRoot: ws, dataDir, watch: false, l1Workers: 0, diffBase: "production" });
  }, 120_000);

  afterAll(async () => {
    await session?.dispose();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("counts the branch's .btn change, not main's newer .card .title nor the already-live #hero", async () => {
    const total = session.sessionTotal();
    expect(total.branch).toEqual({ name: "feature", mainRef: "origin/main", behind: 1 });
    expect(total.files).toHaveLength(1);
    expect(total.files[0].changes).toBe(1);
    expect(total.total.exact).toBe(2);

    const res = await session.open(cssPath, fs.readFileSync(cssPath, "utf8"), 1);
    expect(res.answer.changes.map((c) => c.selector)).toEqual([".btn"]);
    expect(res.answer.freshness?.stale).toBe(false);
  });

  it("shows the edit on the live page with main's newer CSS kept", async () => {
    const url = session.index!.pages.find((p) => !/about|contact/.test(p.url))!.url;
    const view = await session.pageDiff({ url });
    expect(view.warnings.filter((w) => w.includes("also changed"))).toEqual([]);
    expect(view.status).toBe("changed");
    expect(view.zones.length).toBeGreaterThan(0);
    expect(view.zones.every((z) => z.label.includes("button.btn"))).toBe(true);
  }, 60_000);
});
