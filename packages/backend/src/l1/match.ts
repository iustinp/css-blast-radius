// L1 matching core (§6.4): resolves selectors against stored compact trees.
// Runs inside worker threads (worker.ts) or in-process for tests and tiny
// sites. A page matches when any element matches in any captured variant.

import { readBlob } from "../index/store.js";
import { allMatches, compileFor, decodeTree, elementPath, type CompactTree, type DecodedTree } from "./tree.js";

/** LRU of decoded trees keyed by blob hash. */
export class TreeCache {
  private readonly map = new Map<string, DecodedTree>();
  constructor(
    readonly blobDir: string,
    readonly max: number,
  ) {}

  get(hash: string): DecodedTree {
    const hit = this.map.get(hash);
    if (hit) {
      this.map.delete(hash);
      this.map.set(hash, hit);
      return hit;
    }
    const tree = decodeTree(JSON.parse(readBlob(this.blobDir, hash).toString("utf8")) as CompactTree);
    this.map.set(hash, tree);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return tree;
  }

  get size(): number {
    return this.map.size;
  }
}

export interface L1Job {
  keys: string[];
  /** Per page: tree hashes (one per variant) and indexes into `keys`. */
  pages: Array<{ id: number; trees: string[]; keys: number[] }>;
}

export interface L1KeyResult {
  key: string;
  checked: number[];
  matched: number[];
  unsupported?: string;
}

export function runJob(job: L1Job, cache: TreeCache): L1KeyResult[] {
  const out: L1KeyResult[] = job.keys.map((key) => ({ key, checked: [], matched: [] }));
  for (const p of job.pages) {
    const trees: DecodedTree[] = [];
    try {
      for (const h of p.trees) trees.push(cache.get(h));
    } catch {
      continue; // Missing blob: leave the page unchecked (stays possible).
    }
    for (const ki of p.keys) {
      const r = out[ki];
      if (r.unsupported) continue;
      let hit = false;
      for (const t of trees) {
        const c = compileFor(r.key, t.quirks);
        if (typeof c !== "function") {
          r.unsupported = c.error;
          break;
        }
        const els = t.elements;
        for (let i = 0; i < els.length; i++) {
          if (c(els[i])) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (r.unsupported) continue;
      r.checked.push(p.id);
      if (hit) r.matched.push(p.id);
    }
  }
  for (const r of out) {
    if (!r.unsupported) continue;
    r.checked = [];
    r.matched = [];
  }
  return out;
}

export interface Drilldown {
  variant: number;
  count: number;
  elements: string[];
}

/** Matched elements per variant for one page (element drilldown, §9). */
export function drill(trees: string[], key: string, cache: TreeCache, limit = 50): Drilldown[] {
  return trees.map((h, variant) => {
    const t = cache.get(h);
    const els = allMatches(t, key, 5000);
    return { variant, count: els.length, elements: els.slice(0, limit).map(elementPath) };
  });
}
