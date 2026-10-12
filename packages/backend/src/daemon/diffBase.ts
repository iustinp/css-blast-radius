// Diff bases (§7.2): what "my edits" are compared against.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
}

export class Git {
  /**
   * `top` is the repository root as the workspace spells it; git reports the
   * real path (macOS: /tmp → /private/tmp), so both are kept for mapping.
   */
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

  /** File text at HEAD; undefined when the file isn't in HEAD (new, or no commits). */
  async show(file: string): Promise<string | undefined> {
    const r = this.rel(file);
    if (!r) return undefined;
    try {
      const { stdout } = await run("git", ["show", `HEAD:${r}`], { cwd: this.top, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
      return stdout;
    } catch {
      return undefined;
    }
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
