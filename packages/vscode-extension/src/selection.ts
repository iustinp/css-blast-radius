// Which edits the panel has picked. Page lists, impact assessment and the
// diff viewer follow it. Picking a file (or "All edits") picks everything in
// it, edits made later included; a parent counts as picked exactly when all
// of its edits are.

import type { EditSelection } from "./protocol";

/** undefined: every edit. Otherwise per file: all of it, or some of its change ids; files not listed: none. */
export type Picked = Map<string, "all" | Set<string>> | undefined;

/** A changed file and the ids of its current edits. */
export interface FileEdits {
  path: string;
  ids: string[];
}

export function isPicked(sel: Picked, path: string, id: string): boolean {
  if (!sel) return true;
  const e = sel.get(path);
  return e === "all" || (!!e && e.has(id));
}

export function fileState(sel: Picked, f: FileEdits): "all" | "some" | "none" {
  if (!sel || sel.get(f.path) === "all") return "all";
  const n = f.ids.filter((id) => isPicked(sel, f.path, id)).length;
  return n === 0 ? "none" : n === f.ids.length ? "all" : "some";
}

export function pickedCount(sel: Picked, files: FileEdits[]): number {
  return files.reduce((n, f) => n + f.ids.filter((id) => isPicked(sel, f.path, id)).length, 0);
}

/** Everything picked → nothing; otherwise → everything. */
export function toggleAll(sel: Picked, files: FileEdits[]): Picked {
  return files.length && files.every((f) => fileState(sel, f) === "all") ? new Map() : undefined;
}

export function toggleFile(sel: Picked, files: FileEdits[], path: string): Picked {
  const f = files.find((x) => x.path === path);
  if (!f) return sel;
  const next = expand(sel, files);
  if (fileState(sel, f) === "all") next.delete(path);
  else next.set(path, "all");
  return normalize(next, files);
}

export function toggleChange(sel: Picked, files: FileEdits[], path: string, id: string): Picked {
  const f = files.find((x) => x.path === path);
  if (!f || !f.ids.includes(id)) return sel;
  const next = expand(sel, files);
  const e = next.get(path);
  const ids = e === "all" ? new Set(f.ids) : new Set(e ?? []);
  if (isPicked(sel, path, id)) ids.delete(id);
  else ids.add(id);
  next.set(path, ids);
  return normalize(next, files);
}

/** A file whose current edits are all picked becomes "all" (later edits join); everything picked becomes undefined. */
export function normalize(sel: Picked, files: FileEdits[]): Picked {
  // No edits known yet (reconnecting, documents reopening): keep the picks as they are.
  if (!sel || !files.length) return sel;
  const next = new Map(sel);
  for (const f of files) {
    const e = next.get(f.path);
    if (e && e !== "all" && f.ids.length && f.ids.every((id) => e.has(id))) next.set(f.path, "all");
  }
  for (const [path, e] of next) if (e !== "all" && e.size === 0) next.delete(path);
  return files.every((f) => next.get(f.path) === "all") ? undefined : next;
}

/** The one edit picked, when exactly one is. */
export function single(sel: Picked, files: FileEdits[]): { path: string; id: string } | undefined {
  let found: { path: string; id: string } | undefined;
  for (const f of files) {
    for (const id of f.ids) {
      if (!isPicked(sel, f.path, id)) continue;
      if (found) return undefined;
      found = { path: f.path, id };
    }
  }
  return found;
}

export function toWire(sel: Picked): EditSelection | undefined {
  if (!sel) return undefined;
  return [...sel].map(([path, e]) => (e === "all" ? { path } : { path, changeIds: [...e] }));
}

/** An explicit per-file map of the current state, to edit. */
function expand(sel: Picked, files: FileEdits[]): Map<string, "all" | Set<string>> {
  if (sel) return new Map(sel);
  return new Map(files.map((f) => [f.path, "all" as const]));
}
