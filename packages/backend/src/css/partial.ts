// A stylesheet with only some of its edits applied: the base text plus the
// line hunks of the chosen changes (what the visual diff shows when the user
// selects a few edits).
//
// Lines are diffed tagged with the rule they belong to, so hunks follow the
// stylesheet's structure. Each changed rule or definition owns the lines of
// its block (innermost block wins) and the first/last lines of its enclosing
// blocks, on the base side for what it was and on the current side for what
// it is. A hunk goes with its owners; one with several owners is split when
// its lines separate cleanly, otherwise its changes are applied together.
// Statements outside any rule (@import, `@layer a, b;`, comments) go with the
// file-level changes when the file has any, and are applied otherwise. Lines of
// a rule no change owns were moved by the line diff: they go with the moves.
// The result is checked against the rules (and their order) and file-level
// statements it should have; when it doesn't match, the whole current text is
// used instead (never a wrong partial view).

import { diffArrays } from "diff";
import type { CssChange } from "./diff.js";
import { browserModel, type Definition, type StylesheetModel } from "./model.js";

export interface PartialResult {
  text: string;
  /** Changes applied although not chosen: they share lines with a chosen one (or every change, on fallback). */
  alsoApplied: number[];
  /** The edits couldn't be separated: `text` is the whole current text. */
  fallback?: boolean;
}

const FILE_LEVEL = new Set(["layer-order", "import", "namespace", "unrecognized"]);

interface Owned {
  /** Inclusive line ranges, innermost wins. */
  ranges: Array<{ from: number; to: number; owner: number }>;
  /** Enclosing-block lines: every owner listed shares the line. */
  ctx: Map<number, Set<number>>;
}

function owned(): Owned {
  return { ranges: [], ctx: new Map() };
}

function addBlock(side: Owned, owner: number, from: number, to: number, ctxLines: number[]): void {
  if (from <= 0) return;
  side.ranges.push({ from, to: Math.max(from, to), owner });
  for (const l of ctxLines) {
    let set = side.ctx.get(l);
    if (!set) side.ctx.set(l, (set = new Set()));
    set.add(owner);
  }
}

function ownersAt(side: Owned, line: number): number[] {
  let best: number[] = [];
  let size = Infinity;
  for (const r of side.ranges) {
    if (line < r.from || line > r.to) continue;
    const n = r.to - r.from;
    if (n < size) {
      size = n;
      best = [r.owner];
    } else if (n === size && !best.includes(r.owner)) best.push(r.owner);
  }
  const ctx = side.ctx.get(line);
  if (ctx) for (const o of ctx) if (!best.includes(o)) best.push(o);
  return best;
}

function defsNamed(m: StylesheetModel, kind: string, name: string): Definition[] {
  return m.defs.filter((d) => d.kind === kind && d.name === name);
}

/**
 * The innermost rule or definition each line belongs to. Lines are diffed
 * with it, so a line only pairs with a line of the same rule: the hunks
 * follow the stylesheet's structure rather than look-alike text.
 */
function lineKeys(m: StylesheetModel, n: number): string[] {
  const keys = new Array<string>(n).fill("");
  const blocks = [
    ...m.rules.map((r) => ({ from: r.line, to: r.endLine, key: `r:${r.key}` })),
    ...m.defs.map((d) => ({ from: d.line, to: d.endLine, key: `d:${d.kind}|${d.name}` })),
  ].sort((a, b) => b.to - b.from - (a.to - a.from));
  for (const b of blocks) for (let l = Math.max(1, b.from); l <= Math.min(n, b.to); l++) keys[l - 1] = b.key;
  return keys;
}

type Line = { text: string; owners: number[] };
type Piece = { equal: string[] } | { units: Unit[] };

/**
 * `from` + the hunks of the changes `keep` accepts. `changes` must be the full
 * diff of `fromModel` → `toModel` (the browser models of `from` and `to`), so
 * every hunk can be attributed.
 */
