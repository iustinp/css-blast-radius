// Diff of two stylesheet models into classified change units (§6.2).
//
// Rules are paired by key (conditions + selector). The common prefix and
// suffix are trimmed first, so a typical keystroke diffs a handful of rules.
// The middle is diffed with Myers; a key removed in one place and added in
// another is a move; remaining removed/added runs are paired in order as
// selector or condition edits.

import { diffArrays } from "diff";
import type { Definition, StyleRule, StylesheetModel } from "./model.js";

export type ChangeKind =
  | "declarations"
  | "selector"
  | "condition"
  | "added"
  | "removed"
  | "moved"
  | "definition"
  | "layer-order"
  | "import"
  | "namespace"
  | "unrecognized";

export interface CssChange {
  kind: ChangeKind;
  before?: StyleRule;
  after?: StyleRule;
  /** Properties whose value changed, was added or removed. */
  changedProps?: string[];
  def?: { kind: string; name: string; usageKey: string; change: "added" | "removed" | "changed" };
  /** Line in the current text (1-based) the change is reported on. */
  line: number;
  detail?: string;
}

function changedProps(a: StyleRule, b: StyleRule): string[] {
  const am = new Map<string, string>();
  for (const d of a.decls) am.set(d.prop, d.value + (d.important ? "!" : ""));
  const bm = new Map<string, string>();
  for (const d of b.decls) bm.set(d.prop, d.value + (d.important ? "!" : ""));
  const out = new Set<string>();
  for (const [p, v] of am) if (bm.get(p) !== v) out.add(p);
  for (const p of bm.keys()) if (!am.has(p)) out.add(p);
  // Same props, same values, different order: the cascade inside the rule changed.
  if (out.size === 0 && a.declSig !== b.declSig) for (const p of bm.keys()) out.add(p);
  return [...out];
}

export function diffRules(oldRules: StyleRule[], newRules: StyleRule[], lastLine: number): CssChange[] {
  const changes: CssChange[] = [];
  const same = (a: StyleRule, b: StyleRule) => a.key === b.key && a.declSig === b.declSig;

  let pre = 0;
  while (pre < oldRules.length && pre < newRules.length && same(oldRules[pre], newRules[pre])) pre++;
  let suf = 0;
  while (
    suf < oldRules.length - pre &&
    suf < newRules.length - pre &&
    same(oldRules[oldRules.length - 1 - suf], newRules[newRules.length - 1 - suf])
  ) {
    suf++;
  }
  const a = oldRules.slice(pre, oldRules.length - suf);
  const b = newRules.slice(pre, newRules.length - suf);
  if (a.length === 0 && b.length === 0) return changes;

  const lineAt = (newIdx: number) => b[newIdx]?.line ?? newRules[pre + newIdx]?.line ?? lastLine;

  // Walk the Myers script, collecting equal pairs and removed/added runs.
  type Run = { removed: Array<{ rule: StyleRule; line: number }>; added: StyleRule[] };
  const runs: Run[] = [];
  let ai = 0;
  let bi = 0;
  let cur: Run | null = null;
  for (const part of diffArrays(a.map((r) => r.key), b.map((r) => r.key))) {
    const n = part.count ?? part.value.length;
    if (part.removed) {
      cur ??= { removed: [], added: [] };
      for (let k = 0; k < n; k++) cur.removed.push({ rule: a[ai++], line: lineAt(bi) });
    } else if (part.added) {
      cur ??= { removed: [], added: [] };
      for (let k = 0; k < n; k++) cur.added.push(b[bi++]);
    } else {
      if (cur) runs.push(cur);
      cur = null;
      for (let k = 0; k < n; k++) {
        const o = a[ai++];
        const nr = b[bi++];
        if (o.declSig !== nr.declSig) {
          changes.push({ kind: "declarations", before: o, after: nr, changedProps: changedProps(o, nr), line: nr.line });
        }
      }
    }
  }
  if (cur) runs.push(cur);

  // Moves: the same key removed somewhere and added elsewhere.
  const removedByKey = new Map<string, Array<{ rule: StyleRule; line: number; used: boolean }>>();
  for (const run of runs) {
    for (const r of run.removed) {
      const list = removedByKey.get(r.rule.key) ?? [];
      list.push({ ...r, used: false });
      removedByKey.set(r.rule.key, list);
    }
  }
  const movedAdded = new Set<StyleRule>();
  const movedRemoved = new Set<StyleRule>();
  for (const run of runs) {
    for (const added of run.added) {
      const candidates = removedByKey.get(added.key);
      if (!candidates) continue;
      // Only a real move if the removal happened in a different run.
      const pick =
        candidates.find((c) => !c.used && !run.removed.some((r) => r.rule === c.rule) && c.rule.declSig === added.declSig) ??
        candidates.find((c) => !c.used && !run.removed.some((r) => r.rule === c.rule));
      if (!pick) continue;
      pick.used = true;
      movedAdded.add(added);
      movedRemoved.add(pick.rule);
      const props = pick.rule.declSig !== added.declSig ? changedProps(pick.rule, added) : undefined;
      changes.push({ kind: "moved", before: pick.rule, after: added, changedProps: props, line: added.line });
    }
  }

  // Pair the rest positionally inside each run.
  for (const run of runs) {
    const removed = run.removed.filter((r) => !movedRemoved.has(r.rule));
    const added = run.added.filter((r) => !movedAdded.has(r));
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const o = removed[k].rule;
      const nr = added[k];
      const kind: ChangeKind = o.selectorText === nr.selectorText ? "condition" : "selector";
      changes.push({
        kind,
        before: o,
        after: nr,
        changedProps: o.declSig !== nr.declSig ? changedProps(o, nr) : undefined,
        line: nr.line,
      });
    }
    for (let k = pairs; k < removed.length; k++) {
      changes.push({ kind: "removed", before: removed[k].rule, line: removed[k].line });
    }
    for (let k = pairs; k < added.length; k++) {
      changes.push({ kind: "added", after: added[k], line: added[k].line });
    }
  }

  return changes.sort((x, y) => x.line - y.line);
}

