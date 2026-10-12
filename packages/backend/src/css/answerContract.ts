// The non-negotiable answer contract (see architecture doc). Every impact
// answer produced by the analysis engine conforms to this shape; nothing
// downstream (RPC layer, extension) is allowed to collapse it into one number.

export type Confidence = "EXACT" | "SAMPLED" | "PARTIAL" | "UNSUPPORTED" | "STALE";
export type Basis = "LOCAL_INDEX" | "LOCAL_PROBE" | "SHARED_INDEX" | "VERIFY_PENDING";
export type OverlayState = "CLEAN" | "OPEN_BUFFER_OVERLAY" | "SAVED_NOT_REINDEXED" | "DOM_STALE";

export type ReasonCode =
  | "stale-index"
  | "selector-never-matched"
  | "stylesheet-not-linked-on-page"
  | "unsupported-construct"
  | "condition-inactive"
  | "condition-not-evaluated"
  | "cors-blocked-stylesheet"
  | "shadow-dom-scoped"
  | "fallback-budget-exhausted"
  | "no-pages-in-corpus";

export interface PageMatch {
  url: string;
  matches: number;
}

export interface AppliesSample {
  property: string;
  sampledCount: number;
  winCount: number;
}

export interface LossReport {
  /** Pages that lose this styling entirely (removed selector, no other rule covers it). */
  pageUrl: string;
  property: string;
  hasFallbackRule: boolean;
}

export interface SelectorImpact {
  kind: "added" | "removed" | "modified";
  selector: string;
  conditionPath: string[];
  hadInteractionState: boolean;

  matches: number;
  matchedPages: PageMatch[];
  applies: AppliesSample[];
  inheritsInto: number;

  confidence: Confidence;
  basis: Basis;
  overlayState: OverlayState;
  reasonCodes: ReasonCode[];

  losses: LossReport[];
}

export interface ImpactAnswer {
  file: string;
  epoch: number;
  baseIndexRevision: string;
  profile: string;
  selectors: SelectorImpact[];
}