export function partialText(
  from: string,
  to: string,
  changes: CssChange[],
  keep: (i: number) => boolean,
  fromModel: StylesheetModel,
  toModel: StylesheetModel,
): PartialResult {
  const chosen = changes.map((_, i) => keep(i));
  if (chosen.every(Boolean)) return { text: to, alsoApplied: [] };
  if (!chosen.some(Boolean)) return { text: from, alsoApplied: [] };

  const before = owned();
  const after = owned();
  const fileLevel: number[] = [];
  changes.forEach((c, i) => {
    if (c.before) addBlock(before, i, c.before.line, c.before.endLine, c.before.ctxLines);
    if (c.after) addBlock(after, i, c.after.line, c.after.endLine, c.after.ctxLines);
    if (c.def) {
      for (const d of defsNamed(fromModel, c.def.kind, c.def.name)) addBlock(before, i, d.line, d.endLine, d.ctxLines);
      for (const d of defsNamed(toModel, c.def.kind, c.def.name)) addBlock(after, i, d.line, d.endLine, d.ctxLines);
    }
    if (FILE_LEVEL.has(c.kind)) fileLevel.push(i);
  });

  const fromLines = splitLines(from);
  const toLines = splitLines(to);
  const fk = lineKeys(fromModel, fromLines.length);
  const tk = lineKeys(toModel, toLines.length);
  const moved = changes.flatMap((c, i) => (c.kind === "moved" ? [i] : []));
  // -1: text no change is about (no file-level changes): applied, never ties changes together.
  const statement = fileLevel.length ? fileLevel : [-1];
  const ownersOf = (side: Owned, line: number, key: string, text: string): number[] => {
    const o = ownersAt(side, line);
    if (o.length || !text.trim()) return o;
    return key ? moved : statement;
  };
  const pieces: Piece[] = [];
  let fromLine = 0;
  let toLine = 0;
  let removed: Line[] = [];
  let added: Line[] = [];
  const flush = () => {
    if (removed.length || added.length) pieces.push({ units: splitHunk(removed, added) });
    removed = [];
    added = [];
  };
  for (const part of diffArrays(fromLines.map((l, i) => `${fk[i]}\0${l}`), toLines.map((l, i) => `${tk[i]}\0${l}`))) {
    const n = part.count ?? part.value.length;
    if (part.removed) {
      for (let k = 0; k < n; k++, fromLine++) removed.push({ text: fromLines[fromLine], owners: ownersOf(before, fromLine + 1, fk[fromLine], fromLines[fromLine]) });
    } else if (part.added) {
      for (let k = 0; k < n; k++, toLine++) added.push({ text: toLines[toLine], owners: ownersOf(after, toLine + 1, tk[toLine], toLines[toLine]) });
    } else {
      flush();
      pieces.push({ equal: fromLines.slice(fromLine, fromLine + n) });
      fromLine += n;
      toLine += n;
    }
  }
  flush();

  // Changes sharing a piece with an applied change are applied too, until nothing more joins.
  const applied = [...chosen];
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of pieces) {
      if (!("units" in p)) continue;
      for (const u of p.units) {
        if (u.owners.length < 2 || !u.owners.some((o) => applied[o])) continue;
        for (const o of u.owners) if (!applied[o]) grew = applied[o] = true;
      }
    }
  }
  const unownedApplied = fileLevel.length === 0 || fileLevel.some((i) => applied[i]);
  const out: string[] = [];
  for (const p of pieces) {
    if ("equal" in p) out.push(...p.equal);
    else for (const u of p.units) out.push(...((u.owners.length ? applied[u.owners[0]] : unownedApplied) ? u.added : u.removed));
  }
  const text = out.join("");
  if (!matchesExpectation(text, changes, applied, fromModel, toModel)) {
    return { text: to, alsoApplied: chosen.flatMap((c, i) => (c ? [] : [i])), fallback: true };
  }
  const alsoApplied = applied.flatMap((a, i) => (a && !chosen[i] ? [i] : []));
  return { text, alsoApplied };
}

const FILE_LEVEL_VALUE: Record<string, (m: StylesheetModel) => string> = {
  "layer-order": (m) => m.layerOrder.join(","),
  import: (m) => m.imports.join("\n"),
  namespace: (m) => m.namespaces.join("\n"),
  unrecognized: (m) => m.other.map((o) => o.sig).join("\n"),
};

/** Rule keys in order, for the rules both versions have exactly once (what moves reorder). */
function order(m: StylesheetModel, keys: Set<string>): string {
  return m.rules.filter((r) => keys.has(r.key)).map((r) => r.key).join("\0");
}

function onceEach(m: StylesheetModel): Set<string> {
  const n = new Map<string, number>();
  for (const r of m.rules) n.set(r.key, (n.get(r.key) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c === 1).map(([k]) => k));
}

/**
 * The result has the base's rules and definitions with exactly the applied
 * changes' versions swapped in, in the right order, and the right file-level
 * statements. A file-level change the applied rules brought along (a new
 * `@layer x { }` block also changes the layer order) is marked applied.
 */
