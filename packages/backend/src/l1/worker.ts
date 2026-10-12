// L1 worker thread: owns a tree cache for the pages assigned to it
// (page affinity id % N) and resolves selector jobs against them.

import { parentPort, workerData } from "node:worker_threads";
import { drill, runJob, TreeCache, type L1Job } from "./match.js";

const { blobDir, maxTrees } = workerData as { blobDir: string; maxTrees: number };
const cache = new TreeCache(blobDir, maxTrees);

export type WorkerRequest =
  | { id: number; type: "job"; job: L1Job }
  | { id: number; type: "drill"; trees: string[]; key: string; limit: number }
  | { id: number; type: "warm"; trees: string[] };

parentPort!.on("message", (msg: WorkerRequest) => {
  try {
    if (msg.type === "job") parentPort!.postMessage({ id: msg.id, result: runJob(msg.job, cache) });
    else if (msg.type === "drill") parentPort!.postMessage({ id: msg.id, result: drill(msg.trees, msg.key, cache, msg.limit) });
    else {
      let loaded = 0;
      for (const h of msg.trees) {
        if (cache.size >= cache.max) break;
        try {
          cache.get(h);
          loaded++;
        } catch {
          // Missing blob: matched lazily later (and reported then).
        }
      }
      parentPort!.postMessage({ id: msg.id, result: loaded });
    }
  } catch (err: any) {
    parentPort!.postMessage({ id: msg.id, error: String(err?.stack ?? err) });
  }
});
