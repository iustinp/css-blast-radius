// Editor ↔ backend protocol (§11): JSON-RPC 2.0, one JSON value per line
// (NDJSON), over the local server's `/rpc` HTTP upgrade (or the older
// per-workspace daemon socket). Every answer carries indexRevision and
// editRevision (§6.8).

import type { Count, FileAnswer, RuleCount } from "../engine/contract.js";
import type { PageDiff } from "../l2/render.js";
import type { DiffBaseKind } from "../daemon/diffBase.js";
import type { TextChange } from "../daemon/documents.js";

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 1;
export const SERVICE_VERSION = "0.3.0";
export const SCHEMA_VERSION = 2;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Version gap in document/change: resend the full text with document/open. */
  resync: -32001,
  /** The request names an editRevision/indexRevision that is no longer current. */
  superseded: -32002,
  /** No ready index: run a capture first. */
  noIndex: -32003,
  unknownDocument: -32004,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type Health = "READY" | "DEGRADED" | "BLOCKED";

export interface InitializeResult {
  protocolMajor: number;
  protocolMinor: number;
  serviceVersion: string;
  schemaVersion: number;
  mode: "local";
  repository: { workspaceRoot: string; siteRoot?: string; baseUrl?: string };
  capabilities: { levels: number[]; capture: boolean; diffBases: DiffBaseKind[] };
  status: IndexStatus;
  /** Server mode only: the project's session, the server's URL and every page group. */
  sessionId?: string;
  serverUrl?: string;
  groups?: GroupInfo[];
}

/** A page group as the editor sees it. */
export interface GroupInfo {
  id: string;
  name: string;
  active: boolean;
  pages: number;
}

export interface InitializeParams {
  workspaceRoot: string;
  /** Linked page group ids (server mode). */
  groups?: string[];
  client?: string;
}

/** Which pages counts cover: the linked active page groups (server mode). */
export interface ScopeStatus {
  linked: boolean;
  groups: Array<{ id: string; name: string; active: boolean }>;
  pages: number;
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
  /** Markup in the workspace changed since capture: answers are marked stale. */
  markupChanged: boolean;
  diffBase: DiffBaseKind;
  capture?: { running: boolean; done: number; total: number; error?: string };
  /** Server mode: the linked page groups counts are limited to. */
  scope?: ScopeStatus;
  /** Plain-language limitations shown in the hover/panel. */
  limitations: string[];
  messages: string[];
}

/** "Your edits": union over every changed file vs the diff base (§7.2). */
export interface SessionTotal {
  editRevision: number;
  indexRevision: number | null;
  diffBase: DiffBaseKind;
  total: Count;
  reasons: string[];
  files: Array<{ file: string; pages: Count; changes: number; open: boolean }>;
}

export interface DocResult {
  answer: FileAnswer;
  session: SessionTotal;
}

export interface OpenParams {
  path: string;
  text: string;
  version: number;
}
export interface ChangeParams {
  path: string;
  version: number;
  changes: TextChange[];
}
export interface SaveParams {
  path: string;
  version?: number;
  text?: string;
}

export interface QueryImpactsParams {
  path?: string;
  scope: "file" | "rules" | "session";
}
export interface RulesResult {
  file: string;
  editRevision: number;
  indexRevision: number | null;
  level: 0 | 1;
  rules: RuleCount[];
}

export type PageSetName = "exact" | "possible" | "unknown";

export interface GetPagesParams {
  /** Omitted: the session total. */
  path?: string;
  /** A ChangeAnswer id; omitted: the whole file. */
  changeId?: string;
  /** Without changeId: the rule starting on this line (1-based), edited or not. */
  line?: number;
  /** "gained"/"lost" for selector, added and removed changes. */
  side?: "pages" | "gained" | "lost";
  set?: PageSetName | "all";
  group?: string;
  offset?: number;
  limit?: number;
  /** Fails with `superseded` when the answer has moved on. */
  editRevision?: number;
}

export interface PageItem {
  url: string;
  set: PageSetName;
  template?: string;
  /** Names of the linked page groups the page is in (server mode). */
  groups?: string[];
}

export interface PagesResult {
  editRevision: number;
  indexRevision: number;
  level: 1;
  count: Count;
  groups: Array<{ name: string; exact: number; possible: number; unknown: number }>;
  total: number;
  offset: number;
  pages: PageItem[];
}

export interface DrilldownParams {
  path: string;
  changeId?: string;
  /** Without changeId: elements of the rule starting on this line. */
  line?: number;
  url: string;
  /** 1: matching elements; 2: also render base vs edited in the stored shell. */
  level: 1 | 2;
  variant?: string;
  screenshots?: boolean;
  editRevision?: number;
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
  basis: "LOCAL_INDEX" | "LOCAL_RENDER" | "LIVE_LOAD";
}

export interface OpenLiveParams {
  path: string;
  changeId?: string;
  line?: number;
  editRevision?: number;
  url: string;
  variant?: string;
  screenshots?: boolean;
}

export interface CaptureParams {
  /** Recapture only these page paths. */
  urls?: string[];
}

export type Box = [number, number, number, number];

/** One page, before and after every current edit of the project (the diff viewer). */
export interface PageDiffView {
  status: "changed" | "unchanged" | "inconclusive";
  reason?: string;
  warnings: string[];
  url: string;
  device: string;
  devices: string[];
  /** true: loaded from the live site (L3); false: the stored copy (L2). */
  live: boolean;
  editRevision: number;
  scannedAt: string;
  edits: Array<{ file: string; changes: number }>;
  /** Screenshot pixels per CSS px. */
  scale: number;
  /** Page width in CSS px. */
  width: number;
  before: string;
  after: string;
  /** Outermost changed elements, top to bottom (page coordinates, CSS px). */
  zones: Array<{ before: Box | null; after: Box | null; label: string; props: Array<{ prop: string; before: string; after: string }> }>;
  changedElements: number;
  movedElements: number;
  timingMs: number;
}

export interface PageDiffParams {
  url: string;
  device?: string;
  live?: boolean;
}

export interface ExternalChangeParams {
  files: string[];
  session: SessionTotal;
}

// Notifications (daemon → client)
export interface RefinedParams extends DocResult {
  /** Rule counts (CodeLens) became more precise too. */
  rules: boolean;
}
export interface CaptureProgressParams {
  done: number;
  total: number;
  url: string;
  ok: boolean;
}
