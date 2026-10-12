// Phase B analysis engine: turns a CSS file's old->new text diff into the
// answer-contract impact report, querying the in-memory corpus built by
// Phase A. This is the logic that would run inside the local daemon on
// every debounced edit/save.

import path from "node:path";
import { diffStylesheets } from "../css/diff.js";
import { pagesLinking, type Corpus } from "../crawl/crawler.js";
import { sampleCascade, inheritsIntoCount, INHERITED_PROPERTIES } from "../css/cascade.js";
import type {
  ImpactAnswer,
  SelectorImpact,
  PageMatch,
  ReasonCode,
  Confidence,
} from "../css/answerContract.js";

export interface AnalyzeOptions {
  corpus: Corpus;
  cssFilePath: string;
  oldText: string;
  newText: string;
  epoch: number;
  profile?: string;
}

export function analyzeChange(opts: AnalyzeOptions): ImpactAnswer {
  const { corpus, cssFilePath, oldText, newText, epoch } = opts;
  const profile = opts.profile ?? "desktop";
  const resolvedCssPath = path.resolve(cssFilePath);
  const diff = diffStylesheets(oldText, newText, resolvedCssPath);

  const linkingPages = pagesLinking(corpus, resolvedCssPath);
  const selectors: SelectorImpact[] = [];

  const baseImpact: ReasonCode[] = [];
  if (linkingPages.length === 0) baseImpact.push("stylesheet-not-linked-on-page");
  if (corpus.pages.size === 0) baseImpact.push("no-pages-in-corpus");

  for (const change of diff.changes) {
    const rule = change.after ?? change.before!;
    const reasonCodes: ReasonCode[] = [...baseImpact];
    let confidence: Confidence = "EXACT";

    if (rule.unsupported) {
      reasonCodes.push("unsupported-construct");
      selectors.push({
        kind: change.kind,
        selector: rule.rawSelector,
        conditionPath: rule.conditionPath,
        hadInteractionState: rule.hadInteractionState,
        matches: 0,
        matchedPages: [],
        applies: [],
        inheritsInto: 0,
        confidence: "UNSUPPORTED",
        basis: "LOCAL_PROBE",
        overlayState: "CLEAN",
        reasonCodes,
        losses: [],
      });
      continue;
    }

    if (rule.conditionPath.length > 0) {
      reasonCodes.push("condition-not-evaluated");
      confidence = "PARTIAL";
    }
    if (rule.hadInteractionState) {
      confidence = confidence === "EXACT" ? "SAMPLED" : confidence;
    }

    const matchedPages: PageMatch[] = [];
    let totalMatches = 0;
    let totalInherits = 0;
    const appliesAgg = new Map<string, { sampledCount: number; winCount: number }>();
    const losses: SelectorImpact["losses"] = [];

    for (const page of linkingPages) {
      let count = 0;
      let elements: Element[] = [];
      try {
        const nodeList = page.dom.window.document.querySelectorAll(rule.normalizedSelector);
        elements = [...nodeList] as unknown as Element[];
        count = elements.length;
      } catch {
        reasonCodes.push("unsupported-construct");
        confidence = "UNSUPPORTED";
        continue;
      }

      if (count > 0) {
        matchedPages.push({ url: page.url, matches: count });
        totalMatches += count;
        totalInherits += inheritsIntoCount(page, rule.normalizedSelector);

        if (change.kind !== "removed") {
          const samples = sampleCascade(corpus, page, rule, elements);
          for (const s of samples) {
            const agg = appliesAgg.get(s.property) ?? { sampledCount: 0, winCount: 0 };
            agg.sampledCount += s.sampledCount;
            agg.winCount += s.winCount;
            appliesAgg.set(s.property, agg);
          }
        }

        if (change.kind === "removed") {
          for (const property of change.before!.properties) {
            const hasFallbackRule = corpus.cssFiles
              .get(path.resolve(page.linkedStylesheetPaths.find((p) => p === resolvedCssPath) ?? resolvedCssPath))
              ? [...corpus.cssFiles.values()].some((f) =>
                  f.parsed.rules.some(
                    (r) =>
                      r.key !== rule.key &&
                      r.properties.includes(property) &&
                      elements.some((el) => {
                        try {
                          return el.matches(r.normalizedSelector);
                        } catch {
                          return false;
                        }
                      }),
                  ),
                )
              : false;
            losses.push({ pageUrl: page.url, property, hasFallbackRule });
          }
        }
      }
    }

    if (totalMatches === 0) {
      reasonCodes.push("selector-never-matched");
    }

    const applies = [...appliesAgg.entries()].map(([property, v]) => ({
      property,
      sampledCount: v.sampledCount,
      winCount: v.winCount,
    }));
    if (applies.length > 0 && confidence === "EXACT") confidence = "SAMPLED";

    selectors.push({
      kind: change.kind,
      selector: rule.rawSelector,
      conditionPath: rule.conditionPath,
      hadInteractionState: rule.hadInteractionState,
      matches: totalMatches,
      matchedPages,
      applies,
      inheritsInto: totalInherits,
      confidence,
      basis: "LOCAL_PROBE",
      overlayState: "CLEAN",
      reasonCodes: [...new Set(reasonCodes)],
      losses,
    });
  }

  return {
    file: resolvedCssPath,
    epoch,
    baseIndexRevision: `local-snapshot-${corpus.builtAt}`,
    profile,
    selectors,
  };
}
