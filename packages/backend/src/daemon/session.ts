// One workspace session (§10.1): editor documents, diff base, the in-memory
// L0 index, L1 refinement in workers, L2/L3 renders and capture. Answers are
// computed synchronously from bitmaps; anything slower is pushed later as a
// notification for the same (indexRevision, editRevision) pair (§6.8).

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import fg from "fast-glob";
import { loadConfig, type CbrConfig } from "../config.js";
import { browserModel, parseStylesheet, type StyleRule, type StylesheetModel } from "../css/model.js";
import { appliedFilter, changeIds, diffModels, type CssChange } from "../css/diff.js";
import { describeChange } from "../css/describe.js";
import { partialText } from "../css/partial.js";
import { REASON, Sets, type Count, type FileAnswer } from "../engine/contract.js";
import { L0Engine, L1Cache, type Analysis, type PendingWork } from "../engine/l0.js";
import { SiteIndex } from "../index/siteIndex.js";
import { Store, type PageRow, type VariantInfo } from "../index/store.js";
import { L1Pool } from "../l1/pool.js";
import { DEFAULT_PROPS, Renderer, type PageDiff, type RenderTarget, type SheetEdit } from "../l2/render.js";
import { Capturer } from "../capture/capture.js";
import { PageSet } from "../util/pageSet.js";
import { Doc, sha256, type CurrentModel, type TextChange } from "./documents.js";
import { DIFF_BASES, Git, readText, type BaseText, type BranchPoint, type DiffBaseKind } from "./diffBase.js";
import { SheetMatcher } from "./sheetMatch.js";
import {
  ERR,
  RpcError,
  type AssessmentSummary,
  type AssessParams,
  type AssessProgress,
  type CaptureParams,
  type ChangeDetail,
  type DocResult,
  type DrilldownParams,
  type DrilldownResult,
  type EditSelection,
  type GetPagesParams,
  type IndexStatus,
  type OpenLiveParams,
  type PageDiffParams,
  type PageDiffView,
  type PageImpact,
  type PageItem,
  type PageSetName,
  type PagesResult,
  type RulesResult,
  type ScopeStatus,
  type SelectorElements,
  type SessionTotal,
  type SetSelectionResult,
} from "../rpc/protocol.js";

/** A linked page group (server mode): counts cover the pages of the active ones. */
export interface ScopeGroup {
  id: string;
  name: string;
  active: boolean;
  urls: string[];
}

/** Resources a server shares between its project sessions. */
export interface SharedResources {
  cfg: CbrConfig;
  store: Store;
  pool: L1Pool;
  renderer: () => Renderer;
  /** The current index, loaded once for every project (server mode). */
  index?: () => SiteIndex | undefined;
}

export interface SessionOptions {
  workspaceRoot: string;
  siteRoot?: string;
  baseUrl?: string;
  dataDir?: string;
  /** L1 worker threads; 0 = in-process. */
  l1Workers?: number;
  /** Watch the workspace for CSS/markup changes (default true). */
  watch?: boolean;
  diffBase?: DiffBaseKind;
  /** Server mode: config, store, L1 pool and renderer owned by the server. */
  shared?: SharedResources;
  /** Server mode: the linked page groups (undefined: every captured page counts). */
  scope?: ScopeGroup[];
}

interface FileResult {
  stamp: string;
  cur: CurrentModel;
  changes: CssChange[];
  /** Every change from the base, including those the live site already has (dropped from `changes` on a branch). */
  allChanges: CssChange[];
  analysis?: Analysis;
  answer: FileAnswer;
}

interface DetailSnapshot {
  r: FileResult;
  editRevision: number;
  base?: BaseText;
  baseModel: StylesheetModel;
}

interface FileState {
  path: string;
  doc?: Doc;
  /** Closed files: the text on disk (undefined: deleted). */
  diskText?: string;
  base?: BaseText;
  baseModel?: StylesheetModel;
  /** Branch on the live-site base: drops changes the site already has. */
  applied?: (changes: CssChange[], cur: StylesheetModel) => CssChange[];
  /** Bumped whenever the text or the base changes. */
  version: number;
  /** editRevision of the last text/base change. */
  editRevision: number;
  result?: FileResult;
}

/** The selected edits as the visual diff applies them. */
interface RenderEdits {
  edits: SheetEdit[];
  list: PageDiffView["edits"];
  /** Edits in every changed file, selected or not. */
  total: number;
  changes: CssChange[];
  models: StylesheetModel[];
  warnings: string[];
}

/** Assessment results kept for this many (index, edits, selection) states, so toggling edits back is instant. */
const ASSESS_KEEP = 8;

/** A background impact assessment for one (index revision, edit revision, selection). */
interface AssessJob {
  key: string;
  editRevision: number;
  indexRevision: number | null;
  queue: string[];
  queued: Set<string>;
  done: number;
  total: number;
  workers: number;
  cancelled: boolean;
  emittedAt: number;
  prep?: Promise<RenderEdits>;
}

/** Background renders at once (the renderer runs 3; interactive ones go first). */
const ASSESS_WORKERS = 3;

const LIMITATIONS = [
  "Pages are analyzed in their captured states (profiles × recipes); other states are not seen.",
  "Interaction states (:hover, :focus…) are assumed reachable and listed as conditions.",
  "Shadow DOM and iframe content are not captured.",
  "Pages added to the site since the last capture are not counted.",
];

const MAX_SNAPSHOT_FILES = 3000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** The diff viewer's empty page, per comparison (the live site's depends on the branch). */
const NO_CHANGES: Partial<Record<DiffBaseKind, string>> = {
  HEAD: "You have no uncommitted CSS changes right now.",
  session: "You have no CSS changes since your editor window opened.",
  saved: "You have no unsaved CSS changes right now.",
};

export class Session extends EventEmitter {
  readonly cfg: CbrConfig;
  readonly store: Store;
  index?: SiteIndex;
  engine?: L0Engine;
  l1?: L1Cache;
  readonly pool: L1Pool;
  private renderer?: Renderer;
  private git?: Git;
  /** Production base on a branch: where it left the deployed branch (§7.2). */
  private branch?: BranchPoint;
  private branchLoad?: Promise<BranchPoint | undefined>;
  private gitMoved = false;
  /** Live-site base: also count the deployed branch's newer changes (a plain comparison with the site). */
  private mainChanges = false;
  diffBase: DiffBaseKind;
  editRevision = 0;
  private readonly files = new Map<string, FileState>();
  private readonly rulesPending = new Set<string>();
  private l1gen = 0;
  private l1Queue: PendingWork = new Map();
  private l1Tried = new Map<string, PageSet>();
  private l1Running?: Promise<void>;
  private l1Error?: string;
  private readonly sessionStart = new Map<string, string>();
  private sessionSnapshotComplete = false;
  private markupChanged = false;
  private watcher?: FSWatcher;
  private refreshTimer?: NodeJS.Timeout;
  private captureState?: { running: boolean; done: number; total: number; error?: string };
  private assessed = new Map<string, Map<string, PageImpact>>();
  /** The edits picked in the editor's panel (undefined: every edit). */
  private selection?: EditSelection;
  private selectionKey = "";
  selectionRevision = 0;
  private assessJob?: AssessJob;
  private queryN = 0;
  private readonly messages: string[] = [];
  private matcher: SheetMatcher;
  private scopeGroups?: ScopeGroup[];
  /** Active linked groups → their pages in the current index. */
  private scopeSets?: Map<string, PageSet>;
  private scopeGen = 0;
  /** CSS files found in the workspace by the last scan. */
  private cssFiles: string[] = [];

  private constructor(readonly opts: SessionOptions) {
    super();
    if (opts.shared) {
      this.cfg = { ...opts.shared.cfg, workspaceRoot: resolve(opts.workspaceRoot) };
      this.store = opts.shared.store;
      this.pool = opts.shared.pool;
    } else {
      this.cfg = loadConfig(opts.workspaceRoot, { siteRoot: opts.siteRoot, baseUrl: opts.baseUrl, dataDir: opts.dataDir });
      this.store = new Store(this.cfg.dataDir);
      this.pool = new L1Pool({ blobDir: this.store.blobDir, workers: opts.l1Workers });
    }
    this.diffBase = opts.diffBase ?? "HEAD";
    this.scopeGroups = opts.scope;
    this.matcher = new SheetMatcher(this.cfg, undefined);
  }

  static async create(opts: SessionOptions): Promise<Session> {
    const s = new Session(opts);
    await s.attach();
    return s;
  }

