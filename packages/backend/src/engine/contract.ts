// Answer contract (§8): every count is exact / possible / unknown, disjoint.
// The true count lies between exact and exact + possible; unknown pages are
// outside current coverage. A zero is only shown with a reason.

import type { ChangeKind } from "../css/diff.js";
import { PageSet } from "../util/pageSet.js";

export interface Count {
  exact: number;
  possible: number;
  unknown: number;
  /** No pending refinement and nothing possible: the count is final. */
  complete: boolean;
}

export interface ChangeAnswer {
  id: string;
  kind: ChangeKind;
  line: number;
  selector?: string;
  oldSelector?: string;
  changedProps?: string[];
  definition?: { kind: string; name: string; change: string };
  pages: Count;
  gained?: Count;
  lost?: Count;
  /** @media/@supports/@container… and dropped interaction states. */
  conditions: string[];
  reasons: string[];
  hint?: string;
  detail?: string;
}

export interface RuleCount {
  line: number;
  endLine: number;
  selector: string;
  pages: Count;
  conditions: string[];
  reasons: string[];
}

export interface Freshness {
  revision: number;
  capturedAt: string;
  ageMs: number;
  /** The diff base differs from the stylesheet text that was captured. */
  stale: boolean;
}

export interface FileAnswer {
  queryId: string;
  level: 0 | 1;
  indexRevision: number | null;
  editRevision: number;
  file: string;
  diffBase: string;
  /** The text doesn't parse right now; the answer is for the last valid text. */
  editing: boolean;
  total: Count;
  totalReasons: string[];
  changes: ChangeAnswer[];
  mapping: { mapped: boolean; urls: string[]; linkedPages: number };
  freshness: Freshness | null;
  basis: "LOCAL_INDEX";
  timingMs: number;
}

/** Three disjoint page sets behind a Count. */
export class Sets {
  constructor(
    public exact: PageSet,
    public possible: PageSet,
    public unknown: PageSet,
  ) {}

  static empty(size: number): Sets {
    return new Sets(PageSet.empty(size), PageSet.empty(size), PageSet.empty(size));
  }

  /** Restores disjointness: exact wins over possible, possible over unknown. */
  normalize(): this {
    this.possible.andNotInPlace(this.exact);
    this.unknown.andNotInPlace(this.exact).andNotInPlace(this.possible);
    return this;
  }

  orInPlace(o: Sets): this {
    this.exact.orInPlace(o.exact);
    this.possible.orInPlace(o.possible);
    this.unknown.orInPlace(o.unknown);
    return this.normalize();
  }

  clone(): Sets {
    return new Sets(this.exact.clone(), this.possible.clone(), this.unknown.clone());
  }

  /** Pages of `this` not reached by `other` (gained = new − old). */
  minus(other: Sets): Sets {
    const reachedOther = other.exact.or(other.possible);
    const exact = this.exact.andNot(reachedOther);
    const possible = this.exact.or(this.possible).andNot(other.exact).andNotInPlace(exact);
    const unknown = this.unknown.andNot(other.exact).andNotInPlace(other.unknown);
    return new Sets(exact, possible, unknown).normalize();
  }

  get size(): number {
    return this.exact.size;
  }

  any(): boolean {
    return !this.exact.isEmpty() || !this.possible.isEmpty() || !this.unknown.isEmpty();
  }

  count(pending = false): Count {
    const possible = this.possible.count();
    return {
      exact: this.exact.count(),
      possible,
      unknown: this.unknown.count(),
      complete: possible === 0 && !pending,
    };
  }
}

export const REASON = {
  noEffectiveChange: "no-effective-change",
  neverMatches: "selector-never-matches",
  notLinked: "stylesheet-not-linked",
  notMapped: "stylesheet-not-mapped",
  /** Nothing linked: the project has no page groups to count. */
  noScope: "no-linked-groups",
  /** The stylesheet is loaded only by pages outside the linked groups. */
  outsideScope: "not-in-linked-groups",
  noIndex: "index-missing",
  stale: "index-stale",
  tokenNeverSeen: (t: string) => `token-never-seen:${t}`,
  addedByJs: (t: string) => `added-by-js:${t}`,
  newSelector: "new-selector",
  unsupported: (f: string) => `matcher-unsupported:${f}`,
  upperBound: "unknown-syntax-upper-bound",
  unanalyzable: "selector-not-analyzable",
  invalid: (why: string) => `invalid-selector:${why}`,
  captureFailed: (n: number) => `capture-failed:${n}`,
  customPropertyScope: "custom-property-scope",
  customPropertyUnused: "custom-property-unused",
  definitionUnused: "definition-unused",
  global: (kind: string) => `global-change:${kind}`,
  chromiumRejects: "chromium-rejects-selector",
} as const;

/** Display form of a token: c:foo → .foo, i:x → #x, a:href → [href], t:li → li. */
export function tokenLabel(t: string): string {
  const v = t.slice(2);
  switch (t[0]) {
    case "c":
      return "." + v;
    case "i":
      return "#" + v;
    case "a":
      return `[${v}]`;
    default:
      return v;
  }
}
