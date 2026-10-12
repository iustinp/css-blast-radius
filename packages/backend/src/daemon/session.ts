// One workspace session (§10.1): editor documents, diff base, the in-memory
// L0 index, L1 refinement in workers, L2/L3 renders and capture. Answers are
// computed synchronously from bitmaps; anything slower is pushed later as a
// notification for the same (indexRevision, editRevision) pair (§6.8).

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import fg from "fast-glob";
import { loadConfig, urlsForFile, type CbrConfig } from "../config.js";
import { browserModel, parseStylesheet, type StyleRule, type StylesheetModel } from "../css/model.js";
import { diffModels, type CssChange } from "../css/diff.js";
import { REASON, Sets, type Count, type FileAnswer } from "../engine/contract.js";
import { L0Engine, L1Cache, type Analysis, type PendingWork } from "../engine/l0.js";
import { SiteIndex } from "../index/siteIndex.js";
import { Store, type PageRow, type VariantInfo } from "../index/store.js";
import { L1Pool } from "../l1/pool.js";
import { DEFAULT_PROPS, Renderer, type PageDiff } from "../l2/render.js";
import { Capturer } from "../capture/capture.js";
import { PageSet } from "../util/pageSet.js";
import { Doc, sha256, type CurrentModel, type TextChange } from "./documents.js";
import { DIFF_BASES, Git, readText, type BaseText, type DiffBaseKind } from "./diffBase.js";
import {
  ERR,
  RpcError,
  type CaptureParams,
  type DocResult,
  type DrilldownParams,
  type DrilldownResult,
  type GetPagesParams,
  type IndexStatus,
  type OpenLiveParams,
  type PageItem,
  type PageSetName,
  type PagesResult,
  type RulesResult,
  type SelectorElements,
  type SessionTotal,
} from "../rpc/protocol.js";

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
}

interface FileResult {
  stamp: string;
  cur: CurrentModel;
  changes: CssChange[];
  analysis?: Analysis;
  answer: FileAnswer;
}

interface DetailSnapshot {
  r: FileResult;
  editRevision: number;
  baseText: string;
  baseModel: StylesheetModel;
}

interface FileState {
  path: string;
  doc?: Doc;
  /** Closed files: the text on disk (undefined: deleted). */
  diskText?: string;
  base?: BaseText;
  baseModel?: StylesheetModel;
  /** Bumped whenever the text or the base changes. */
  version: number;
  /** editRevision of the last text/base change. */
  editRevision: number;
  result?: FileResult;
}

const LIMITATIONS = [
  "Pages are analyzed in their captured states (profiles × recipes); other states are not seen.",
  "Interaction states (:hover, :focus…) are assumed reachable and listed as conditions.",
  "Shadow DOM and iframe content are not captured.",
  "Pages added to the site since the last capture are not counted.",
];