  private async attach(): Promise<void> {
    this.git = await Git.find(this.cfg.workspaceRoot);
    if (!this.git && this.diffBase === "HEAD") this.messages.push("Not a git repository: HEAD diff base falls back to the last save.");
    this.loadIndex();
    await this.snapshotSession();
    await this.refreshClosed();
    if (this.opts.watch !== false) this.startWatching();
  }

  // ---------------------------------------------------------------- index

  private loadIndex(): void {
    const idx = this.opts.shared?.index ? this.opts.shared.index() : SiteIndex.load(this.store);
    this.index = idx;
    this.matcher = new SheetMatcher(this.cfg, idx);
    if (!idx) {
      this.engine = undefined;
      this.l1 = undefined;
      this.scopeSets = undefined;
      return;
    }
    this.l1 = new L1Cache(idx.revision.id, idx.size);
    this.engine = new L0Engine(idx, this.cfg, this.l1, { keysFor: (f) => this.matcher.keysFor(f), scope: this.computeScope() });
    this.l1Queue = new Map();
    this.l1Tried = new Map();
    this.l1gen++;
    // Production bases come from the capture: they change with the revision.
    if (this.diffBase === "production") for (const f of this.files.values()) f.base = undefined;
    this.pool.warm(idx).catch((err) => this.degrade(`L1 workers: ${err?.message ?? err}`));
  }

  /** Pages of the active linked groups in the current index (undefined: no scope). */
  private computeScope(): PageSet | undefined {
    const idx = this.index;
    if (!this.scopeGroups || !idx) {
      this.scopeSets = undefined;
      return undefined;
    }
    const sets = new Map<string, PageSet>();
    const union = PageSet.empty(idx.size);
    for (const g of this.scopeGroups) {
      if (!g.active) continue;
      const set = PageSet.empty(idx.size);
      for (const u of g.urls) {
        const id = idx.byUrl.get(u);
        if (id !== undefined) set.add(id);
      }
      set.andInPlace(idx.all);
      sets.set(g.name, set);
      union.orInPlace(set);
    }
    this.scopeSets = sets;
    return union;
  }

  /** Server mode: the page groups this project is linked to (undefined: every page). */
  setScope(groups: ScopeGroup[] | undefined): SessionTotal {
    this.scopeGroups = groups;
    this.scopeGen++;
    this.engine?.setScope(this.computeScope());
    this.l1Tried = new Map();
    this.emit("status", this.status());
    this.publishOpenDocs();
    return this.sessionTotal();
  }

  /** Server mode: the site settings changed (the index updates on the next scan). */
  reconfigure(cfg: CbrConfig): void {
    Object.assign(this.cfg, { ...cfg, workspaceRoot: this.cfg.workspaceRoot });
    this.matcher = new SheetMatcher(this.cfg, this.index);
    for (const f of this.files.values()) this.touch(f);
    this.publishOpenDocs();
  }

  scopeStatus(): ScopeStatus | undefined {
    if (!this.scopeGroups) return undefined;
    return {
      linked: this.scopeGroups.length > 0,
      groups: this.scopeGroups.map((g) => ({ id: g.id, name: g.name, active: g.active })),
      pages: this.engine?.scoped.count() ?? 0,
    };
  }

  private degrade(msg: string): void {
    this.l1Error = msg;
    this.emit("degraded", { message: msg });
  }

  status(): IndexStatus {
    const idx = this.index;
    const messages = [...this.messages];
    if (!idx) messages.push("No index yet: run “CSS Blast Radius: Capture Site”.");
    if (this.l1Error) messages.push(this.l1Error);
    if (this.markupChanged) messages.push("Markup changed since the last capture: counts describe the captured pages.");
    return {
      health: !idx ? "BLOCKED" : this.l1Error ? "DEGRADED" : "READY",
      ready: !!idx,
      indexRevision: idx?.revision.id ?? null,
      capturedAt: idx?.revision.createdAt,
      pages: idx?.size ?? 0,
      okPages: idx?.ok.count() ?? 0,
      failedPages: idx?.failed.count() ?? 0,
      variants: idx?.variants.map((v) => v.name) ?? [],
      markupChanged: this.markupChanged,
      diffBase: this.diffBase,
      git: !!this.git,
      capture: this.captureState ? { ...this.captureState } : undefined,
      scope: this.scopeStatus(),
      limitations: LIMITATIONS,
      messages,
    };
  }

  // ------------------------------------------------------------ documents

  private state(path: string): FileState {
    const p = resolve(path);
    let f = this.files.get(p);
    if (!f) this.files.set(p, (f = { path: p, version: 0, editRevision: this.editRevision }));
    return f;
  }

  private touch(f: FileState): void {
    f.version++;
    f.editRevision = ++this.editRevision;
  }

  async open(path: string, text: string, version: number, atStart = false): Promise<DocResult> {
    const f = this.state(path);
    f.doc = new Doc(f.path, text, version, readText(f.path));
    f.diskText = undefined;
    if (atStart) {
      // Restored unsaved edits were made before this session.
      this.sessionStart.set(f.path, text);
      if (this.diffBase === "session") f.base = undefined;
    }
    this.touch(f);
    await this.ensureBase(f);
    return this.docResult(f);
  }

  async change(path: string, version: number, changes: TextChange[]): Promise<DocResult> {
    const f = this.files.get(resolve(path));
    if (!f?.doc) throw new RpcError(ERR.unknownDocument, `document not open: ${path}`);
    f.doc.change(version, changes);
    this.touch(f);
    await this.ensureBase(f);
    return this.docResult(f);
  }

  async save(path: string, text?: string): Promise<DocResult> {
    const f = this.files.get(resolve(path));
    if (!f?.doc) throw new RpcError(ERR.unknownDocument, `document not open: ${path}`);
    f.doc.save(text);
    if (this.diffBase === "saved") f.base = undefined;
    this.touch(f);
    await this.ensureBase(f);
    return this.docResult(f);
  }

  async close(path: string): Promise<SessionTotal> {
    const f = this.files.get(resolve(path));
    if (f) {
      f.doc = undefined;
      this.files.delete(f.path);
      this.rulesPending.delete(f.path);
      this.editRevision++;
      await this.refreshClosed();
    }
    return this.sessionTotal();
  }

  async setDiffBase(kind: DiffBaseKind, mainChanges?: boolean): Promise<SessionTotal> {
    if (!DIFF_BASES.includes(kind)) throw new RpcError(ERR.invalidParams, `unknown diff base: ${kind}`);
    this.diffBase = kind;
    if (mainChanges !== undefined) this.mainChanges = mainChanges;
    this.branchLoad = undefined;
    return this.rebase();
  }

  /**
   * "This session" starts over for a new editor window: the CSS on disk now
   * (and the window's files as they reopen) is its start. No window is
   * attached, so files the last one left open are closed.
   */
  async restartSession(): Promise<SessionTotal> {
    for (const f of [...this.files.values()]) {
      if (!f.doc) continue;
      this.files.delete(f.path);
      this.rulesPending.delete(f.path);
    }
    this.editRevision++;
    this.sessionStart.clear();
    await this.snapshotSession();
    return this.rebase();
  }

  private async rebase(): Promise<SessionTotal> {
    for (const f of this.files.values()) {
      f.base = undefined;
      this.touch(f);
    }
    await this.refreshClosed();
    for (const f of this.files.values()) await this.ensureBase(f);
    this.publishOpenDocs();
    return this.sessionTotal();
  }

  // ------------------------------------------------------------ diff base

  private async ensureBase(f: FileState): Promise<void> {
    if (f.base) return;
    f.base = await this.loadBase(f.path);
    f.baseModel = browserModel(f.base.text ?? "");
    f.applied = f.base.live !== undefined ? appliedFilter(browserModel(f.base.live)) : undefined;
    f.version++;
  }

  private async loadBase(path: string): Promise<BaseText> {
    switch (this.diffBase) {
      case "HEAD":
        if (!this.git) return { text: readText(path), kind: "saved", note: "not a git repository" };
        return { text: await this.git.show(path), kind: "HEAD" };
      case "saved":
        return { text: readText(path), kind: "saved" };
      case "session": {
        let note: string | undefined;
        if (!this.sessionStart.has(path) && !this.sessionSnapshotComplete) {
          const t = readText(path);
          if (t !== undefined) this.sessionStart.set(path, t);
          note = "not in the session snapshot (too much CSS): compared with the file as first opened";
        }
        return { text: this.sessionStart.get(path), kind: "session", note };
      }
      case "production": {
        const hash = this.sheetHashes(path)[0];
        if (hash) {
          const live = this.store.getBlob(hash).toString("utf8");
          // On a branch, diff against where it left the deployed branch: newer commits there aren't "my edits".
          const bp = await this.branchPoint();
          const text = bp && !this.mainChanges ? await this.git!.show(path, bp.mergeBase) : undefined;
          if (text !== undefined) return { text, kind: "production", live };
          return { text: live, kind: "production" };
        }
        if (this.git) return { text: await this.git.show(path), kind: "HEAD", note: "no captured stylesheet for this file" };
        return { text: readText(path), kind: "saved", note: "no captured stylesheet for this file" };
      }
    }
  }

