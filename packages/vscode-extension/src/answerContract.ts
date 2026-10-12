// Answer-contract types mirrored from the backend package (kept in sync
// manually for the MVP instead of sharing a published npm package, to keep
// the extension buildable standalone — see README "Known simplifications").

export type Confidence = "EXACT" | "SAMPLED" | "PARTIAL" | "UNSUPPORTED" | "STALE";
export type Basis = "LOCAL_INDEX" | "LOCAL_PROBE" | "SHARED_INDEX" | "VERIFY_PENDING";
export type OverlayState = "CLEAN" | "OPEN_BUFFER_OVERLAY" | "SAVED_NOT_REINDEXED" | "DOM_STALE";

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
  reasonCodes: string[];
  losses: LossReport[];
}

export interface ImpactAnswer {
  file: string;
  epoch: number;
  baseIndexRevision: string;
  profile: string;
  selectors: SelectorImpact[];
}
