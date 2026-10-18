// Wire types for the daemon protocol (mirrors packages/backend/src/rpc/protocol.ts
// and engine/contract.ts; the extension is CommonJS and ships without the backend).

export const PROTOCOL_MAJOR = 1;

export const ERR = {
  parse: -32700,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  resync: -32001,
  superseded: -32002,
  noIndex: -32003,
  unknownDocument: -32004,
} as const;

export type DiffBaseKind = "HEAD" | "saved" | "session" | "production";
export type Health = "READY" | "DEGRADED" | "BLOCKED";

export interface Count {
  exact: number;
  possible: number;
  unknown: number;
  complete: boolean;
}

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

export interface ChangeAnswer {
  id: string;
  kind: ChangeKind;
  /** 1-based line in the current text. */
  line: number;
  selector?: string;
  oldSelector?: string;
  changedProps?: string[];
  definition?: { kind: string; name: string; change: string };
  pages: Count;
  gained?: Count;
  lost?: Count;
  conditions: string[];
  reasons: string[];
  hint?: string;
  detail?: string;
}

/** analysis/getChange: one edit's rule, every declaration in file order (newer servers). */
export interface ChangeDetail {
  editRevision: number;
  path: string;
  id: string;
  kind: ChangeKind;
  /** Where to adjust it (1-based): the first changed declaration, else the rule. */
  line: number;
  column?: number;
  rule?: {
    selector: string;
    oldSelector?: string;
    conditions: string[];
    oldConditions?: string[];
    removed: boolean;
    decls: Array<{ text: string; state: "changed" | "same" | "removed"; was?: string; line?: number; column?: number }>;
    line: number;
    endLine: number;
  };
  /** Edits outside style rules: @font-face, @keyframes, layer order… */
  summary?: string;
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
  stale: boolean;
}

export interface FileAnswer {
  queryId: string;
  level: 0 | 1;
  indexRevision: number | null;
  editRevision: number;
  file: string;
  diffBase: string;
  editing: boolean;
  total: Count;
  totalReasons: string[];
  changes: ChangeAnswer[];
  mapping: { mapped: boolean; urls: string[]; linkedPages: number };
  freshness: Freshness | null;
  basis: string;
  timingMs: number;
}

export interface IndexStatus {
  health: Health;
  ready: boolean;
  indexRevision: number | null;
  capturedAt?: string;
  pages: number;
  okPages: number;
  failedPages: number;
  variants: string[];
  markupChanged: boolean;
  diffBase: DiffBaseKind;
  /** In a git repository (servers before protocol 1.3 leave it out). */
  git?: boolean;
  capture?: { running: boolean; done: number; total: number; error?: string };
  limitations: string[];
  messages: string[];
  scope: { linked: boolean; groups: Array<{ id: string; name: string; active: boolean }>; pages: number };
}

export interface GroupInfo {
  id: string;
  name: string;
  active: boolean;
  pages: number;
}

export interface InitializeResult {
  protocolMajor: number;
  protocolMinor: number;
  serviceVersion: string;
  schemaVersion: number;
  mode: "local";
  repository: { workspaceRoot: string; siteRoot?: string; baseUrl?: string };
  capabilities: { levels: number[]; capture: boolean; diffBases: DiffBaseKind[] };
  status: IndexStatus;
  sessionId: string;
  /** "This session" starts now: open files' current text (saved or not) is its start. */
  sessionStarted?: boolean;
  serverUrl: string;
  groups: GroupInfo[];
}

export interface SessionTotal {
  editRevision: number;
  indexRevision: number | null;
  diffBase: DiffBaseKind;
  total: Count;
  reasons: string[];
  files: Array<{ file: string; pages: Count; changes: number; open: boolean }>;
  /**
   * Live-site base on a git branch, `behind` the deployed one: its newer
   * changes count only when `mainShown` (missing before protocol 1.3).
   */
  branch?: { name: string | null; mainRef: string; behind: number; mainShown?: boolean };
}

/** An edit the live site doesn't have yet, with the lines of the current text it consists of. */
export interface LiveEdit extends ChangeAnswer {
  /** 1-based, inclusive. */
  ranges: Array<[number, number]>;
}