  /** Where the checked-out branch left the deployed branch (production base only). */
  private branchPoint(): Promise<BranchPoint | undefined> {
    if (this.diffBase !== "production" || !this.git) return Promise.resolve((this.branch = undefined));
    return (this.branchLoad ??= this.git.branchPoint().then((bp) => (this.branch = bp)));
  }

  private cssDirs(): string[] {
    const dirs = this.cfg.stylesheets.map((m) => m.dir);
    return dirs.length ? dirs : [this.cfg.workspaceRoot];
  }

  private async listCss(): Promise<string[]> {
    const out: string[] = [];
    for (const dir of this.cssDirs()) {
      if (!existsSync(dir)) continue;
      const found = await fg("**/*.css", { cwd: dir, absolute: true, ignore: ["**/node_modules/**", "**/.git/**"], suppressErrors: true });
      out.push(...found.map((f) => resolve(f)).filter((f) => !f.startsWith(this.cfg.dataDir)));
    }
    this.cssFiles = [...new Set(out)];
    return this.cssFiles;
  }

  /** Workspace CSS files per site stylesheet they were matched to (the setup page lists them). */
  sheetFiles(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const f of this.cssFiles) {
      for (const key of this.matcher.keysFor(f)) {
        let list = out.get(key);
        if (!list) out.set(key, (list = []));
        list.push(f);
      }
    }
    return out;
  }

  /** Captured content hashes of the stylesheet(s) a workspace file is served as. */
  private sheetHashes(path: string): string[] {
    const idx = this.index;
    if (!idx) return [];
    const out: string[] = [];
    for (const key of this.matcher.keysFor(path)) {
      const h = idx.sheets.get(key)?.hash;
      if (h) out.push(h);
    }
    return out;
  }

  private async snapshotSession(): Promise<void> {
    const files = await this.listCss();
    let bytes = 0;
    let complete = files.length <= MAX_SNAPSHOT_FILES;
    for (const f of files.slice(0, MAX_SNAPSHOT_FILES)) {
      const t = readText(f);
      if (t === undefined) continue;
      // Over the cap: skip this file (it's read when first opened, with a note) but keep the smaller ones.
      if (bytes + t.length > MAX_SNAPSHOT_BYTES) {
        complete = false;
        continue;
      }
      bytes += t.length;
      this.sessionStart.set(f, t);
    }
    this.sessionSnapshotComplete = complete;
  }

  /** Closed files that differ from the diff base also count as "my edits". */
  private async refreshClosed(): Promise<void> {
    let changed: string[] = [];
    switch (this.diffBase) {
      case "HEAD":
        changed = this.git ? await this.git.changedCss(this.cssDirs()) : [];
        break;
      case "saved":
        break;
      case "session": {
        const now = await this.listCss();
        const seen = new Set(now);
        changed = now.filter((f) => this.sessionStart.has(f) ? this.sessionStart.get(f) !== readText(f) : this.sessionSnapshotComplete);
        for (const f of this.sessionStart.keys()) if (!seen.has(f)) changed.push(f);
        break;
      }
      case "production": {
        if (!this.index) break;
        const all = await this.listCss();
        const point = await this.branchPoint();
        const bp = this.mainChanges ? undefined : point;
        // On a branch: the files it changed, unless the site already has that exact content.
        const files = bp ? await this.git!.changedSince(bp.mergeBase, this.cssDirs()) : all;
        for (const f of files) {
          const hashes = this.sheetHashes(f);
          if (!hashes.length) continue;
          const t = readText(f);
          if (t === undefined ? bp !== undefined : !hashes.includes(sha256(t))) changed.push(f);
        }
        break;
      }
    }
    const want = new Set(changed.map((f) => resolve(f)));
    for (const [p, f] of this.files) {
      if (f.doc) continue;
      if (!want.has(p)) this.files.delete(p);
    }
    for (const p of want) {
      const existing = this.files.get(p);
      if (existing?.doc) continue;
      const f = existing ?? this.state(p);
      const disk = readText(p);
      if (!existing || f.diskText !== disk) {
        f.diskText = disk;
        this.touch(f);
      }
      await this.ensureBase(f);
    }
  }

  // ------------------------------------------------------------- analysis

  private stamp(f: FileState, pendingSensitive: boolean): string {
    return [f.version, this.index?.revision.id ?? "-", this.diffBase, this.markupChanged ? 1 : 0, this.scopeGen, pendingSensitive ? this.l1gen : 0].join("|");
  }

  private current(f: FileState): CurrentModel {
    if (f.doc) return f.doc.current();
    const text = f.diskText ?? "";
    const m = parseStylesheet(text);
    const notes = m.parseError ? [`parse-error:line ${m.parseError.line ?? "?"}`] : [];
    for (const r of m.rules) if (r.invalid) notes.push(`invalid-on-save:line ${r.line}`);
    return { model: browserModel(text), text, editing: false, notes };
  }

  private resultFor(f: FileState, level: 0 | 1 = 0): FileResult {
    const prev = f.result;
    if (prev && prev.stamp === this.stamp(f, (prev.analysis?.pending.size ?? 0) > 0)) return prev;
    const t0 = performance.now();
    const cur = this.current(f);
    const baseModel = f.baseModel ?? parseStylesheet("");
    const lines = cur.text.split("\n").length;
    const allChanges = diffModels(baseModel, cur.model, lines);
    const changes = f.applied ? f.applied(allChanges, cur.model) : allChanges;
    const reasons = new Set<string>(cur.notes);
    if (f.base?.note) reasons.add(`diff-base:${f.base.kind} (${f.base.note})`);
    const ans: FileAnswer = {
      queryId: `q-${++this.queryN}`,
      level,
      indexRevision: this.index?.revision.id ?? null,
      editRevision: f.editRevision,
      file: f.path,
      diffBase: f.base?.kind ?? this.diffBase,
      editing: cur.editing,
      total: { exact: 0, possible: 0, unknown: 0, complete: false },
      totalReasons: [],
      changes: [],
      mapping: { mapped: this.matcher.keysFor(f.path).length > 0, urls: this.matcher.keysFor(f.path), linkedPages: 0 },
      freshness: null,
      basis: "LOCAL_INDEX",
      timingMs: 0,
    };
    let analysis: Analysis | undefined;
    if (!this.engine) {
      reasons.add(REASON.noIndex);
      if (changes.length === 0) reasons.add(REASON.noEffectiveChange);
      const ids = changeIds(changes);
      ans.changes = changes.map((c, i) => ({
        id: ids[i],
        kind: c.kind,
        line: c.line,
        selector: (c.after ?? c.before)?.selectorText,
        changedProps: c.changedProps,
        pages: { exact: 0, possible: 0, unknown: 0, complete: false },
        conditions: [],
        reasons: [REASON.noIndex],
      }));
    } else {
      analysis = this.engine.analyze(f.path, baseModel, cur.model, changes);
      ans.changes = analysis.changes;
      ans.total = analysis.totalCount;
      for (const r of analysis.totalReasons) reasons.add(r);
      ans.mapping = { mapped: analysis.candidates.mapped, urls: analysis.candidates.urls, linkedPages: analysis.candidates.pages.count() };
      ans.freshness = this.engine.freshness(analysis.candidates, f.base?.live ?? f.base?.text);
      if (this.markupChanged) ans.freshness.stale = true;
      if (ans.freshness.stale) reasons.add(REASON.stale);
    }
    ans.totalReasons = [...reasons];
    ans.timingMs = Math.round((performance.now() - t0) * 100) / 100;
    const res: FileResult = { stamp: this.stamp(f, (analysis?.pending.size ?? 0) > 0), cur, changes, allChanges, analysis, answer: ans };
    f.result = res;
    if (analysis?.pending.size) this.scheduleL1(analysis.pending);
    return res;
  }

  private docResult(f: FileState): DocResult {
    return { answer: this.resultFor(f).answer, session: this.sessionTotal() };
  }

  /** Union of every changed file's pages: the status bar total. */
  sessionTotal(): SessionTotal {
    const size = this.index?.size ?? 0;
    const total = Sets.empty(size);
    const reasons = new Set<string>();
    const files: SessionTotal["files"] = [];
    let pending = false;
    for (const f of this.files.values()) {
      const r = this.resultFor(f);
      if (r.changes.length === 0) continue;
      files.push({ file: f.path, pages: r.answer.total, changes: r.changes.length, open: !!f.doc });
      if (r.analysis) {
        total.orInPlace(r.analysis.total);
        if (r.analysis.pending.size) pending = true;
      }
      for (const x of r.answer.totalReasons) reasons.add(x);
    }
    if (files.length === 0) reasons.add(REASON.noEffectiveChange);
    if (!this.index) reasons.add(REASON.noIndex);
    const count: Count = this.index ? total.count(pending) : { exact: 0, possible: 0, unknown: 0, complete: false };
    const bp = this.diffBase === "production" ? this.branch : undefined;
    return {
      editRevision: this.editRevision,
      indexRevision: this.index?.revision.id ?? null,
      diffBase: this.diffBase,
      total: count,
      reasons: [...reasons],
      files,
      branch: bp && { name: bp.branch, mainRef: bp.mainRef, behind: bp.behind, mainShown: this.mainChanges },
    };
  }

  fileAnswer(path: string): FileAnswer {
    return this.resultFor(this.requireFile(path)).answer;
  }

  /** One edit's rule (every declaration, the edited ones marked) and where to adjust it. */
  changeDetail(path: string, changeId: string): ChangeDetail {
    const f = this.requireFile(path);
    const r = this.resultFor(f);
    const i = r.answer.changes.findIndex((c) => c.id === changeId);
    if (i < 0) throw new RpcError(ERR.superseded, `change ${changeId} no longer exists`, { editRevision: f.editRevision });
    const c = r.changes[i];
    return { editRevision: f.editRevision, path: f.path, id: changeId, kind: c.kind, ...describeChange(c) };
  }

  ruleCounts(path: string): RulesResult {
    const f = this.requireFile(path);
    const cur = this.current(f);
    const idx = this.index;
    if (!this.engine || !idx) {
      return {
        file: f.path,
        editRevision: f.editRevision,
        indexRevision: null,
        level: 0,
        rules: cur.model.rules.map((r) => ({
          line: r.line,
          endLine: r.endLine,
          selector: r.selectorText,
          pages: { exact: 0, possible: 0, unknown: 0, complete: false },
          conditions: [],
          reasons: [REASON.noIndex],
        })),
      };
    }
    const { rules, pending } = this.engine.ruleCounts(f.path, cur.model);
    const wasPending = this.rulesPending.has(f.path);
    if (pending.size) {
      this.rulesPending.add(f.path);
      this.scheduleL1(pending);
    } else this.rulesPending.delete(f.path);
    return { file: f.path, editRevision: f.editRevision, indexRevision: idx.revision.id, level: wasPending && !pending.size ? 1 : 0, rules };
  }

  private requireFile(path: string): FileState {
    const f = this.files.get(resolve(path));
    if (f) return f;
    // Not open and not changed: analyze the file on disk against itself.
    const text = readText(resolve(path));
    if (text === undefined) throw new RpcError(ERR.unknownDocument, `unknown document: ${path}`);
    const tmp: FileState = { path: resolve(path), diskText: text, version: 0, editRevision: this.editRevision };
    tmp.base = { text, kind: this.diffBase };
    tmp.baseModel = browserModel(text);
    return tmp;
  }

  /**
   * Pushes current answers for open documents. After L1 (`fromL1`), only the
   * ones that were waiting on it; otherwise all (diff base, index, markup).
   */
  private publishOpenDocs(fromL1 = false): void {
    const level: 0 | 1 = fromL1 ? 1 : 0;
    const waiting = new Set([...this.files.values()].filter((f) => (f.result?.analysis?.pending.size ?? 0) > 0).map((f) => f.path));
    const session = this.sessionTotal();
    for (const f of this.files.values()) {
      if (!f.doc) continue;
      const hadPending = waiting.has(f.path);
      const rules = !fromL1 || this.rulesPending.has(f.path);
      if (fromL1 && !hadPending && !rules) continue;
      const r = this.resultFor(f, level);
      this.emit("refined", { answer: { ...r.answer, level }, session, rules });
    }
    // Closed files, the diff base or the index may have moved the total too.
    this.emit("publish", { session });
  }

  // ------------------------------------------------------------------- L1

  private scheduleL1(pending: PendingWork): void {
    let added = false;
    for (const [k, set] of pending) {
      const todo = set.clone();
      // L1Cache drops everything past its size limit; tried pages then count again.
      const tried = this.l1?.get(k) ? this.l1Tried.get(k) : undefined;
      if (tried) todo.andNotInPlace(tried);
      if (todo.isEmpty()) continue;
      const q = this.l1Queue.get(k);
      if (q) q.orInPlace(todo);
      else this.l1Queue.set(k, todo);
      added = true;
    }
    if (added && !this.l1Running) this.l1Running = this.drainL1().finally(() => (this.l1Running = undefined));
  }

  private async drainL1(): Promise<void> {
    while (this.l1Queue.size) {
      await new Promise((r) => setImmediate(r)); // let the L0 reply go out first
      const work = this.l1Queue;
      this.l1Queue = new Map();
      const cache = this.l1;
      const idx = this.index;
      if (!cache || !idx) return;
      if (this.l1Tried.size > 50_000) this.l1Tried.clear();
      for (const [k, set] of work) {
        const tried = this.l1Tried.get(k);
        if (tried) tried.orInPlace(set);
        else this.l1Tried.set(k, set.clone());
      }
      let results;
      try {
        results = await this.pool.resolve(work, idx);
      } catch (err: any) {
        this.degrade(`L1 matching failed: ${err?.message ?? err}`);
        return;
      }
      if (cache !== this.l1) continue; // the index revision switched meanwhile
      for (const r of results) cache.record(r.key, r.checked, r.matched, r.unsupported);
      this.l1gen++;
      this.publishOpenDocs(true);
    }
  }

  /** Waits until queued L1 work is done (bounded). */
  async l1Idle(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.l1Running) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await Promise.race([this.l1Running, new Promise((r) => setTimeout(r, left))]);
    }
    return true;
  }

  // ----------------------------------------------------------- selection

  /** Picks the edits that page lists without a path, impact assessment and the diff viewer apply (absent: every edit). */
  setSelection(sel?: EditSelection | null): SetSelectionResult {
    const norm = sel ? normalizeSelection(sel) : undefined;
    const key = norm ? JSON.stringify(norm) : "";
    if (key !== this.selectionKey) {
      this.selection = norm;
      this.selectionKey = key;
      this.selectionRevision++;
      this.emit("selection", { selectionRevision: this.selectionRevision });
    }
    return { selectionRevision: this.selectionRevision };
  }

  /** Which of a file's changes (`r.changes`) are selected. */
  private chosen(f: FileState, r: FileResult): boolean[] {
    const sel = this.selection;
    if (!sel) return r.changes.map(() => true);
    const e = sel.find((x) => x.path === f.path);
    if (!e) return r.changes.map(() => false);
    if (!e.changeIds) return r.changes.map(() => true);
    const ids = new Set(e.changeIds);
    return r.answer.changes.map((c) => ids.has(c.id));
  }

  // ---------------------------------------------------------- page lists

  private requireIndex(): SiteIndex {
    if (!this.index || !this.engine) throw new RpcError(ERR.noIndex, "no index: run a capture first");
    return this.index;
  }

  private checkRevision(have: number, asked?: number): void {
    if (asked !== undefined && asked < have) throw new RpcError(ERR.superseded, `edit revision ${asked} was superseded by ${have}`, { editRevision: have });
  }

  private setsFor(p: { path?: string; changeId?: string; line?: number; side?: "pages" | "gained" | "lost" }): { sets: Sets; pending: boolean; editRevision: number; f?: FileState; r?: FileResult } {
    const idx = this.requireIndex();
    if (!p.path) {
      const total = Sets.empty(idx.size);
      let pending = false;
      for (const f of this.files.values()) {
        const r = this.resultFor(f);
        const a = r.analysis;
        if (!a || r.changes.length === 0) continue;
        const chosen = this.chosen(f, r);
        if (chosen.every(Boolean)) {
          total.orInPlace(a.total);
          pending ||= a.pending.size > 0;
          continue;
        }
        chosen.forEach((yes, i) => {
          if (!yes) return;
          total.orInPlace(a.sets[i]);
          pending ||= !a.changes[i].pages.complete && a.changes[i].pages.possible > 0;
        });
      }
      return { sets: total, pending, editRevision: this.editRevision };
    }
    const f = this.requireFile(p.path);
    if (p.line !== undefined && !p.changeId) {
      const rp = this.engine!.rulePages(f.path, this.current(f).model, p.line);
      if (!rp) throw new RpcError(ERR.superseded, `no rule starts on line ${p.line}`, { editRevision: f.editRevision });
      if (rp.pending.size) this.scheduleL1(rp.pending);
      return { sets: rp.sets, pending: rp.pending.size > 0, editRevision: f.editRevision, f };
    }
    const r = this.resultFor(f);
    const a = r.analysis!;
    if (!p.changeId) return { sets: a.total, pending: a.pending.size > 0, editRevision: f.editRevision, f, r };
    const i = a.changes.findIndex((c) => c.id === p.changeId);
    if (i < 0) throw new RpcError(ERR.superseded, `change ${p.changeId} no longer exists`, { editRevision: f.editRevision });
    const sets = p.side === "gained" ? a.gained[i] : p.side === "lost" ? a.lost[i] : a.sets[i];
    if (!sets) throw new RpcError(ERR.invalidParams, `change ${p.changeId} has no ${p.side} pages`);
    return { sets, pending: !a.changes[i].pages.complete && a.changes[i].pages.possible > 0, editRevision: f.editRevision, f, r };
  }

  async getPages(p: GetPagesParams): Promise<PagesResult> {
    const { idx, items, groups, sets, pending, editRevision } = await this.listPages(p);
    this.checkRevision(editRevision, p.editRevision);
    const assessment = this.rankByImpact(items);
    const offset = Math.max(0, p.offset ?? 0);
    const limit = Math.min(Math.max(1, p.limit ?? 200), 2000);
    return {
      editRevision,
      indexRevision: idx.revision.id,
      level: 1,
      count: sets.count(pending),
      groups,
      total: items.length,
      offset,
      pages: items.slice(offset, offset + limit),
      assessment,
    };
  }

  /** The pages of a list in their L1 order (sure matches, then possible, then unchecked; by URL). */
  private async listPages(p: AssessParams) {
    const idx = this.requireIndex();
    await this.l1Idle();
    let r = this.setsFor(p);
    // Rule-line queries may schedule their own L1 work.
    if (r.pending && (await this.l1Idle())) r = this.setsFor(p);
    const { sets, pending, editRevision } = r;
    // Server mode: the linked page groups (a page can be in several); otherwise the first path segment.
    const scope = this.scopeSets;
    const groupsOf = (id: number, url: string): string[] => {
      if (scope) return [...scope].filter(([, set]) => set.has(id)).map(([name]) => name);
      const m = /^\/[^/]+\//.exec(url);
      return [m ? m[0] : "/"];
    };
    const groups = new Map<string, { name: string; exact: number; possible: number; unknown: number }>();
    for (const name of scope?.keys() ?? []) groups.set(name, { name, exact: 0, possible: 0, unknown: 0 });
    const items: PageItem[] = [];
    const want = p.set ?? "all";
    for (const name of ["exact", "possible", "unknown"] as PageSetName[]) {
      for (const id of sets[name].ids()) {
        const row = idx.pages[id];
        if (!row) continue;
        const gs = groupsOf(id, row.url);
        for (const g of gs) {
          let e = groups.get(g);
          if (!e) groups.set(g, (e = { name: g, exact: 0, possible: 0, unknown: 0 }));
          e[name]++;
        }
        if ((want === "all" || want === name) && (!p.group || gs.includes(p.group))) {
          items.push({ url: row.url, set: name, template: row.template, ...(scope ? { groups: gs } : {}) });
        }
      }
    }
    const order: Record<PageSetName, number> = { exact: 0, possible: 1, unknown: 2 };
    items.sort((a, b) => order[a.set] - order[b.set] || a.url.localeCompare(b.url));
    return {
      idx,
      items,
      groups: [...groups.values()].sort((a, b) => b.exact + b.possible - (a.exact + a.possible) || a.name.localeCompare(b.name)),
      sets,
      pending,
      editRevision,
    };
  }

  // ---------------------------------------------------- impact assessment

  private assessKey(): string {
    return `${this.index?.revision.id ?? -1}:${this.editRevision}:${this.selectionKey}`;
  }

  /** Results for the current page scan, edits and selection; the last few states are kept. */
  private impacts(): Map<string, PageImpact> {
    const key = this.assessKey();
    const results = this.assessed.get(key) ?? new Map<string, PageImpact>();
    this.assessed.delete(key);
    this.assessed.set(key, results);
    for (const old of this.assessed.keys()) {
      if (this.assessed.size <= ASSESS_KEEP) break;
      this.assessed.delete(old);
    }
    return results;
  }

  private runningAssessment(): AssessJob | undefined {
    const job = this.assessJob;
    return job && job.workers > 0 && !job.cancelled && job.key === this.assessKey() ? job : undefined;
  }

  /**
   * Once no assessment is running: the results on the pages, the ones that
   * look different first (most changed elements, then most moved), then the
   * unassessed, the inconclusive and the unchanged, each in L1 order.
   */
  private rankByImpact(items: PageItem[]): AssessmentSummary {
    const results = this.impacts();
    const job = this.runningAssessment();
    const s: AssessmentSummary = { running: !!job, done: job?.done ?? 0, total: job?.total ?? 0, assessed: 0, pending: 0, changed: 0, maxChanged: 0 };
    for (const it of items) {
      const im = results.get(it.url);
      if (!im) {
        s.pending++;
        continue;
      }
      s.assessed++;
      if (im.status === "changed") {
        s.changed++;
        s.maxChanged = Math.max(s.maxChanged, im.changed);
      }
      if (!job) it.impact = im;
    }
    if (!job && s.assessed) {
      const rank = (it: PageItem) => (!it.impact ? 1 : it.impact.status === "changed" ? 0 : it.impact.status === "inconclusive" ? 2 : 3);
      items.sort((a, b) => rank(a) - rank(b) || (b.impact?.changed ?? 0) - (a.impact?.changed ?? 0) || (b.impact?.moved ?? 0) - (a.impact?.moved ?? 0));
    }
    return s;
  }

  /** Checks every page of a list visually in the background (L2, each device); analysis/getPages then ranks them. */
  async assess(p: AssessParams): Promise<AssessProgress> {
    const { items } = await this.listPages(p);
    const results = this.impacts();
    let job = this.runningAssessment();
    if (!job && this.assessJob && this.assessJob.workers > 0) this.assessJob.cancelled = true;
    const todo = items.map((i) => i.url).filter((u) => !results.has(u));
    if (!job) {
      if (!todo.length) return this.assessProgress(undefined);
      job = this.assessJob = {
        key: this.assessKey(),
        editRevision: this.editRevision,
        indexRevision: this.index?.revision.id ?? null,
        queue: [],
        queued: new Set(),
        done: 0,
        total: 0,
        workers: 0,
        cancelled: false,
        emittedAt: 0,
      };
    }
    for (const u of todo) {
      if (job.queued.has(u)) continue;
      job.queued.add(u);
      job.queue.push(u);
      job.total++;
    }
    while (job.workers < ASSESS_WORKERS && job.workers < job.queue.length) void this.assessWorker(job);
    return this.assessProgress(job);
  }

  private assessProgress(job: AssessJob | undefined): AssessProgress {
    return {
      editRevision: job?.editRevision ?? this.editRevision,
      indexRevision: job ? job.indexRevision : this.index?.revision.id ?? null,
      running: !!job && job.workers > 0 && !job.cancelled,
      done: job?.done ?? 0,
      total: job?.total ?? 0,
      ...(job?.cancelled ? { cancelled: true } : {}),
    };
  }

  private emitAssess(job: AssessJob, final: boolean): void {
    const now = Date.now();
    if (!final && now - job.emittedAt < 200) return;
    job.emittedAt = now;
    this.emit("assess", this.assessProgress(job));
  }

  private async assessWorker(job: AssessJob): Promise<void> {
    job.workers++;
    try {
      let prep: RenderEdits | undefined;
      let failed: string | undefined;
      try {
        prep = await (job.prep ??= this.renderEdits());
      } catch (err: any) {
        failed = String(err?.message ?? err).split("\n")[0];
      }
      while (!job.cancelled && job.queue.length) {
        if (job.key !== this.assessKey()) {
          job.cancelled = true;
          break;
        }
        const url = job.queue.shift()!;
        const impact = prep
          ? await this.pageImpact(url, prep, job).catch((err: any) => inconclusiveImpact(String(err?.message ?? err).split("\n")[0]))
          : inconclusiveImpact(`Your edits couldn't be prepared: ${failed}`);
        if (job.cancelled || job.key !== this.assessKey()) {
          job.cancelled = true;
          break;
        }
        this.impacts().set(url, impact);
        job.done++;
        this.emitAssess(job, false);
      }
    } finally {
      job.workers--;
      if (job.workers === 0) this.emitAssess(job, true);
    }
  }

  private async pageImpact(url: string, prep: RenderEdits, job: AssessJob): Promise<PageImpact> {
    if (prep.list.length === 0) return { status: "unchanged", changed: 0, moved: 0, devices: [] };
    if (prep.edits.length === 0) return inconclusiveImpact("Your changed files don't match any stylesheet on the site.");
    const page = this.pageRow(url);
    const variants = this.pageVariants(page);
    if (page.status !== "ok" || !variants.length) return inconclusiveImpact(`The page's scan failed: ${page.error ?? "no stored copy"}`);
    const { props, unresolved } = this.propsFor(prep.changes, prep.models, page);
    const devices: PageImpact["devices"] = [];
    for (const variant of variants) {
      if (job.cancelled || job.key !== this.assessKey()) break;
      const d = await this.getRenderer().measure({ page, variant, mode: "shell", edits: prep.edits, props, maxElements: 0, background: true });
      let status = d.status;
      let reason = d.reason;
      if (status === "unchanged" && unresolved.length) {
        status = "inconclusive";
        reason = `No stylesheet on this page uses ${unresolved.join(", ")}: what it feeds (inline styles, scripts) wasn't compared.`;
      }
      devices.push({ name: variant.name, status, changed: d.changedElements, moved: d.movedElements, ...(reason ? { reason } : {}) });
    }
    const status = devices.some((d) => d.status === "changed") ? "changed" : devices.every((d) => d.status === "unchanged") ? "unchanged" : "inconclusive";
    const reason = status === "inconclusive" ? devices.find((d) => d.reason)?.reason : undefined;
    return {
      status,
      changed: devices.reduce((n, d) => n + d.changed, 0),
      moved: devices.reduce((n, d) => n + d.moved, 0),
      devices,
      ...(reason ? { reason } : {}),
    };
  }

  // ----------------------------------------------------------- drilldown

  private changeRules(r: FileResult, changeId?: string, line?: number): { rules: StyleRule[]; changes: CssChange[] } {
    if (!changeId && line !== undefined) {
      // A rule, edited or not: its elements; the render shows the whole file's edits.
      const rule = r.cur.model.rules.find((x) => x.line === line);
      if (!rule) throw new RpcError(ERR.superseded, `no rule starts on line ${line}`);
      return { rules: [rule], changes: r.changes };
    }
    if (!changeId) return { rules: r.changes.flatMap((c) => [c.after, c.before].filter((x): x is StyleRule => !!x)), changes: r.changes };
    const i = r.answer.changes.findIndex((c) => c.id === changeId);
    if (i < 0) throw new RpcError(ERR.superseded, `change ${changeId} no longer exists`);
    const c = r.changes[i];
    return { rules: [c.after, c.before].filter((x): x is StyleRule => !!x), changes: [c] };
  }

  /**
   * Longhands L2 compares. A custom property is replaced by the properties
   * that consume it (directly or through other custom properties) in the
   * edited file or any stylesheet the page loads. `unresolved` lists custom
   * properties with no consumer found there (inline styles, scripts).
   */
  private propsFor(changes: CssChange[], models: StylesheetModel[], page: PageRow): { props: string[]; unresolved: string[] } {
    const props = new Set<string>();
    let global = false;
    for (const c of changes) {
      if (c.kind === "declarations") for (const p of c.changedProps ?? []) props.add(p);
      else if (c.after || c.before) for (const d of (c.after ?? c.before)!.decls) props.add(d.prop);
      else global = true;
    }
    if (global) return { props: [], unresolved: [] };
    const custom = [...props].filter((p) => p.startsWith("--"));
    const unresolved: string[] = [];
    if (custom.length) {
      const all = [...models, ...this.pageSheetModels(page)];
      for (const v of custom) {
        props.delete(v);
        const closure = this.engine ? this.engine.varClosure([v], all) : [v];
        let found = false;
        for (const m of all) {
          for (const r of m.rules) {
            for (const d of r.decls) {
              if (d.prop.startsWith("--") || !closure.some((x) => d.value.includes(x))) continue;
              props.add(d.prop);
              found = true;
            }
          }
        }
        if (!found) unresolved.push(v);
      }
      if (unresolved.length) for (const p of DEFAULT_PROPS) props.add(p);
    }
    return { props: [...props].slice(0, 60), unresolved };
  }

  private readonly sheetModels = new Map<string, StylesheetModel>();

  /** Models of the captured stylesheets a page loads (parsed once per content hash). */
  private pageSheetModels(page: PageRow): StylesheetModel[] {
    const out: StylesheetModel[] = [];
    for (const s of this.index?.sheets.values() ?? []) {
      if (!s.hash || !s.pages.has(page.id)) continue;
      let m = this.sheetModels.get(s.hash);
      if (!m) {
        try {
          m = browserModel(this.store.getBlob(s.hash).toString("utf8"));
        } catch {
          continue;
        }
        if (this.sheetModels.size > 500) this.sheetModels.clear();
        this.sheetModels.set(s.hash, m);
      }
      out.push(m);
    }
    return out;
  }

  private pageVariants(page: PageRow): VariantInfo[] {
    const byId = new Map(this.index!.variants.map((v) => [v.id, v]));
    return Object.keys(page.trees)
      .map(Number)
      .sort((a, b) => a - b)
      .map((id) => byId.get(id)!)
      .filter(Boolean);
  }

  private async matchesOn(page: PageRow, rules: StyleRule[]): Promise<SelectorElements[]> {
    const variants = this.pageVariants(page);
    const seen = new Set<string>();
    const out: SelectorElements[] = [];
    for (const r of rules) {
      for (const cs of r.complex) {
        if (seen.has(cs.key) || cs.invalid || out.length >= 20) continue;
        seen.add(cs.key);
        const e: SelectorElements = { selector: cs.text, key: cs.key, dropped: cs.dropped, variants: [] };
        try {
          const d = await this.pool.drill(page, cs.key, 50);
          e.variants = d.map((x) => ({ variant: variants[x.variant]?.name ?? String(x.variant), count: x.count, elements: x.elements }));
        } catch (err: any) {
          e.error = String(err?.message ?? err).split("\n")[0];
        }
        out.push(e);
      }
    }
    return out;
  }

  private pageRow(url: string): PageRow {
    const idx = this.requireIndex();
    const id = idx.byUrl.get(url);
    if (id === undefined) throw new RpcError(ERR.invalidParams, `page not in the index: ${url}`);
    return idx.pages[id];
  }

  /** The file's answer and base as of now: a detail request is computed for this edit revision only. */
  private snapshot(f: FileState, asked?: number): DetailSnapshot {
    const r = this.resultFor(f);
    this.checkRevision(f.editRevision, asked);
    return { r, editRevision: f.editRevision, base: f.base, baseModel: f.baseModel ?? r.cur.model };
  }

  async drilldown(p: DrilldownParams): Promise<DrilldownResult> {
    const idx = this.requireIndex();
    const f = this.requireFile(p.path);
    const snap = this.snapshot(f, p.editRevision);
    const page = this.pageRow(p.url);
    const { rules, changes } = this.changeRules(snap.r, p.changeId, p.line);
    const matches = page.status === "ok" ? await this.matchesOn(page, rules) : [];
    const out: DrilldownResult = {
      editRevision: snap.editRevision,
      indexRevision: idx.revision.id,
      url: page.url,
      template: page.template,
      capturedAt: page.capturedAt,
      level: 1,
      matches,
      basis: "LOCAL_INDEX",
    };
    if (p.level === 2) {
      out.render = await this.render(snap, page, changes, matches, "shell", p.variant, p.screenshots);
      out.level = 2;
      out.basis = "LOCAL_RENDER";
    }
    return out;
  }

  async openLive(p: OpenLiveParams): Promise<DrilldownResult> {
    const idx = this.requireIndex();
    const f = this.requireFile(p.path);
    const snap = this.snapshot(f, p.editRevision);
    const page = this.pageRow(p.url);
    const { rules, changes } = this.changeRules(snap.r, p.changeId, p.line);
    const matches = page.status === "ok" ? await this.matchesOn(page, rules) : [];
    return {
      editRevision: snap.editRevision,
      indexRevision: idx.revision.id,
      url: page.url,
      template: page.template,
      capturedAt: page.capturedAt,
      level: 3,
      matches,
      render: await this.render(snap, page, changes, matches, "live", p.variant, p.screenshots),
      basis: "LIVE_LOAD",
    };
  }

  private async render(
    snap: DetailSnapshot,
    page: PageRow,
    changes: CssChange[],
    matches: SelectorElements[],
    mode: "shell" | "live",
    variantName?: string,
    screenshots?: boolean,
  ): Promise<PageDiff> {
    const variants = this.pageVariants(page);
    const variant =
      variants.find((v) => v.name === variantName) ??
      variants.find((v) => matches.some((m) => m.variants.some((x) => x.variant === v.name && x.count > 0))) ??
      variants[0] ??
      this.index!.variants[0];
    const renderer = this.getRenderer();
    const { props, unresolved } = this.propsFor(changes, [snap.r.cur.model, snap.baseModel], page);
    const texts = await this.renderTexts(snap.base, snap.r.cur.text);
    const diff = await renderer.measure({
      page,
      variant,
      mode,
      sheetKeys: snap.r.answer.mapping.urls,
      baseText: texts.baseText,
      editedText: texts.editedText,
      props,
      screenshots,
      targets: targetsFor(changes),
    });
    if (texts.conflict) diff.warnings.unshift(conflictWarning(this.relPath(snap.r.answer.file), this.branch));
    if (diff.status === "unchanged" && unresolved.length) {
      diff.status = "inconclusive";
      diff.reason = `no stylesheet on this page uses ${unresolved.join(", ")}: the properties it feeds (inline styles, scripts) weren't compared`;
    }
    return diff;
  }

  /**
   * The texts the visual diff swaps in. On a branch: the site's copy before,
   * and the site's copy with the branch's changes merged in after (as git
   * would merge them); the branch's own versions when they conflict.
   */
  private async renderTexts(base: BaseText | undefined, cur: string): Promise<{ baseText: string; editedText: string; conflict?: boolean }> {
    const from = base?.text ?? "";
    if (base?.live === undefined || base.live === from || !this.git) return { baseText: from, editedText: cur };
    const merged = await this.git.mergeFile(base.live, from, cur);
    if (merged === undefined) return { baseText: from, editedText: cur, conflict: true };
    return { baseText: base.live, editedText: merged };
  }

  private relPath(path: string): string {
    return relative(this.cfg.workspaceRoot, path).split(sep).join("/") || path;
  }

  private getRenderer(): Renderer {
    if (this.opts.shared) return this.opts.shared.renderer();
    return (this.renderer ??= new Renderer(this.cfg, this.store));
  }

  /**
   * One page before and after every current edit of the project, with
   * full-page screenshots and the outermost changed zones (the diff viewer).
   */
  async pageDiff(p: PageDiffParams): Promise<PageDiffView> {
    const idx = this.requireIndex();
    const page = this.pageRow(p.url);
    const t0 = performance.now();
    const editRevision = this.editRevision;
    const { edits, list, total, changes, models, warnings } = await this.renderEdits();
    const variants = this.pageVariants(page);
    const variant = variants.find((v) => v.name === p.device) ?? variants[0] ?? idx.variants[0];
    const view: PageDiffView = {
      status: "unchanged",
      warnings,
      url: page.url,
      device: variant?.name ?? "",
      devices: variants.map((v) => v.name),
      live: !!p.live,
      editRevision,
      scannedAt: page.capturedAt,
      edits: list,
      editsTotal: total,
      scale: 1,
      width: 0,
      before: "",
      after: "",
      zones: [],
      changedElements: 0,
      movedElements: 0,
      timingMs: 0,
    };
    const finish = () => {
      view.timingMs = Math.round(performance.now() - t0);
      return view;
    };
    if (list.length === 0) {
      view.reason = total
        ? "None of your edits are picked. Pick some in the Blast Radius panel in your editor."
        : NO_CHANGES[this.diffBase] ?? (this.branch && !this.mainChanges ? "Your branch has no CSS changes right now." : "You have no CSS changes compared with the live site right now.");
      return finish();
    }
    if (edits.length === 0) {
      view.status = "inconclusive";
      view.reason = "Your changed files don't match any stylesheet on the site, so they can't be applied to this page.";
      return finish();
    }
    const { props, unresolved } = this.propsFor(changes, models, page);
    const diff = await this.getRenderer().measure({
      page,
      variant,
      mode: p.live ? "live" : "shell",
      edits,
      props,
      screenshots: true,
      maxElements: 500,
      targets: targetsFor(changes),
    });
    view.status = diff.status;
    view.reason = diff.reason;
    view.warnings = [...warnings, ...diff.warnings];
    if (diff.status === "unchanged" && unresolved.length) {
      view.status = "inconclusive";
      view.reason = `No stylesheet on this page uses ${unresolved.join(", ")}: what it feeds (inline styles, scripts) wasn't compared.`;
    }
    view.changedElements = diff.changedElements;
    view.movedElements = diff.movedElements;
    view.scale = diff.scale ?? 1;
    view.width = diff.pageWidth ?? 0;
    if (diff.screenshots) {
      view.before = `data:image/jpeg;base64,${diff.screenshots.before}`;
      view.after = `data:image/jpeg;base64,${diff.screenshots.after}`;
    }
    const box = (b: number[] | null) => (b ? ([b[0], b[1], b[2], b[3]] as [number, number, number, number]) : null);
    view.zones = diff.zones.map((z) => ({ before: box(z.before), after: box(z.after), label: z.label, props: z.props }));
    if (diff.anchors?.length) {
      view.anchors = diff.anchors;
      view.anchorLeaves = diff.anchorLeaves ?? 0;
    }
    return finish();
  }

  /**
   * The selected edits as the visual diff applies them: the site stylesheets
   * each changed file replaces, and its texts. A file with only some edits
   * selected gets its base text with just those edits' lines applied.
   */
  private async renderEdits(): Promise<RenderEdits> {
    const idx = this.requireIndex();
    const edits: SheetEdit[] = [];
    const list: PageDiffView["edits"] = [];
    const changes: CssChange[] = [];
    const models: StylesheetModel[] = [];
    const warnings: string[] = [];
    let total = 0;
    const owner = new Map<string, string>(); // site stylesheet → the file applied to it
    const todo: Array<{ file: string; keys: string[]; base?: BaseText; cur: string }> = [];
    for (const f of this.files.values()) {
      const r = this.resultFor(f);
      if (r.changes.length === 0) continue;
      total += r.changes.length;
      const chosen = this.chosen(f, r);
      if (!chosen.some(Boolean)) continue;
      const file = this.relPath(f.path);
      let cur = r.cur.text;
      let applied = r.changes;
      if (!chosen.every(Boolean)) {
        // Changes the live site already has (dropped from r.changes on a branch) change nothing there: kept.
        const visible = new Map(r.changes.map((c, i) => [c, i] as const));
        const keep = (i: number) => {
          const v = visible.get(r.allChanges[i]);
          return v === undefined || chosen[v];
        };
        const part = partialText(f.base?.text ?? "", cur, r.allChanges, keep, f.baseModel ?? parseStylesheet(""), r.cur.model);
        cur = part.text;
        const extra = new Set(part.alsoApplied.map((i) => r.allChanges[i]).filter((c) => visible.has(c)));
        applied = r.changes.filter((c, i) => chosen[i] || extra.has(c));
        if (part.fallback) {
          warnings.push(`${file}: the selected edits couldn't be separated from its other edits, so all ${r.changes.length} are shown.`);
        } else if (extra.size) {
          const names = [...extra].map(changeLabel).join(", ");
          warnings.push(`${file}: ${names} ${extra.size === 1 ? "is" : "are"} shown too, as ${extra.size === 1 ? "it shares" : "they share"} lines with a selected edit.`);
        }
      }
      list.push({ file, changes: applied.length, of: r.changes.length });
      let keys = r.answer.mapping.urls;
      if (keys.length > 1 && f.base?.kind === "production") {
        // A name tie: the base is the first match's captured CSS, so the edit only fits sheets with that same content.
        const hash = this.sheetHashes(f.path)[0];
        const same = keys.filter((k) => idx.sheets.get(k)?.hash === hash);
        if (same.length < keys.length) {
          warnings.push(`${file} matches ${keys.length} site stylesheets with the same name; it's compared only where the site's copy is identical (${same.join(", ")}).`);
        }
        keys = same;
      }
      const taken = keys.filter((k) => owner.has(k));
      for (const k of taken) warnings.push(`${file} and ${owner.get(k)} both match ${k}; only ${owner.get(k)} is compared there.`);
      keys = keys.filter((k) => !owner.has(k));
      if (keys.length === 0) continue;
      for (const k of keys) owner.set(k, file);
      todo.push({ file, keys, base: f.base, cur });
      changes.push(...applied);
      models.push(r.cur.model, f.baseModel ?? r.cur.model);
    }
    for (const e of todo) {
      const texts = await this.renderTexts(e.base, e.cur);
      if (texts.conflict) warnings.push(conflictWarning(e.file, this.branch));
      edits.push({ sheetKeys: e.keys, baseText: texts.baseText, editedText: texts.editedText });
    }
    return { edits, list, total, changes, models, warnings };
  }

  // -------------------------------------------------------------- capture

  startCapture(p: CaptureParams = {}): { started: boolean } {
    if (this.captureState?.running) throw new RpcError(ERR.invalidRequest, "a capture is already running");
    const state = (this.captureState = { running: true, done: 0, total: 0 } as NonNullable<Session["captureState"]>);
    this.emit("status", this.status());
    let last = 0;
    void (async () => {
      try {
        const res = await new Capturer(this.cfg, this.store).run({
          urls: p.urls,
          keep: this.index ? [this.index.revision.id] : [],
          onProgress: (pr) => {
            state.done = pr.done;
            state.total = pr.total;
            const now = Date.now();
            if (now - last > 250 || pr.done === pr.total || !pr.ok) {
              last = now;
              this.emit("captureProgress", pr);
            }
          },
        });
        await this.indexChanged(res);
      } catch (err: any) {
        state.error = String(err?.message ?? err).split("\n")[0];
      } finally {
        state.running = false;
        this.emit("status", this.status());
      }
    })();
    return { started: true };
  }

  /** A new index revision was published (by this session's capture or the server's). */
  async indexChanged(result?: unknown): Promise<void> {
    this.loadIndex();
    this.markupChanged = false;
    for (const f of this.files.values()) this.touch(f);
    await this.refreshClosed();
    for (const f of this.files.values()) await this.ensureBase(f);
    this.emit("revision", { indexRevision: this.index?.revision.id ?? null, result });
    this.publishOpenDocs();
  }

  // ------------------------------------------------------------- watching

  private startWatching(): void {
    const roots = new Set<string>(this.cssDirs());
    if (this.cfg.siteRoot) roots.add(this.cfg.siteRoot);
    // HEAD/index: commits, checkouts, merges; FETCH_HEAD: the deployed branch moved.
    const gitFiles = this.git ? ["HEAD", "index", "FETCH_HEAD"].map((n) => join(this.git!.top, ".git", n)).filter(existsSync) : [];
    const dataDir = this.cfg.dataDir;
    this.watcher = chokidar.watch([...roots, ...gitFiles], {
      ignoreInitial: true,
      ignored: (p: string) => !gitFiles.includes(p) && (p.startsWith(dataDir) || /[\\/](node_modules|\.git)([\\/]|$)/.test(p)),
      persistent: true,
    });
    const onEvent = (path: string) => {
      const p = resolve(path);
      if (gitFiles.includes(p)) {
        if (this.diffBase === "HEAD") for (const f of this.files.values()) if (f.doc) f.base = undefined;
        this.gitMoved = true;
        this.scheduleRefresh();
      } else if (/\.css$/i.test(p)) {
        if (this.files.get(p)?.doc) return; // the editor owns open files (§12)
        this.scheduleRefresh();
      } else if (/\.html?$/i.test(p) && this.index && !this.markupChanged) {
        this.markupChanged = true;
        this.emit("status", this.status());
        this.publishOpenDocs();
      }
    };
    this.watcher.on("add", onEvent).on("change", onEvent).on("unlink", onEvent);
    // Changes made while the watcher was still scanning go unreported: look once it's ready.
    this.watcher.on("ready", () => this.scheduleRefresh());
    this.watcher.on("error", (err) => this.messages.push(`file watcher: ${String(err)}`));
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      try {
        if (this.gitMoved) {
          this.gitMoved = false;
          const old = this.branch?.mergeBase;
          this.branchLoad = undefined;
          if ((await this.branchPoint())?.mergeBase !== old) {
            for (const f of this.files.values()) {
              f.base = undefined;
              this.touch(f);
            }
          }
        }
        for (const f of this.files.values()) {
          if (f.doc && !f.base) {
            this.touch(f);
            await this.ensureBase(f);
          }
        }
        const before = new Map<string, string | undefined>();
        for (const [p, f] of this.files) if (!f.doc) before.set(p, f.diskText);
        const totalBefore = this.sessionTotal().total;
        await this.refreshClosed();
        this.publishOpenDocs();
        // CSS changed on disk outside the editor (pull, branch switch, AI tools, other editors).
        const files: string[] = [];
        for (const [p, f] of this.files) if (!f.doc && (!before.has(p) || before.get(p) !== f.diskText)) files.push(p);
        for (const p of before.keys()) if (!this.files.has(p)) files.push(p);
        if (files.length) {
          const session = this.sessionTotal();
          if (JSON.stringify(session.total) !== JSON.stringify(totalBefore)) this.emit("externalChange", { files, session, before: totalBefore });
        }
      } catch (err: any) {
        this.messages.push(`refresh failed: ${err?.message ?? err}`);
      }
    }, 150);
  }

  async dispose(): Promise<void> {
    clearTimeout(this.refreshTimer);
    if (this.assessJob) this.assessJob.cancelled = true;
    await this.watcher?.close();
    if (this.opts.shared) return; // the server owns the store, pool and renderer
    await this.renderer?.close();
    await this.pool.close();
    this.store.close();
  }
}

