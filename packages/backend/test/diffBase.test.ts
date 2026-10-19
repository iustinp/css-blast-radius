import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Git, blobId, readText } from "../src/daemon/diffBase.js";

const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("Git diff base in temp repository (§7.2)", () => {
  let tempDir: string;
  let symlinkedDir: string;
  let realDir: string;
  let git: Git;

  beforeAll(() => {
    // Create a temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-git-test-"));
    realDir = fs.realpathSync(tempDir);

    // On macOS, os.tmpdir() returns /var/folders/..., where /var is a symlink to /private/var.
    // If realDir is different from tempDir, tempDir has the symlinked spelling.
    // If not, we explicitly create a symlink to test symlinked paths.
    if (realDir === tempDir) {
      symlinkedDir = path.join(tempDir, "symlink-target");
      const linkPath = path.join(tempDir, "symlink-alias");
      fs.mkdirSync(symlinkedDir);
      fs.symlinkSync(symlinkedDir, linkPath, "dir");
    } else {
      symlinkedDir = tempDir; // starts with /var/...
    }

    // Initialize git repo in realDir
    execSync("git init -b main", { cwd: realDir, stdio: "ignore" });
    execSync('git config user.name "Test Runner"', { cwd: realDir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: realDir, stdio: "ignore" });

    // Create stylesheet structure
    fs.mkdirSync(path.join(realDir, "src", "css"), { recursive: true });
    fs.writeFileSync(path.join(realDir, "src", "css", "base.css"), "body { margin: 0; }\n");
    fs.writeFileSync(path.join(realDir, "src", "css", "theme.css"), ":root { --color: blue; }\n");
    fs.writeFileSync(path.join(realDir, "src", "css", "todelete.css"), ".gone { display: none; }\n");
    fs.writeFileSync(path.join(realDir, "src", "css", "torename.css"), ".rename { float: left; }\n");
    fs.writeFileSync(path.join(realDir, "README.md"), "# Test\n");

    // Commit baseline
    execSync("git add .", { cwd: realDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: realDir, stdio: "ignore" });
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("finds the repository from the root or a nested directory", async () => {
    const found = await Git.find(realDir);
    expect(found).toBeDefined();
    git = found!;

    const nested = await Git.find(path.join(realDir, "src", "css"));
    expect(nested).toBeDefined();

    const notRepo = await Git.find(path.parse(realDir).root);
    expect(notRepo).toBeUndefined();
  });

  it("maps rel() using both real spelling and symlinked spelling", () => {
    const fileReal = path.join(realDir, "src", "css", "base.css");
    expect(git.rel(fileReal)).toBe("src/css/base.css");

    // If symlinkedDir differs from realDir (e.g. /var/... vs /private/var/... on macOS)
    if (symlinkedDir !== realDir) {
      const fileSym = path.join(symlinkedDir, "src", "css", "base.css");
      expect(git.rel(fileSym)).toBe("src/css/base.css");
    }

    // Outside the repo returns undefined
    expect(git.rel("/outside/path.css")).toBeUndefined();
  });

  it("shows file text at HEAD using show()", async () => {
    const baseCss = path.join(realDir, "src", "css", "base.css");
    const content = await git.show(baseCss);
    expect(content).toBe("body { margin: 0; }\n");

    // Symlinked spelling
    if (symlinkedDir !== realDir) {
      const symContent = await git.show(path.join(symlinkedDir, "src", "css", "base.css"));
      expect(symContent).toBe("body { margin: 0; }\n");
    }

    // File not in git returns undefined
    expect(await git.show(path.join(realDir, "nonexistent.css"))).toBeUndefined();
  });

  it("maps deleted files with rel() and show() even after removal from disk", async () => {
    const delFile = path.join(realDir, "src", "css", "todelete.css");
    expect(fs.existsSync(delFile)).toBe(true);

    // Delete the file from disk
    fs.unlinkSync(delFile);
    expect(fs.existsSync(delFile)).toBe(false);

    // rel() should still map the deleted file
    expect(git.rel(delFile)).toBe("src/css/todelete.css");

    // show() should still return the HEAD content of the deleted file
    const content = await git.show(delFile);
    expect(content).toBe(".gone { display: none; }\n");
  });

  it("lists HEAD's CSS with blob ids, and the CSS changed between two commits", async () => {
    const css = (f: string) => path.resolve(realDir, "src", "css", f);
    const dirs = [path.join(realDir, "src", "css")];
    const first = execSync("git rev-parse HEAD", { cwd: realDir, encoding: "utf8" }).trim();

    // Working-tree edits (and non-CSS files) don't count: HEAD only.
    fs.writeFileSync(css("base.css"), "body { margin: 10px; }\n");
    fs.writeFileSync(path.join(realDir, "README.md"), "# Changed\n");
    let head = await git.headCss(dirs);
    expect([...head.keys()].sort()).toEqual(["base.css", "theme.css", "todelete.css", "torename.css"].map(css));
    expect(head.get(css("base.css"))).toBe(blobId(Buffer.from("body { margin: 0; }\n")));

    // Committed: base.css modified, todelete.css deleted (earlier), torename.css renamed.
    execSync("git mv src/css/torename.css src/css/renamed.css", { cwd: realDir, stdio: "ignore" });
    execSync('git add -A && git commit -q -m "second"', { cwd: realDir, stdio: "ignore" });
    head = await git.headCss(dirs);
    expect([...head.keys()].sort()).toEqual(["base.css", "renamed.css", "theme.css"].map(css));
    expect(head.get(css("base.css"))).toBe(blobId(Buffer.from("body { margin: 10px; }\n")));
    expect((await git.changedBetween(first, "HEAD", dirs)).sort()).toEqual(["base.css", "renamed.css", "todelete.css", "torename.css"].map(css));
    expect(await git.changedBetween("HEAD", "HEAD", dirs)).toEqual([]);
  });

  it("readText utility reads existing file or returns undefined", () => {
    const baseCss = path.join(realDir, "src", "css", "base.css");
    expect(readText(baseCss)).toBe("body { margin: 10px; }\n");
    expect(readText(path.join(realDir, "nonexistent.css"))).toBeUndefined();
  });
});