/** analysis/liveEdits (protocol 1.5): every CSS file that differs from the live site, whatever the tab. */
export interface LiveEditsResult {
  editRevision: number;
  indexRevision: number | null;
  files: Array<{ file: string; open: boolean; pages: Count; edits: LiveEdit[] }>;
  branch?: SessionTotal["branch"];
}

/** analysis/liveOriginal: the file without the edits the live site doesn't have (null: not scanned). */
export interface LiveOriginal {
  path: string;
  text: string | null;
}

export interface DocResult {
  answer: FileAnswer;
  session: SessionTotal;
}

export interface RefinedParams extends DocResult {
  rules: boolean;
}

export interface RulesResult {
  file: string;
  editRevision: number;
  indexRevision: number | null;
  level: 0 | 1;
  rules: RuleCount[];
}

export type PageSetName = "exact" | "possible" | "unknown";

/**
 * The edits picked in the panel (session/setSelection); absent: every edit.
 * A file without changeIds: all of its edits, new ones included.
 */
export type EditSelection = Array<{ path: string; changeIds?: string[] }>;

/** What a page list is about: the session, a file, one change, or one rule. */
export interface PagesTarget {
  path?: string;
  changeId?: string;
  line?: number;
  side?: "pages" | "gained" | "lost";
  /** Sides the change has (selector/added/removed changes); the panel offers these. */
  sides?: Array<"pages" | "gained" | "lost">;
  title: string;
}

export interface PagesResult {
  editRevision: number;
  indexRevision: number;
  level: 1;
  count: Count;
  groups: Array<{ name: string; exact: number; possible: number; unknown: number }>;
  total: number;
  offset: number;
  pages: Array<{ url: string; set: PageSetName; template?: string; groups: string[]; impact?: PageImpact }>;
  assessment?: AssessmentSummary;
}

/** One page checked visually with every current edit, on each device (L2, no screenshots). */
export interface PageImpact {
  /** changed: some device looks different; inconclusive: none does, but one couldn't be checked. */
  status: "changed" | "unchanged" | "inconclusive";
  /** Elements whose own styles change, summed over devices. */
  changed: number;
  /** Elements that only move or resize, summed over devices. */
  moved: number;
  devices: Array<{ name: string; status: "changed" | "unchanged" | "inconclusive"; changed: number; moved: number; reason?: string }>;
  reason?: string;
}

/** The impact assessment of a page list (PagesResult.assessment). */
export interface AssessmentSummary {
  running: boolean;
  /** Progress of the running assessment (every list it was asked for). */
  done: number;
  total: number;
  /** Pages of this list with a result, and without one. */
  assessed: number;
  pending: number;
  /** Pages of this list that look different, and the most changed elements on one of them. */
  changed: number;
  maxChanged: number;
}

/** analysis/assess result and analysis/assessProgress notification. */
export interface AssessProgress {
  editRevision: number;
  indexRevision: number | null;
  running: boolean;
  done: number;
  total: number;
  /** An edit or a new page scan made the results out of date. */
  cancelled?: boolean;
}

export interface ElementDiff {
  path: string;
  kind: "changed" | "moved" | "resized" | "appeared" | "disappeared";
  props: Array<{ prop: string; before: string; after: string }>;
  box?: { before: number[] | null; after: number[] | null };
}

export interface PageDiff {
  url: string;
  variant: string;
  mode: "shell" | "live";
  status: "changed" | "unchanged" | "inconclusive";
  reason?: string;
  warnings: string[];
  changedElements: number;
  movedElements: number;
  elements: ElementDiff[];
  truncated: boolean;
  comparedProps: string[];
  screenshots?: { before: string; after: string };
  timingMs: number;
}

export interface SelectorElements {
  selector: string;
  key: string;
  dropped: string[];
  variants: Array<{ variant: string; count: number; elements: string[] }>;
  error?: string;
}

export interface DrilldownResult {
  editRevision: number;
  indexRevision: number;
  url: string;
  template?: string;
  capturedAt: string;
  level: 1 | 2 | 3;
  matches: SelectorElements[];
  render?: PageDiff;
  basis: string;
}

export interface CaptureProgressParams {
  done: number;
  total: number;
  url: string;
  ok: boolean;
}