const MAX_TARGETS = 400;
const PSEUDO_TARGET = /(?:::(before|after|marker)|:(before|after))\s*$/i;

/** The edited rules' selectors with the properties each edit sets (the diff's outlines). */
function targetsFor(changes: CssChange[]): RenderTarget[] {
  const out = new Map<string, RenderTarget>();
  for (const c of changes) {
    const rule = c.after ?? c.before;
    if (!rule) continue;
    const set = c.kind === "declarations" ? (c.changedProps ?? []) : rule.decls.map((d) => d.prop);
    const props = [...new Set(set.filter((p) => !p.startsWith("--")))].sort();
    if (!props.length) continue;
    for (const r of [c.after, c.before]) {
      for (const cs of r?.complex ?? []) {
        if (cs.invalid || cs.unanalyzable || out.size >= MAX_TARGETS) continue;
        const m = PSEUDO_TARGET.exec(cs.text);
        const t: RenderTarget = { selector: cs.key, props };
        if (m) t.pseudo = (m[1] ?? m[2]).toLowerCase() as RenderTarget["pseudo"];
        out.set(`${t.pseudo ?? ""}|${t.selector}|${props.join(",")}`, t);
      }
    }
  }
  return [...out.values()];
}

function inconclusiveImpact(reason: string): PageImpact {
  return { status: "inconclusive", changed: 0, moved: 0, devices: [], reason };
}

