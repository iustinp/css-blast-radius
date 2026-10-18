// Diff bases (§7.2): what "my edits" are compared against.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type DiffBaseKind = "HEAD" | "saved" | "session" | "production";
export const DIFF_BASES: DiffBaseKind[] = ["HEAD", "saved", "session", "production"];

export interface BaseText {
  /** undefined: the file doesn't exist in the base (everything is added). */
  text: string | undefined;
  /** Base actually used, when the requested one isn't available for this file. */
  kind: DiffBaseKind;
  note?: string;
  /**
   * Production base on a branch: the site's captured copy, while `text` is
   * the file where the branch left the deployed branch (so only the branch's
   * own changes are diffed; the visual diff merges them into this copy).
   */
  live?: string;
}

/** Where the checked-out branch left the branch the site is deployed from. */
export interface BranchPoint {
  /** Remote-tracking ref of the deployed branch, e.g. origin/main. */
  mainRef: string;
  mergeBase: string;
  /** Commits on the deployed branch that the checked-out branch doesn't have. */
  behind: number;
  /** Checked-out branch; null when detached. */
  branch: string | null;
  /** The checked-out commit. */
  head: string;
}

/** git's id for a file's content. */
export function blobId(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

export class Git {
  /**
   * `top` is the repository root as the workspace spells it; git reports the
   * real path (macOS: /tmp → /private/tmp), so both are kept for mapping.
   */
  private versions?: { head: string; load: Promise<Set<string>> };

  private constructor(
    readonly top: string,
    private readonly realTop: string,
  ) {}

  static async find(dir: string): Promise<Git | undefined> {
    try {
      const { stdout } = await run("git", ["rev-parse", "--show-toplevel", "--show-cdup"], { cwd: dir });
      const [real, cdup = ""] = stdout.split("\n").map((l) => l.trim());
      return new Git(resolve(dir, cdup || "."), resolve(real));
    } catch {
      return undefined;
    }
  }

  rel(file: string): string | undefined {
    const inside = (top: string, f: string) => {
      const r = relative(top, f);
      return r.startsWith("..") || isAbsolute(r) ? undefined : r.split(sep).join("/");
    };
    const abs = resolve(file);
    return inside(this.top, abs) ?? inside(this.realTop, realExisting(abs));
  }

  /** File text at `rev` (default HEAD); undefined when the file isn't there (new, or no commits). */
  async show(file: string, rev = "HEAD"): Promise<string | undefined> {
    const r = this.rel(file);
    if (!r) return undefined;
    try {
      const { stdout } = await run("git", ["show", `${rev}:${r}`], { cwd: this.top, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
      return stdout;
    } catch {
      return undefined;
    }
  }

  private async git(args: string[]): Promise<string | undefined> {
    try {
      return (await run("git", args, { cwd: this.top, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" })).stdout.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * The branch the site is deployed from: the default branch of `origin` (or
   * the first remote), else its main/master, else a local main/master.
   */
  async mainRef(): Promise<string | undefined> {
    const remotes = ((await this.git(["remote"])) ?? "").split("\n").map((r) => r.trim()).filter(Boolean);
    remotes.sort((a, b) => Number(b === "origin") - Number(a === "origin"));
    for (const r of remotes) {
      const head = await this.git(["symbolic-ref", "-q", "--short", `refs/remotes/${r}/HEAD`]);
      if (head) return head;
      for (const b of ["main", "master"]) if ((await this.git(["rev-parse", "--verify", "-q", `refs/remotes/${r}/${b}`])) !== undefined) return `${r}/${b}`;
    }
    for (const b of ["main", "master"]) if ((await this.git(["rev-parse", "--verify", "-q", `refs/heads/${b}`])) !== undefined) return b;
    return undefined;
  }

  /** Where HEAD left the deployed branch; undefined without one (or without shared history). */
  async branchPoint(): Promise<BranchPoint | undefined> {
    const mainRef = await this.mainRef();
    if (!mainRef) return undefined;
    const [mergeBase, behind, name, head] = await Promise.all([
      this.git(["merge-base", "HEAD", mainRef]),
      this.git(["rev-list", "--count", `HEAD..${mainRef}`]),
      this.git(["rev-parse", "--abbrev-ref", "HEAD"]),
      this.git(["rev-parse", "HEAD"]),
    ]);
    if (!mergeBase || !head) return undefined;
    return { mainRef, mergeBase, behind: Number(behind) || 0, branch: name && name !== "HEAD" ? name : null, head };
  }

  /** Whether `content` was ever committed as `file` in `head`'s history (merges included). */
  async committed(head: string, file: string, content: Buffer): Promise<boolean> {
    const r = this.rel(file);
    if (!r) return false;
    if (this.versions?.head !== head) this.versions = { head, load: this.cssVersions(head) };
    return (await this.versions.load).has(`${r}\0${blobId(content)}`);
  }

  /** Every version of every CSS file in `head`'s history, as `path\0blob id`. */
  private async cssVersions(head: string): Promise<Set<string>> {
    const out = await this.git(["log", "--raw", "--no-abbrev", "--no-renames", "--root", "-m", "-z", "--format=", head, "--", "*.css"]);
    const seen = new Set<string>();
    const parts = (out ?? "").split("\0");
    for (let i = 0; i < parts.length - 1; i++) {
      const meta = parts[i].trim();
      if (!meta.startsWith(":")) continue;
      seen.add(`${parts[++i]}\0${meta.split(" ")[3]}`);
    }
    return seen;
  }

  /**
   * Three-way merge of `other`'s changes since `base` into `current`, as git
   * would merge them (identical changes on both sides merge cleanly).
   * Undefined when they conflict or git fails.
   */
  async mergeFile(current: string, base: string, other: string): Promise<string | undefined> {
    const dir = mkdtempSync(join(tmpdir(), "cbr-merge-"));
    try {
      const files = ["current", "base", "other"].map((n) => join(dir, n));
      [current, base, other].forEach((t, i) => writeFileSync(files[i], t));
      const { stdout } = await run("git", ["merge-file", "-p", "-q", ...files], { cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
      return stdout;
    } catch {
      return undefined; // exit code = number of conflicts
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** CSS files under `dirs` whose working-tree content differs from `rev` (including untracked). */
  async changedSince(rev: string, dirs: string[]): Promise<string[]> {
    const specs = dirs.map((d) => this.rel(d)).filter((d): d is string => d !== undefined).map((d) => d || ".");
    if (specs.length === 0) return [];
    const [diff, untracked] = await Promise.all([
      this.git(["diff", "--name-only", "-z", "--no-renames", rev, "--", ...specs]),
      this.git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs]),
    ]);
    if (diff === undefined) return [];
    const out = new Set<string>();
    for (const r of [...diff.split("\0"), ...(untracked ?? "").split("\0")]) if (r.endsWith(".css")) out.add(resolve(this.top, r));
    return [...out];
  }

  /** CSS files under `dirs` that differ from HEAD (modified, added, deleted, untracked). */
  async changedCss(dirs: string[]): Promise<string[]> {
    const specs = dirs.map((d) => this.rel(d)).filter((d): d is string => d !== undefined);
    if (specs.length === 0) return [];
    try {
      const { stdout } = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...specs.map((d) => d || ".")], {
        cwd: this.top,
        maxBuffer: 64 * 1024 * 1024,
      });
      const out: string[] = [];
      const parts = stdout.split("\0");
      for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        if (e.length < 4) continue;
        const status = e.slice(0, 2);
        out.push(resolve(this.top, e.slice(3)));
        if (status[0] === "R" || status[0] === "C") i++; // the next entry is the original path
      }
      return out.filter((f) => f.endsWith(".css"));
    } catch {
      return [];
    }
  }
}

/** realpath of the longest existing prefix of `p` (the file itself may be deleted). */
function realExisting(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p;
    tail.unshift(basename(head));
    head = parent;
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return p;
  }
}

export function readText(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}
