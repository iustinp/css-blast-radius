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
  /** Live-site base on a git branch: only the branch's own changes count. */
  branch?: { name: string | null; mainRef: string; behind: number };
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
  pages: Array<{ url: string; set: PageSetName; template?: string; groups: string[] }>;
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
