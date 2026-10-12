// Parses an authored CSS text into a flat list of per-selector rule records.
//
// This is the "walk the CSSOM" step from the architecture doc (Phase A / §3
// Rule usage), implemented with postcss instead of a real browser CSSOM
// because the MVP capture backend is jsdom, not a headless browser (see
// README "Known simplifications"). Each comma-separated compound in a
// selector list becomes its own record, since specificity/matching is
// per-compound-selector, not per-rule.

import postcss from "postcss";
import parser from "postcss-selector-parser";
import { calculate } from "specificity";

export interface ParsedSelectorRule {
  /** Stable key: normalizedSelector + conditionPath, used as the index key. */
  key: string;
  /** Original selector text as authored (single compound, comma-split). */
  rawSelector: string;
  /** Selector with interaction-state pseudo-classes stripped (per descope). */
  normalizedSelector: string;
  /** Whether stripping actually removed something (:hover, :focus, ...). */
  hadInteractionState: boolean;
  /** true if postcss-selector-parser could not parse it (unsupported). */
  unsupported: boolean;
  unsupportedReason?: string;
  /** [a, b, c, d] specificity tuple (inline, id, class/attr/pseudo-class, type). */
  specificity: [number, number, number, number];
  important: boolean;
  /** Declared property names on this rule, in source order. */
  properties: string[];
  /** Declared values, parallel to `properties` (same index), for value-diffing. */
  values: string[];
  /** e.g. ["@media (min-width: 800px)", "@layer base"] outer-to-inner. */
  conditionPath: string[];
  /** Monotonic index across the whole stylesheet; used for cascade order. */
  sourceOrder: number;
  /** 1-based line number of the rule in the authored source, for diagnostics. */
  line: number;
}

export interface ParsedStylesheet {
  rules: ParsedSelectorRule[];
  /** var(--x) declarations: name -> declaring selector keys. */
  varDecls: Map<string, Set<string>>;
  /** var(--x) consumers: name -> { selectorKey, property }[]. */
  varUses: Map<string, Array<{ selectorKey: string; property: string }>>;
  parseError?: string;
}

const INTERACTION_PSEUDO_CLASSES = new Set([
  "hover",
  "focus",
  "focus-visible",
  "focus-within",
  "active",
  "target",
  "target-within",
]);

function stripInteractionState(selector: string): { text: string; changed: boolean } {
  let changed = false;
  let text = selector;
  try {
    text = parser((sel) => {
      sel.walkPseudos((pseudo) => {
        const name = pseudo.value.replace(/^::?/, "");
        if (INTERACTION_PSEUDO_CLASSES.has(name)) {
          changed = true;
          pseudo.remove();
        }
      });
    }).processSync(selector);
  } catch {
    // Leave as-is; unsupported-construct detection happens separately.
  }
  return { text: text.trim() || selector, changed };
}

function conditionPathFor(node: postcss.Node): string[] {
  const path: string[] = [];
  let cur: postcss.Container | postcss.Document | undefined = node.parent as any;
  while (cur && cur.type !== "root") {
    if (cur.type === "atrule") {
      const at = cur as unknown as postcss.AtRule;
      path.unshift(`@${at.name} ${at.params}`.trim());
    }
    cur = cur.parent as any;
  }
  return path;
}

export function parseStylesheet(cssText: string, sourcePath = "<inline>"): ParsedStylesheet {
  const rules: ParsedSelectorRule[] = [];
  const varDecls = new Map<string, Set<string>>();
  const varUses = new Map<string, Array<{ selectorKey: string; property: string }>>();

  let root: postcss.Root;
  try {
    root = postcss.parse(cssText, { from: sourcePath });
  } catch (err: any) {
    return { rules, varDecls, varUses, parseError: String(err?.message ?? err) };
  }

  let order = 0;
  root.walkRules((rule) => {
    const conditionPath = conditionPathFor(rule);
    const properties: string[] = [];
    const values: string[] = [];
    let important = false;

    rule.walkDecls((decl) => {
      properties.push(decl.prop);
      values.push(decl.value);
      if (decl.important) important = true;

      if (decl.prop.startsWith("--")) {
        if (!varDecls.has(decl.prop)) varDecls.set(decl.prop, new Set());
      }
      const varMatches = decl.value.matchAll(/var\(\s*(--[\w-]+)/g);
      for (const m of varMatches) {
        const varName = m[1];
        if (!varUses.has(varName)) varUses.set(varName, []);
      }
    });

    let compounds: string[];
    try {
      compounds = parser().astSync(rule.selector).nodes.map((n) => n.toString().trim());
    } catch {
      compounds = [rule.selector];
    }

    for (const rawSelector of compounds) {
      if (!rawSelector) continue;
      const { text: normalizedSelector, changed: hadInteractionState } =
        stripInteractionState(rawSelector);

      let specificity: [number, number, number, number] = [0, 0, 0, 0];
      let unsupported = false;
      let unsupportedReason: string | undefined;
      try {
        const calc = calculate(normalizedSelector) as unknown as { A: number; B: number; C: number };
        specificity = [0, calc.A, calc.B, calc.C];
      } catch (err: any) {
        unsupported = true;
        unsupportedReason = String(err?.message ?? err);
      }

      const key = `${normalizedSelector}|${conditionPath.join(">")}`;
      order += 1;
      const rec: ParsedSelectorRule = {
        key,
        rawSelector,
        normalizedSelector,
        hadInteractionState,
        unsupported,
        unsupportedReason,
        specificity,
        important,
        properties,
        values,
        conditionPath,
        sourceOrder: order,
        line: rule.source?.start?.line ?? 0,
      };
      rules.push(rec);

      for (const prop of properties) {
        if (prop.startsWith("--")) varDecls.get(prop)!.add(key);
      }
      for (const decl of rule.nodes ?? []) {
        if (decl.type !== "decl") continue;
        const varMatches = decl.value.matchAll(/var\(\s*(--[\w-]+)/g);
        for (const m of varMatches) {
          varUses.get(m[1])!.push({ selectorKey: key, property: decl.prop });
        }
      }
    }
  });

  return { rules, varDecls, varUses };
}
