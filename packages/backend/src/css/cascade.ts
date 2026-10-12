// Bounded cascade probe (Phase A §4), approximated without a real browser
// devtools protocol connection. For each sampled matched element we ask:
// "does *this* rule win the cascade for each of its declared properties,
// among all other same-page rules that also match this element and declare
// the same property?" Winner = !important > specificity > source order.
//
// MVP simplification: @media/@supports/@container activation is not
// evaluated (jsdom does not reliably resolve real viewport-driven media
// queries without a full layout engine). Rules inside a non-empty
// conditionPath are still included in the comparison pool (worst case:
// slightly pessimistic "applies" counts) and every answer whose selector
// carries a conditionPath is downgraded to PARTIAL with reason
// `condition-not-evaluated` (see analysis/queryImpacts).

import type { CapturedPage } from "../crawl/capturePage.js";
import type { ParsedSelectorRule } from "../css/parseStylesheet.js";
import type { Corpus } from "../crawl/crawler.js";

export const INHERITED_PROPERTIES = new Set([
  "color",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-indent",
  "visibility",
  "cursor",
  "list-style",
  "list-style-type",
  "white-space",
  "word-spacing",
  "quotes",
]);

export const MAX_CASCADE_SAMPLE = 8;

function allRulesForPage(corpus: Corpus, page: CapturedPage): ParsedSelectorRule[] {
  const rules: ParsedSelectorRule[] = [];
  for (const cssPath of page.linkedStylesheetPaths) {
    const file = corpus.cssFiles.get(cssPath);
    if (file) rules.push(...file.parsed.rules);
  }
  return rules;
}

function specificityGt(a: [number, number, number, number], b: [number, number, number, number]): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function wins(
  candidate: ParsedSelectorRule,
  others: ParsedSelectorRule[],
  property: string,
): boolean {
  for (const other of others) {
    if (other === candidate) continue;
    if (!other.properties.includes(property)) continue;
    if (other.important && !candidate.important) return false;
    if (candidate.important && !other.important) continue;
    const cmp = specificityGt(other.specificity, candidate.specificity);
    if (cmp > 0) return false;
    if (cmp === 0 && other.sourceOrder > candidate.sourceOrder) return false;
  }
  return true;
}

export interface CascadeSample {
  property: string;
  sampledCount: number;
  winCount: number;
}

/**
 * Samples up to MAX_CASCADE_SAMPLE matched elements and reports, per
 * declared property, how many of the sampled elements have this rule
 * actually winning the cascade (vs. merely matching).
 */
export function sampleCascade(
  corpus: Corpus,
  page: CapturedPage,
  rule: Pick<ParsedSelectorRule, "normalizedSelector" | "specificity" | "important" | "sourceOrder" | "properties">,
  matchedElements: Element[],
): CascadeSample[] {
  const others = allRulesForPage(corpus, page);
  const sample = matchedElements.slice(0, MAX_CASCADE_SAMPLE);
  const perProperty = new Map<string, CascadeSample>();

  for (const property of rule.properties) {
    perProperty.set(property, { property, sampledCount: 0, winCount: 0 });
  }

  for (const el of sample) {
    const matchingOthers = others.filter((o) => {
      if (o.normalizedSelector === rule.normalizedSelector) return false;
      try {
        return el.matches(o.normalizedSelector);
      } catch {
        return false;
      }
    });
    for (const property of rule.properties) {
      const s = perProperty.get(property)!;
      s.sampledCount += 1;
      const won = wins(
        { ...rule, properties: rule.properties } as ParsedSelectorRule,
        matchingOthers,
        property,
      );
      if (won) s.winCount += 1;
    }
  }

  return [...perProperty.values()];
}

/** Descendant-reach count for inherited properties (documented as an understatement). */
export function inheritsIntoCount(page: CapturedPage, selector: string): number {
  try {
    return page.dom.window.document.querySelectorAll(`${selector} *`).length;
  } catch {
    return 0;
  }
}