function conflictWarning(file: string, bp: BranchPoint | undefined): string {
  const main = bp ? bp.mainRef.replace(/^[^/]+\//, "") : "the deployed branch";
  return `${file}: ${main} also changed the lines your branch edits, so this compares your branch's own version of the file before and after (merge ${main} to see them together).`;
}

function changeLabel(c: CssChange): string {
  return (c.after ?? c.before)?.selectorText ?? (c.def ? `@${c.def.kind} ${c.def.name}` : c.kind);
}

/** Absolute paths, one entry per file (all of it wins), sorted: equal selections compare equal. */
function normalizeSelection(sel: unknown): EditSelection {
  if (!Array.isArray(sel)) throw new RpcError(ERR.invalidParams, "selection must be a list of { path, changeIds? }");
  const byPath = new Map<string, Set<string> | null>();
  for (const e of sel) {
    if (!e || typeof e.path !== "string" || (e.changeIds !== undefined && !Array.isArray(e.changeIds))) {
      throw new RpcError(ERR.invalidParams, "selection must be a list of { path, changeIds? }");
    }
    const path = resolve(e.path);
    const have = byPath.get(path);
    if (have === null) continue;
    if (!e.changeIds) byPath.set(path, null);
    else byPath.set(path, new Set([...(have ?? []), ...e.changeIds.map(String)]));
  }
  return [...byPath]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, ids]) => (ids ? { path, changeIds: [...ids].sort() } : { path }));
}
