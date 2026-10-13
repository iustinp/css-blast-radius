// Workspace CSS file → the site's stylesheet(s) it becomes. An explicit
// `stylesheets` mapping wins; otherwise files are matched by name: hashes,
// version numbers and ".min" are ignored, and a tie is broken by the longest
// run of matching folder names. Remaining ties keep every candidate (better
// to over-report than to miss pages).

import { sep } from "node:path";
import { urlsForFile, type CbrConfig } from "../config.js";
import type { SiteIndex } from "../index/siteIndex.js";

const HASH = /^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}$/;
const VERSION = /^v?\d+$/;

/** "main.3f2a9c1b.chunk.min.css?v=2" → "main.css". */
export function normalizeSheetName(name: string): string {
  let n = name;
  const q = n.search(/[?#]/);
  if (q >= 0) n = n.slice(0, q);
  n = n.slice(Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\")) + 1);
  try {
    n = decodeURIComponent(n);
  } catch {
    /* keep */
  }
  n = n.toLowerCase();
  const ext = /\.[a-z0-9]+$/.exec(n)?.[0] ?? "";
  const stem = n.slice(0, n.length - ext.length);
  const parts = stem.split(/([.\-_~@])/);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const p = parts[i];
    const isFirst = i === 0;
    if (!isFirst && (HASH.test(p) || VERSION.test(p) || p === "min" || p === "chunk" || p === "bundle")) continue;
    kept.push(isFirst ? p : parts[i - 1] + p);
  }
  return (kept.join("") || stem) + ext;
}

function folders(path: string): string[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  parts.pop();
  return parts.map((p) => p.toLowerCase());
}

function sheetPath(key: string): string {
  try {
    return new URL(key).pathname;
  } catch {
    return key;
  }
}

function commonSuffix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

export class SheetMatcher {
  private readonly byName = new Map<string, string[]>();
  private readonly cache = new Map<string, string[]>();

  constructor(
    private readonly cfg: CbrConfig,
    private readonly index: SiteIndex | undefined,
  ) {
    for (const key of index?.sheets.keys() ?? []) {
      if (key.startsWith("inline:")) continue;
      const name = normalizeSheetName(sheetPath(key));
      let list = this.byName.get(name);
      if (!list) this.byName.set(name, (list = []));
      list.push(key);
    }
  }

  /** Index stylesheet keys the file is served as ([] = no match). */
  keysFor(file: string): string[] {
    const hit = this.cache.get(file);
    if (hit) return hit;
    const out = this.compute(file);
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(file, out);
    return out;
  }

  private compute(file: string): string[] {
    const explicit = urlsForFile(this.cfg, file);
    if (explicit.length) return [...new Set(explicit.map((u) => this.index?.sheetKey(u) ?? u))];
    const list = this.byName.get(normalizeSheetName(file));
    if (!list?.length) return [];
    if (list.length === 1) return [...list];
    const mine = folders(file.split(sep).join("/"));
    let best = -1;
    let out: string[] = [];
    for (const key of list) {
      const n = commonSuffix(mine, folders(sheetPath(key)));
      if (n > best) {
        best = n;
        out = [key];
      } else if (n === best) out.push(key);
    }
    return out;
  }
}
