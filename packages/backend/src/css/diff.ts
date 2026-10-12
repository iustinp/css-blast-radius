// Rule-level diff between the last-known and current text of a CSS file
// (Phase B: "parse old vs new CSS (rule-level diff)").

import { parseStylesheet, type ParsedSelectorRule } from "./parseStylesheet.js";

export type ChangeKind = "added" | "removed" | "modified";

export interface SelectorChange {
  kind: ChangeKind;
  key: string;
  before?: ParsedSelectorRule;
  after?: ParsedSelectorRule;
  /** Property names that differ between before/after (for "modified"). */
  changedProperties: string[];
}

export interface StylesheetDiff {
  changes: SelectorChange[];
  changedVarNames: string[];
  parseError?: string;
}

function propsEqual(a: ParsedSelectorRule, b: ParsedSelectorRule): boolean {
  if (a.important !== b.important) return false;
  if (a.properties.length !== b.properties.length) return false;
  return a.properties.every((p, i) => p === b.properties[i] && a.values[i] === b.values[i]);
}

export function diffStylesheets(oldText: string, newText: string, sourcePath = "<inline>"): StylesheetDiff {
  const before = parseStylesheet(oldText, sourcePath);
  const after = parseStylesheet(newText, sourcePath);

  if (after.parseError) {
    return { changes: [], changedVarNames: [], parseError: after.parseError };
  }

  const beforeByKey = new Map(before.rules.map((r) => [r.key, r]));
  const afterByKey = new Map(after.rules.map((r) => [r.key, r]));
  const changes: SelectorChange[] = [];

  for (const [key, afterRule] of afterByKey) {
    const beforeRule = beforeByKey.get(key);
    if (!beforeRule) {
      changes.push({ kind: "added", key, after: afterRule, changedProperties: afterRule.properties });
      continue;
    }
    if (!propsEqual(beforeRule, afterRule)) {
      const changedProperties = [
        ...new Set([...beforeRule.properties, ...afterRule.properties]),
      ].filter((p) => {
        const bi = beforeRule.properties.indexOf(p);
        const ai = afterRule.properties.indexOf(p);
        const inBefore = bi >= 0;
        const inAfter = ai >= 0;
        if (inBefore !== inAfter) return true;
        if (inBefore && inAfter && beforeRule.values[bi] !== afterRule.values[ai]) return true;
        return beforeRule.important !== afterRule.important;
      });
      changes.push({ kind: "modified", key, before: beforeRule, after: afterRule, changedProperties });
    }
  }

  for (const [key, beforeRule] of beforeByKey) {
    if (!afterByKey.has(key)) {
      changes.push({ kind: "removed", key, before: beforeRule, changedProperties: beforeRule.properties });
    }
  }

  const changedVarNames = new Set<string>();
  for (const name of new Set([...before.varDecls.keys(), ...after.varDecls.keys()])) {
    const b = before.varDecls.get(name);
    const a = after.varDecls.get(name);
    const bKeys = b ? [...b].sort().join(",") : "";
    const aKeys = a ? [...a].sort().join(",") : "";
    if (bKeys !== aKeys) changedVarNames.add(name);
  }

  return { changes, changedVarNames: [...changedVarNames] };
}
