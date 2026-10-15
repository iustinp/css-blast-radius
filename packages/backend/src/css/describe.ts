// One edit's rule as the panel's edit card shows it (analysis/getChange):
// every declaration in file order, marked as part of the edit or not.

import { diffArrays } from "diff";
import type { CssChange } from "./diff.js";
import type { Decl, StyleRule } from "./model.js";

export interface RuleDecl {
  /** `prop: value` (comments and extra spaces dropped). */
  text: string;
  /** changed: part of the edit; same: untouched; removed: only in the base (part of the edit). */
  state: "changed" | "same" | "removed";
  /** The value before, when the edit changed it. */
  was?: string;
  /** Where it is in the current text (1-based); absent when removed. */
  line?: number;
  column?: number;
}

export interface ChangeRule {
  selector: string;
  /** The selector before, when the edit changed it. */
  oldSelector?: string;
  /** @media/@supports/@layer… around the rule, outermost first. */
  conditions: string[];
  /** The conditions before, when the edit changed them. */
  oldConditions?: string[];
  /** The edit deletes the whole rule: it's shown as it was in the base. */
  removed: boolean;
  decls: RuleDecl[];
  /** The rule in the current text (1-based); for a removed rule, where it was. */
  line: number;
  endLine: number;
}

export interface ChangeDescription {
  /** Where to make adjustments in the current text (1-based): the first changed declaration, else the rule. */
  line: number;
  column?: number;
  rule?: ChangeRule;
  /** Edits outside style rules: @font-face, @keyframes, layer order, imports… */
  summary?: string;
}

const value = (d: Decl) => `${d.value}${d.important ? " !important" : ""}`;
const text = (d: Decl) => `${d.prop}: ${value(d)}`;

/** A declaration's position in the whole text (its own is relative to the rule's top-level statement). */
function placer(rule: StyleRule): (d: Decl) => { line?: number; column?: number } {
  const c = rule.chunkAt;
  return (d) => {
    if (d.line === undefined || d.column === undefined || !c) return { line: d.line, column: d.column };
    return d.line === 1 ? { line: c.line, column: d.column + c.column - 1 } : { line: d.line + c.line - 1, column: d.column };
  };
}

/**
 * Declarations of both versions in file order. A value change is one
 * declaration with `was`; `whole`: the rule itself changed (selector,
 * conditions, position or a new rule), so every declaration is part of it.
 */
function mergeDecls(before: Decl[], after: Decl[], whole: boolean, at: ReturnType<typeof placer>): RuleDecl[] {
  const out: RuleDecl[] = [];
  const changed = (d: Decl, was?: Decl): RuleDecl => ({
    text: text(d), state: "changed", ...(was && value(was) !== value(d) ? { was: value(was) } : {}), ...at(d),
  });
  let removed: Decl[] = [];
  let added: Decl[] = [];
  const flush = () => {
    // Removed and added runs: the same property on both sides is a new value.
    const pair = new Map<Decl, Decl>();
    const taken = new Set<Decl>();
    for (const r of removed) {
      const a = added.find((x) => !taken.has(x) && x.prop === r.prop);
      if (a) {
        pair.set(r, a);
        taken.add(a);
      }
    }
    const was = new Map([...pair].map(([r, a]) => [a, r]));
    let next = 0;
    for (const r of removed) {
      const a = pair.get(r);
      if (!a) {
        out.push({ text: text(r), state: "removed" });
        continue;
      }
      for (const end = added.indexOf(a); next <= end; next++) out.push(changed(added[next], was.get(added[next])));
    }
    for (; next < added.length; next++) out.push(changed(added[next], was.get(added[next])));
    removed = [];
    added = [];
  };
  let bi = 0;
  let ai = 0;
  const sig = (d: Decl) => `${d.prop}:${value(d)}`;
  for (const part of diffArrays(before.map(sig), after.map(sig))) {
    const n = part.count ?? part.value.length;
    if (part.removed) removed.push(...before.slice(bi, (bi += n)));
    else if (part.added) added.push(...after.slice(ai, (ai += n)));
    else {
      flush();
      for (const d of after.slice(ai, (ai += n))) out.push(whole ? changed(d) : { text: text(d), state: "same", ...at(d) });
      bi += n;
    }
  }
  flush();
  return out;
}

export function describeChange(c: CssChange): ChangeDescription {
  if (c.after) {
    const a = c.after;
    const b = c.before;
    // A new selector, new conditions, a move or a new rule: the whole rule reaches other elements.
    const whole = c.kind !== "declarations";
    const decls = mergeDecls(b?.decls ?? [], a.decls, whole, placer(a));
    const first = !whole ? decls.find((d) => d.state === "changed" && d.line !== undefined) : undefined;
    const conditions = a.conditions.map((x) => x.text);
    // Otherwise the rule's selector: on one line of minified CSS, the line alone isn't enough.
    const ruleColumn = a.column === undefined ? undefined
      : a.chunkAt && a.line === a.chunkAt.line ? a.column + a.chunkAt.column - 1 : a.column;
    return {
      line: first?.line ?? a.line,
      column: first ? first.column : ruleColumn,
      rule: {
        selector: a.selectorText,
        ...(b && b.selectorText !== a.selectorText ? { oldSelector: b.selectorText } : {}),
        conditions,
        ...(b && b.condKey !== a.condKey ? { oldConditions: b.conditions.map((x) => x.text) } : {}),
        removed: false,
        decls,
        line: a.line,
        endLine: a.endLine,
      },
    };
  }
  if (c.before) {
    const b = c.before;
    return {
      line: c.line,
      rule: {
        selector: b.selectorText,
        conditions: b.conditions.map((x) => x.text),
        removed: true,
        decls: b.decls.map((d) => ({ text: text(d), state: "removed" })),
        line: c.line,
        endLine: c.line,
      },
    };
  }
  const summary = c.def ? `@${c.def.kind} ${c.def.name} ${c.def.change}` : c.detail ?? `${c.kind} changed`;
  return { line: c.line, summary };
}