const MAX_SNAPSHOT_FILES = 3000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export class Session extends EventEmitter {
  readonly cfg: CbrConfig;
  readonly store: Store;
  index?: SiteIndex;
  engine?: L0Engine;
  l1?: L1Cache;
  readonly pool: L1Pool;
  private renderer?: Renderer;
  private git?: Git;
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
  private queryN = 0;
  private readonly messages: string[] = [];

  private constructor(readonly opts: SessionOptions) {
    super();
    this.cfg = loadConfig(opts.workspaceRoot, { siteRoot: opts.siteRoot, baseUrl: opts.baseUrl, dataDir: opts.dataDir });
    this.store = new Store(this.cfg.dataDir);
    this.pool = new L1Pool({ blobDir: this.store.blobDir, workers: opts.l1Workers });
    this.diffBase = opts.diffBase ?? "HEAD";
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
    const idx = SiteIndex.load(this.store);
    this.index = idx;
    if (!idx) {
      this.engine = undefined;
      this.l1 = undefined;
      return;
    }
    this.l1 = new L1Cache(idx.revision.id, idx.size);
    this.engine = new L0Engine(idx, this.cfg, this.l1);
    this.l1Queue = new Map();
    this.l1Tried = new Map();
    this.l1gen++;
    // Production bases come from the capture: they change with the revision.
    if (this.diffBase === "production") for (const f of this.files.values()) f.base = undefined;
    this.pool.warm(idx).catch((err) => this.degrade(`L1 workers: ${err?.message ?? err}`));
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
      capture: this.captureState ? { ...this.captureState } : undefined,
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

  async open(path: string, text: string, version: number): Promise<DocResult> {
    const f = this.state(path);
    f.doc = new Doc(f.path, text, version, readText(f.path));
    f.diskText = undefined;
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

  async setDiffBase(kind: DiffBaseKind): Promise<SessionTotal> {
    if (!DIFF_BASES.includes(kind)) throw new RpcError(ERR.invalidParams, `unknown diff base: ${kind}`);
    this.diffBase = kind;
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
        if (hash) return { text: this.store.getBlob(hash).toString("utf8"), kind: "production" };
        if (this.git) return { text: await this.git.show(path), kind: "HEAD", note: "no captured stylesheet for this file" };
        return { text: readText(path), kind: "saved", note: "no captured stylesheet for this file" };
      }
    }
  }

  private cssDirs(): string[] {
    const dirs = this.cfg.stylesheets.map((m) => m.dir);
    return dirs.length ? dirs : [this.cfg.siteRoot ?? this.cfg.workspaceRoot];
  }

  private async listCss(): Promise<string[]> {
    const out: string[] = [];
    for (const dir of this.cssDirs()) {
      if (!existsSync(dir)) continue;
      const found = await fg("**/*.css", { cwd: dir, absolute: true, ignore: ["**/node_modules/**", "**/.git/**"], suppressErrors: true });
      out.push(...found.map((f) => resolve(f)).filter((f) => !f.startsWith(this.cfg.dataDir)));
    }
    return [...new Set(out)];
  }

  /** Captured content hashes of the stylesheet(s) a workspace file is served as. */
  private sheetHashes(path: string): string[] {
    const idx = this.index;
    if (!idx) return [];
    const out: string[] = [];
    for (const u of urlsForFile(this.cfg, path)) {
      const key = idx.sheetKey(u);
      const h = key ? idx.sheets.get(key)?.hash : undefined;
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
        for (const f of await this.listCss()) {
          const hashes = this.sheetHashes(f);
          if (!hashes.length) continue;
          const t = readText(f);
          if (t !== undefined && !hashes.includes(sha256(t))) changed.push(f);
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
    return [f.version, this.index?.revision.id ?? "-", this.diffBase, this.markupChanged ? 1 : 0, pendingSensitive ? this.l1gen : 0].join("|");
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
    const changes = diffModels(baseModel, cur.model, lines);
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
      mapping: { mapped: urlsForFile(this.cfg, f.path).length > 0, urls: urlsForFile(this.cfg, f.path), linkedPages: 0 },
      freshness: null,
      basis: "LOCAL_INDEX",
      timingMs: 0,
    };
    let analysis: Analysis | undefined;
    if (!this.engine) {
      reasons.add(REASON.noIndex);
      if (changes.length === 0) reasons.add(REASON.noEffectiveChange);
      ans.changes = changes.map((c, i) => ({
        id: `${c.kind}:${c.line}:${i}`,
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
      ans.freshness = this.engine.freshness(analysis.candidates, f.base?.text);
      if (this.markupChanged) ans.freshness.stale = true;
      if (ans.freshness.stale) reasons.add(REASON.stale);
    }
    ans.totalReasons = [...reasons];
    ans.timingMs = Math.round((performance.now() - t0) * 100) / 100;
    const res: FileResult = { stamp: this.stamp(f, (analysis?.pending.size ?? 0) > 0), cur, changes, analysis, answer: ans };
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
    return { editRevision: this.editRevision, indexRevision: this.index?.revision.id ?? null, diffBase: this.diffBase, total: count, reasons: [...reasons], files };
  }

  fileAnswer(path: string): FileAnswer {
    return this.resultFor(this.requireFile(path)).answer;
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
        if (!r.analysis || r.changes.length === 0) continue;
        total.orInPlace(r.analysis.total);
        pending ||= r.analysis.pending.size > 0;
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
    const idx = this.requireIndex();
    await this.l1Idle();
    let r = this.setsFor(p);
    // Rule-line queries may schedule their own L1 work.
    if (r.pending && (await this.l1Idle())) r = this.setsFor(p);
    const { sets, pending, editRevision } = r;
    this.checkRevision(editRevision, p.editRevision);
    const groupOf = (url: string) => {
      const m = /^\/[^/]+\//.exec(url);
      return m ? m[0] : "/";
    };
    const groups = new Map<string, { name: string; exact: number; possible: number; unknown: number }>();
    const items: PageItem[] = [];
    const want = p.set ?? "all";
    for (const name of ["exact", "possible", "unknown"] as PageSetName[]) {
      for (const id of sets[name].ids()) {
        const row = idx.pages[id];
        if (!row) continue;
        const g = groupOf(row.url);
        let e = groups.get(g);
        if (!e) groups.set(g, (e = { name: g, exact: 0, possible: 0, unknown: 0 }));
        e[name]++;
        if ((want === "all" || want === name) && (!p.group || p.group === g)) items.push({ url: row.url, set: name, template: row.template });
      }
    }
    const order: Record<PageSetName, number> = { exact: 0, possible: 1, unknown: 2 };
    items.sort((a, b) => order[a.set] - order[b.set] || a.url.localeCompare(b.url));
    const offset = Math.max(0, p.offset ?? 0);
    const limit = Math.min(Math.max(1, p.limit ?? 200), 2000);
    return {
      editRevision,
      indexRevision: idx.revision.id,
      level: 1,
      count: sets.count(pending),
      groups: [...groups.values()].sort((a, b) => b.exact + b.possible - (a.exact + a.possible) || a.name.localeCompare(b.name)),
      total: items.length,
      offset,
      pages: items.slice(offset, offset + limit),
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
    return { r, editRevision: f.editRevision, baseText: f.base?.text ?? "", baseModel: f.baseModel ?? r.cur.model };
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
    this.renderer ??= new Renderer(this.cfg, this.store);
    const { props, unresolved } = this.propsFor(changes, [snap.r.cur.model, snap.baseModel], page);
    const diff = await this.renderer.measure({
      page,
      variant,
      mode,
      sheetKeys: snap.r.answer.mapping.urls,
      baseText: snap.baseText,
      editedText: snap.r.cur.text,
      props,
      screenshots,
    });
    if (diff.status === "unchanged" && unresolved.length) {
      diff.status = "inconclusive";
      diff.reason = `no stylesheet on this page uses ${unresolved.join(", ")}: the properties it feeds (inline styles, scripts) weren't compared`;
    }
    return diff;
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
        this.loadIndex();
        this.markupChanged = false;
        for (const f of this.files.values()) this.touch(f);
        await this.refreshClosed();
        for (const f of this.files.values()) await this.ensureBase(f);
        this.emit("revision", { indexRevision: this.index?.revision.id ?? null, result: res });
        this.publishOpenDocs();
      } catch (err: any) {
        state.error = String(err?.message ?? err).split("\n")[0];
      } finally {
        state.running = false;
        this.emit("status", this.status());
      }
    })();
    return { started: true };
  }

  // ------------------------------------------------------------- watching

  private startWatching(): void {
    const roots = new Set<string>(this.cssDirs());
    if (this.cfg.siteRoot) roots.add(this.cfg.siteRoot);
    const gitFiles = this.git ? [join(this.git.top, ".git", "HEAD"), join(this.git.top, ".git", "index")].filter(existsSync) : [];
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
    this.watcher.on("error", (err) => this.messages.push(`file watcher: ${String(err)}`));
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      try {
        for (const f of this.files.values()) {
          if (f.doc && !f.base) {
            this.touch(f);
            await this.ensureBase(f);
          }
        }
        await this.refreshClosed();
        this.publishOpenDocs();
      } catch (err: any) {
        this.messages.push(`refresh failed: ${err?.message ?? err}`);
      }
    }, 150);
  }

  async dispose(): Promise<void> {
    clearTimeout(this.refreshTimer);
    await this.watcher?.close();
    await this.renderer?.close();
    await this.pool.close();
    this.store.close();
  }
}