function defKey(d: Definition): string {
  return `${d.kind}|${d.name}`;
}

export function diffModels(base: StylesheetModel, cur: StylesheetModel, lastLine: number): CssChange[] {
  const changes = diffRules(base.rules, cur.rules, lastLine);

  const baseDefs = new Map<string, Definition[]>();
  for (const d of base.defs) baseDefs.set(defKey(d), [...(baseDefs.get(defKey(d)) ?? []), d]);
  const curDefs = new Map<string, Definition[]>();
  for (const d of cur.defs) curDefs.set(defKey(d), [...(curDefs.get(defKey(d)) ?? []), d]);
  for (const [k, list] of curDefs) {
    const old = baseDefs.get(k) ?? [];
    const sigOld = old.map((d) => d.sig).join("\n");
    const sigNew = list.map((d) => d.sig).join("\n");
    if (sigOld === sigNew) continue;
    const d = list[0];
    changes.push({
      kind: "definition",
      def: { kind: d.kind, name: d.name, usageKey: d.usageKey, change: old.length ? "changed" : "added" },
      line: d.line,
    });
  }
  for (const [k, list] of baseDefs) {
    if (curDefs.has(k)) continue;
    const d = list[0];
    changes.push({
      kind: "definition",
      def: { kind: d.kind, name: d.name, usageKey: d.usageKey, change: "removed" },
      line: Math.min(d.line, lastLine),
    });
  }

  if (base.layerOrder.join(",") !== cur.layerOrder.join(",")) {
    changes.push({ kind: "layer-order", line: 1, detail: `${base.layerOrder.join(", ")} → ${cur.layerOrder.join(", ")}` });
  }
  if (base.imports.join("\n") !== cur.imports.join("\n")) {
    changes.push({ kind: "import", line: 1, detail: "@import list changed" });
  }
  if (base.namespaces.join("\n") !== cur.namespaces.join("\n")) {
    changes.push({ kind: "namespace", line: 1, detail: "@namespace changed" });
  }
  const otherSig = (m: StylesheetModel) => m.other.map((o) => o.sig).join("\n");
  if (otherSig(base) !== otherSig(cur)) {
    const baseSigs = new Set(base.other.map((o) => o.sig));
    const first = cur.other.find((o) => !baseSigs.has(o.sig));
    changes.push({ kind: "unrecognized", line: first?.line ?? 1, detail: `@${first?.name ?? "rule"} changed` });
  }
  return changes.sort((x, y) => x.line - y.line);
}
