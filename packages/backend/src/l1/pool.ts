// L1 pool (§6.4): fans pending selector work out to worker threads with page
// affinity (page id % N), so each worker's tree cache stays warm for its
// share of the site. `workers: 0` runs in-process (tests, tiny sites).

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { PendingWork } from "../engine/l0.js";
import type { SiteIndex } from "../index/siteIndex.js";
import type { PageRow } from "../index/store.js";
import { drill, runJob, TreeCache, type Drilldown, type L1Job, type L1KeyResult } from "./match.js";

export interface L1PoolOptions {
  blobDir: string;
  /** Worker threads; 0 = in-process. Default: min(4, cores - 1). */
  workers?: number;
  /** Decoded trees kept per worker. */
  maxTreesPerWorker?: number;
}

interface Slot {
  worker: Worker;
  dead?: Error;
  waiting: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
}

function treesOf(p: PageRow): string[] {
  return Object.keys(p.trees)
    .map(Number)
    .sort((a, b) => a - b)
    .map((v) => p.trees[v]);
}

function spawn(workerData: unknown): Worker {
  const js = new URL("./worker.js", import.meta.url);
  if (existsSync(fileURLToPath(js))) return new Worker(js, { workerData });
  // Running from source (tsx / vitest): load the TypeScript worker through tsx.
  const ts = new URL("./worker.ts", import.meta.url).href;
  // The ESM build sits next to the CommonJS one that require.resolve returns.
  const api = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api").replace(/\.cjs$/, ".mjs")).href;
  const boot = `import(${JSON.stringify(api)}).then((a) => a.tsImport(${JSON.stringify(ts)}, ${JSON.stringify(ts)}))`;
  return new Worker(boot, { eval: true, workerData });
}

export class L1Pool {
  private readonly slots: Slot[] = [];
  private readonly local?: TreeCache;
  private seq = 0;

  constructor(opts: L1PoolOptions) {
    const n = opts.workers ?? Math.max(1, Math.min(4, availableParallelism() - 1));
    const maxTrees = opts.maxTreesPerWorker ?? 2000;
    if (n === 0) {
      this.local = new TreeCache(opts.blobDir, maxTrees);
      return;
    }
    for (let i = 0; i < n; i++) {
      const worker = spawn({ blobDir: opts.blobDir, maxTrees });
      const slot: Slot = { worker, waiting: new Map() };
      worker.on("message", (m: { id: number; result?: unknown; error?: string }) => {
        const w = slot.waiting.get(m.id);
        if (!w) return;
        slot.waiting.delete(m.id);
        if (slot.waiting.size === 0) worker.unref();
        if (m.error) w.reject(new Error(m.error));
        else w.resolve(m.result);
      });
      const fail = (err: Error) => {
        slot.dead = err;
        for (const w of slot.waiting.values()) w.reject(err);
        slot.waiting.clear();
      };
      worker.on("error", fail);
      worker.on("exit", (code) => fail(new Error(`L1 worker exited (${code})`)));
      worker.unref();
      this.slots.push(slot);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  private call<T>(slot: Slot, msg: Record<string, unknown>): Promise<T> {
    if (slot.dead) return Promise.reject(slot.dead);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      slot.waiting.set(id, { resolve, reject });
      slot.worker.ref();
      slot.worker.postMessage({ ...msg, id });
    });
  }

  private slotFor(pageId: number): Slot {
    return this.slots[pageId % this.slots.length];
  }

  /** Resolves pending selectors on their candidate pages. */
  async resolve(pending: PendingWork, index: SiteIndex): Promise<L1KeyResult[]> {
    const keys = [...pending.keys()];
    const perPage = new Map<number, number[]>();
    keys.forEach((k, ki) => {
      for (const id of pending.get(k)!.ids()) {
        let list = perPage.get(id);
        if (!list) perPage.set(id, (list = []));
        list.push(ki);
      }
    });
    const jobs: L1Job[] = this.local ? [{ keys, pages: [] }] : this.slots.map(() => ({ keys, pages: [] }));
    for (const [id, ks] of perPage) {
      const p = index.pages[id];
      if (!p || p.status !== "ok") continue;
      jobs[this.local ? 0 : id % this.slots.length].pages.push({ id, trees: treesOf(p), keys: ks });
    }
    const parts = this.local
      ? [runJob(jobs[0], this.local)]
      : await Promise.all(this.slots.map((s, i) => (jobs[i].pages.length ? this.call<L1KeyResult[]>(s, { type: "job", job: jobs[i] }) : Promise.resolve([]))));
    const merged = new Map<string, L1KeyResult>(keys.map((key) => [key, { key, checked: [], matched: [] }]));
    for (const part of parts) {
      for (const r of part) {
        const m = merged.get(r.key)!;
        m.checked.push(...r.checked);
        m.matched.push(...r.matched);
        if (r.unsupported) m.unsupported = r.unsupported;
      }
    }
    for (const m of merged.values()) {
      if (!m.unsupported) continue;
      m.checked = [];
      m.matched = [];
    }
    return [...merged.values()];
  }

  /** Matched elements on one page, per variant. */
  async drill(page: PageRow, key: string, limit = 50): Promise<Drilldown[]> {
    const trees = treesOf(page);
    if (this.local) return drill(trees, key, this.local, limit);
    return this.call<Drilldown[]>(this.slotFor(page.id), { type: "drill", trees, key, limit });
  }

  /** Preloads trees so the first L1 query doesn't pay for decoding. */
  async warm(index: SiteIndex): Promise<number> {
    if (this.local) return 0;
    const per: string[][] = this.slots.map(() => []);
    for (const p of index.pages) if (p.status === "ok") per[p.id % this.slots.length].push(...treesOf(p));
    const counts = await Promise.all(this.slots.map((s, i) => this.call<number>(s, { type: "warm", trees: per[i] })));
    return counts.reduce((a, b) => a + b, 0);
  }

  async close(): Promise<void> {
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots.length = 0;
  }
}