function matchesExpectation(text: string, changes: CssChange[], applied: boolean[], fromModel: StylesheetModel, toModel: StylesheetModel): boolean {
  const sig = (r: { key: string; declSig: string }) => `${r.key}\0${r.declSig}`;
  const want = new Map<string, number>();
  const bump = (k: string, d: number) => want.set(k, (want.get(k) ?? 0) + d);
  for (const r of fromModel.rules) bump(sig(r), 1);
  const defs = new Map<string, string>();
  const defSigs = (m: StylesheetModel, kind: string, name: string) => defsNamed(m, kind, name).map((d) => d.sig).join("\n");
  for (const d of fromModel.defs) defs.set(`${d.kind}|${d.name}`, defSigs(fromModel, d.kind, d.name));
  changes.forEach((c, i) => {
    if (!applied[i]) return;
    if (c.before) bump(sig(c.before), -1);
    if (c.after) bump(sig(c.after), 1);
    if (c.def) defs.set(`${c.def.kind}|${c.def.name}`, defSigs(toModel, c.def.kind, c.def.name));
  });
  const got = browserModel(text);
  for (const r of got.rules) bump(sig(r), -1);
  if ([...want.values()].some((n) => n !== 0)) return false;
  const gotDefs = new Map<string, string>();
  for (const d of got.defs) gotDefs.set(`${d.kind}|${d.name}`, defSigs(got, d.kind, d.name));
  for (const [k, v] of defs) if ((gotDefs.get(k) ?? "") !== v) return false;
  for (const k of gotDefs.keys()) if (!defs.has(k)) return false;

  const toOnce = onceEach(toModel);
  const common = new Set([...onceEach(fromModel)].filter((k) => toOnce.has(k)));
  const moves = changes.flatMap((c, i) => (c.kind === "moved" ? [applied[i]] : []));
  if (!moves.some(Boolean) && order(got, common) !== order(fromModel, common)) return false;
  if (moves.length && moves.every(Boolean) && order(got, common) !== order(toModel, common)) return false;

  for (const [kind, value] of Object.entries(FILE_LEVEL_VALUE)) {
    const i = changes.findIndex((c) => c.kind === kind);
    const v = value(got);
    if (i < 0 || !applied[i]) {
      if (v === value(fromModel)) continue;
      if (i < 0 || v !== value(toModel)) return false;
      applied[i] = true;
    } else if (v !== value(toModel)) return false;
  }
  return true;
}

function splitLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface Unit {
  owners: number[];
  removed: string[];
  added: string[];
}

/**
 * Splits one hunk into pieces with one owner each when every line has at
 * most one owner and each owner's lines are contiguous on both sides, in the
 * same order. Otherwise the hunk is one unit owned by all its owners.
 */
function splitHunk(removed: Line[], added: Line[]): Unit[] {
  const all = new Set<number>();
  for (const l of [...removed, ...added]) for (const o of l.owners) all.add(o);
  const whole = (): Unit[] => [{ owners: [...all].filter((o) => o >= 0), removed: removed.map((l) => l.text), added: added.map((l) => l.text) }];
  if (all.size <= 1) return whole();
  if ([...removed, ...added].some((l) => l.owners.length > 1)) return whole();

  const segments = (lines: Line[]) => {
    // Unowned lines (blank lines, comments) join the owned line before them, or the first one after;
    // a side with no owned line at all is one unowned piece (-1).
    const own: Array<number | undefined> = [];
    let last: number | undefined;
    for (const l of lines) own.push((last = l.owners[0] ?? last));
    const first = own.find((o) => o !== undefined) ?? -1;
    const segs: Array<{ owner: number; lines: string[] }> = [];
    lines.forEach((l, i) => {
      const o = own[i] ?? first;
      if (segs.length && segs[segs.length - 1].owner === o) segs[segs.length - 1].lines.push(l.text);
      else segs.push({ owner: o, lines: [l.text] });
    });
    return segs;
  };
  const r = segments(removed);
  const a = segments(added);
  const distinct = (segs: Array<{ owner: number }>) => new Set(segs.map((s) => s.owner)).size === segs.length;
  if (!distinct(r) || !distinct(a)) return whole();

  const units: Unit[] = [];
  let i = 0;
  let j = 0;
  while (i < r.length || j < a.length) {
    const ri = r[i];
    const aj = a[j];
    const owners = (o: number) => (o < 0 ? [] : [o]);
    if (ri && aj && ri.owner === aj.owner) {
      units.push({ owners: owners(ri.owner), removed: ri.lines, added: aj.lines });
      i++;
      j++;
    } else if (ri && !a.slice(j).some((s) => s.owner === ri.owner)) {
      units.push({ owners: owners(ri.owner), removed: ri.lines, added: [] });
      i++;
    } else if (aj && !r.slice(i).some((s) => s.owner === aj.owner)) {
      units.push({ owners: owners(aj.owner), removed: [], added: aj.lines });
      j++;
    } else return whole();
  }
  return units;
}
