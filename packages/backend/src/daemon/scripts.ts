// JavaScript edits (#5, J0–J2): which pages the edited script code reaches.
// Scans record every same-site file a page loaded with its git blob id
// (`PageRow.loaded`), so a workspace script is matched to those URL paths by
// name and its live version is read from git by that blob id. Scans also
// record which code ran while each page loaded (`PageRow.coverage`) and,
// when the scan tries the pages' interactions, after each click, hover or
// typing (`PageRow.explored`). A changed run of lines counts as exact on the
// pages where the code it replaces ran, at load or after an interaction, and
// as possible on the other pages that load the script (an interaction not
// tried may run it; or there is no coverage of the version edited). What the
// edit does at load is shown by loading a page with and without it
// (l2/render.ts, measureLoads); what it does after interactions isn't yet.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { diffLines } from "diff";
import fg from "fast-glob";
import { stepText } from "../capture/explore.js";
import { REASON, Sets, type ChangeAnswer, type Count, type FileAnswer, type RuleCount } from "../engine/contract.js";
import { SCRIPT_PATH, type SiteIndex } from "../index/siteIndex.js";
import type { LiveEdit } from "../rpc/protocol.js";
import { ranIn, type Segments } from "../util/coverage.js";
import { PageSet } from "../util/pageSet.js";
import { Doc, sha256, type TextChange } from "./documents.js";
import { blobId, readText, type BaseText, type BranchPoint, type Git, type Tab } from "./diffBase.js";
import { SheetMatcher } from "./sheetMatch.js";

export const isScriptPath = (p: string): boolean => SCRIPT_PATH.test(p);

/** What the tracker needs from the session. */
export interface ScriptHost {
  root: string;
  dataDir: string;
  index(): SiteIndex | undefined;
  git(): Git | undefined;
  tab(): Tab;
  mainChanges(): boolean;
  branchPoint(): Promise<BranchPoint | undefined>;
  /** Pages of the active linked groups (undefined: every page). */
  scope(): PageSet | undefined;
  /** Bumped when the scope changes. */
  scopeGen(): number;
  /** Bumps and returns the session's edit revision. */
  bump(): number;
  editRevision(): number;
  nextQueryId(): string;
}

/** A changed run of lines: [start, end] in the counted text (1-based; end < start: lines removed before `start`). */
export interface Hunk {
  id: string;
  start: number;
  end: number;
  /** Where it is in the base text: its first removed line, or the line the additions go before (1-based). */
  baseStart: number;
  added: number;
  removed: number;
}

interface ScriptState {
  path: string;
  doc?: Doc;
  savedText?: string;
  diskText?: string;
  /** Committed tab: the file in HEAD (undefined: not there). */
  head?: { text: string | undefined };
  base?: BaseText;
  version: number;
  editRevision: number;
  cache?: { stamp: string; result: ScriptResult };
}

export interface ScriptResult {
  hunks: Hunk[];
  answer: FileAnswer;
  /** The pages of each hunk, in `hunks` order. */
  hunkSets: Sets[];
  /** All of them together. */
  sets: Sets;
}

const ZERO: Count = { exact: 0, possible: 0, unknown: 0, complete: true };

export class ScriptTracker {
  private readonly files = new Map<string, ScriptState>();
  /** Closed files that differ from the live site (whatever the tab). */
  private liveClosed: string[] = [];
  private matcher?: SheetMatcher;
  private gen = 0;

  constructor(private readonly host: ScriptHost) {}

  /** The scan or the site changed: bases and matching start over. */
  reset(): void {
    this.matcher = undefined;
    this.gen++;
    for (const s of this.files.values()) this.touch(s, true);
  }

  private touch(s: ScriptState, base = false): void {
    if (base) {
      s.base = undefined;
      s.head = undefined;
    }
    s.version++;
    s.editRevision = this.host.bump();
  }

  /** URL paths the scan saw this file served as. */
  keysFor(path: string): string[] {
    const idx = this.host.index();
    if (!idx) return [];
    this.matcher ??= new SheetMatcher(undefined, idx, idx.scripts.byPath.keys());
    return this.matcher.keysFor(path);
  }

  /**
   * Pages that load the file (before the scope), the blob ids served (most
   * pages first), and per served blob the pages grouped by coverage hash, at
   * load and after interactions.
   */
  private loadedBy(path: string): { pages: PageSet; blobs: string[]; coverage: Map<string, Map<string, PageSet>>; after: Map<string, Map<string, PageSet>> } | undefined {
    const idx = this.host.index();
    const keys = this.keysFor(path);
    if (!idx || !keys.length) return undefined;
    const pages = PageSet.empty(idx.size);
    const blobs = new Map<string, number>();
    const coverage = new Map<string, Map<string, PageSet>>();
    const after = new Map<string, Map<string, PageSet>>();
    for (const k of keys) {
      const e = idx.scripts.byPath.get(k);
      if (!e) continue;
      pages.orInPlace(e.pages);
      for (const [b, n] of e.blobs) blobs.set(b, (blobs.get(b) ?? 0) + n);
      for (const [from, to] of [[e.coverage, coverage], [e.after, after]] as const) {
        for (const [b, byCov] of from) {
          let into = to.get(b);
          if (!into) to.set(b, (into = new Map()));
          for (const [h, set] of byCov) into.set(h, into.has(h) ? into.get(h)!.or(set) : set);
        }
      }
    }
    return { pages, blobs: [...blobs].sort((a, b) => b[1] - a[1]).map(([b]) => b), coverage, after };
  }

  // ------------------------------------------------------------ documents

  has(path: string): boolean {
    return this.files.has(resolve(path));
  }

  private state(path: string): ScriptState {
    const p = resolve(path);
    let s = this.files.get(p);
    if (!s) this.files.set(p, (s = { path: p, version: 0, editRevision: this.host.editRevision() }));
    return s;
  }

  async open(path: string, text: string, version: number): Promise<FileAnswer> {
    const s = this.state(path);
    const disk = readText(s.path);
    s.doc = new Doc(s.path, text, version, disk);
    s.savedText = disk;
    s.diskText = undefined;
    this.touch(s);
    return this.answer(s);
  }

  async change(path: string, version: number, changes: TextChange[]): Promise<FileAnswer | undefined> {
    const s = this.files.get(resolve(path));
    if (!s?.doc) return undefined;
    s.doc.change(version, changes);
    this.touch(s);
    return this.answer(s);
  }

  async save(path: string, text?: string): Promise<FileAnswer | undefined> {
    const s = this.files.get(resolve(path));
    if (!s?.doc) return undefined;
    s.doc.save(text);
    s.savedText = s.doc.text;
    this.touch(s);
    return this.answer(s);
  }

  /** false: not an open script. */
  async close(path: string): Promise<boolean> {
    const s = this.files.get(resolve(path));
    if (!s?.doc) return false;
    this.files.delete(s.path);
    this.host.bump();
    await this.refreshClosed();
    return true;
  }

  docs(): Array<{ path: string; text: string; version: number }> {
    return [...this.files.values()].filter((s) => s.doc).map((s) => ({ path: s.path, text: s.doc!.text, version: s.doc!.version }));
  }

  /** Forgets the open documents; true when there were some. */
  closeAll(): boolean {
    let closed = false;
    for (const s of [...this.files.values()]) {
      if (!s.doc) continue;
      this.files.delete(s.path);
      closed = true;
    }
    return closed;
  }

  /** Tab or branch switch: the bases and HEAD copies are reloaded. */
  rebase(): void {
    for (const s of this.files.values()) this.touch(s, true);
  }

  // ------------------------------------------------------------ closed files

  private async listScripts(): Promise<string[]> {
    const root = this.host.root;
    if (!existsSync(root)) return [];
    const found = await fg("**/*.{js,mjs,cjs}", { cwd: root, absolute: true, ignore: ["**/node_modules/**", "**/.git/**"], suppressErrors: true });
    return found.map((f) => resolve(f)).filter((f) => !f.startsWith(this.host.dataDir) && this.keysFor(f).length > 0);
  }

  /** Closed scripts whose tab version differs from the live site, like changed stylesheets. */
  async refreshClosed(): Promise<void> {
    const gen = this.gen;
    const idx = this.host.index();
    let live: string[] = [];
    let tabbed: string[] = [];
    if (idx) {
      const all = await this.listScripts();
      const bp = this.host.mainChanges() ? undefined : await this.host.branchPoint();
      live = await this.changedVsLive(bp, all);
      tabbed = this.host.tab() === "committed" ? await this.changedInHead(bp) : live;
    }
    if (gen !== this.gen) return this.refreshClosed();
    this.liveClosed = live;
    const want = new Set(tabbed);
    for (const [p, s] of this.files) if (!s.doc && !want.has(p)) this.files.delete(p);
    for (const p of want) {
      const existing = this.files.get(p);
      if (existing?.doc) continue;
      const s = existing ?? this.state(p);
      const disk = readText(p);
      if (!existing || s.diskText !== disk) {
        s.diskText = disk;
        this.touch(s);
      }
    }
    await this.prepare();
  }

  /** The watcher saw files change: open scripts' saved copies; `gitMoved`: HEAD (and maybe the branch point) too. */
  diskChanged(gitMoved: boolean, baseMoved: boolean): void {
    for (const s of this.files.values()) {
      if (gitMoved) this.touch(s, baseMoved);
      if (gitMoved && !baseMoved) s.head = undefined;
      if (!s.doc) continue;
      const disk = readText(s.path);
      if (disk !== s.savedText) {
        s.savedText = disk;
        this.touch(s);
      }
    }
  }

  /** Whether `blob` (the scanned version) is in the branch's history: the scan is older than the branch point. */
  private scanBehind(bp: BranchPoint, path: string, blob: string): Promise<boolean> {
    return this.host.git()!.committed(bp.head, path, blob, "js");
  }

  private async changedVsLive(bp: BranchPoint | undefined, all: string[]): Promise<string[]> {
    const git = this.host.git();
    const ours = bp && git ? (await git.changedSince(bp.mergeBase, [this.host.root], "js")).map((f) => resolve(f)) : [];
    const branchChanged = new Set(ours);
    const out: string[] = [];
    for (const f of new Set([...ours, ...all])) {
      const blobs = this.loadedBy(f)?.blobs;
      if (!blobs?.length) continue;
      const t = readText(f);
      if (t === undefined ? !branchChanged.has(f) : blobs.includes(blobId(Buffer.from(t)))) continue;
      if (!bp || branchChanged.has(f) || (await this.scanBehind(bp, f, blobs[0]))) out.push(f);
    }
    return out;
  }

  private async changedInHead(bp: BranchPoint | undefined): Promise<string[]> {
    const git = this.host.git();
    if (!git) return [];
    const dirs = [this.host.root];
    const [head, ours] = await Promise.all([git.headFiles(dirs, "js"), bp ? git.changedBetween(bp.mergeBase, "HEAD", dirs, "js") : Promise.resolve([])]);
    const branchChanged = new Set(ours);
    const out: string[] = [];
    for (const f of new Set([...head.keys(), ...ours])) {
      const blobs = this.loadedBy(f)?.blobs;
      if (!blobs?.length) continue;
      const id = head.get(f);
      if (id === undefined ? !branchChanged.has(f) : blobs.includes(id)) continue;
      if (!bp || branchChanged.has(f) || (await this.scanBehind(bp, f, blobs[0]))) out.push(f);
    }
    return out;
  }

  // ------------------------------------------------------------------ base

  private async ensureBase(s: ScriptState): Promise<void> {
    if (!s.base) {
      s.base = await this.loadBase(s.path);
      s.version++;
    }
    if (this.host.tab() === "committed" && !s.head) {
      s.head = { text: await this.host.git()?.show(s.path) };
      s.version++;
    }
  }

  /** The live version (by the blob id most pages got); else HEAD or the saved file, with why. */
  private async loadBase(path: string): Promise<BaseText> {
    const live = await this.productionBase(path);
    if (live) return live;
    const note = this.loadedBy(path) ? "the live version isn't in this repository" : "no scanned page loads this script";
    const git = this.host.git();
    if (git) return { text: await git.show(path), kind: "HEAD", note };
    return { text: readText(path), kind: "saved", note };
  }

  private async productionBase(path: string): Promise<BaseText | undefined> {
    const git = this.host.git();
    const blob = this.loadedBy(path)?.blobs[0];
    if (!git || !blob) return undefined;
    const live = await git.blob(blob);
    if (live === undefined) return undefined;
    // On a branch, diff against where it left the deployed branch: newer commits there aren't "my edits".
    const bp = await this.host.branchPoint();
    if (!bp || this.host.mainChanges() || (await this.scanBehind(bp, path, blob))) return { text: live, kind: "production" };
    const text = await git.show(path, bp.mergeBase);
    return text !== undefined ? { text, kind: "production", live } : { text: live, kind: "production" };
  }

  /** Loads what the answers need (bases, HEAD copies). */
  async prepare(): Promise<void> {
    for (const s of this.files.values()) await this.ensureBase(s);
  }

  // -------------------------------------------------------------- answers

  private tabText(s: ScriptState, tab: Tab): string | undefined {
    switch (tab) {
      case "all":
        return s.doc ? s.doc.text : s.diskText;
      case "uncommitted":
        return s.doc ? s.savedText : s.diskText;
      case "committed":
        return s.head ? s.head.text : s.base?.text;
    }
  }

  /** The pages (in scope) that load a script, and why none when empty. */
  private pagesOf(path: string): { pages: PageSet; reason?: string; urls: string[]; by?: NonNullable<ReturnType<ScriptTracker["loadedBy"]>> } {
    const idx = this.host.index();
    if (!idx) return { pages: PageSet.empty(0), reason: REASON.noIndex, urls: [] };
    const by = this.loadedBy(path);
    const urls = this.keysFor(path);
    if (!by) return { pages: PageSet.empty(idx.size), reason: REASON.scriptNotLoaded, urls };
    const scope = this.host.scope();
    const pages = by.pages.and(idx.all);
    if (scope) pages.andInPlace(scope);
    const reason = !pages.isEmpty() ? undefined : scope?.isEmpty() ? REASON.noScope : REASON.outsideScope;
    return { pages, reason, urls, by };
  }

  /**
   * One hunk's pages: exact where the code it replaces ran (the coverage of
   * the base version) at load or after an interaction tried, possible on the
   * other pages loading it. `after`: the pages where it ran only after one,
   * with the interactions that ran it on one of them.
   */
  private hunkPages(
    path: string,
    h: Hunk,
    base: BaseText | undefined,
    lines: number[],
    loaders: PageSet,
    by: ReturnType<ScriptTracker["loadedBy"]>,
  ): { sets: Sets; reasons: string[]; after?: ChangeAnswer["after"] } {
    const idx = this.host.index()!;
    const sets = Sets.empty(idx.size);
    const covered = PageSet.empty(idx.size);
    const atLoad = PageSet.empty(idx.size);
    const afterHit = PageSet.empty(idx.size);
    const text = base?.text;
    const blob = text !== undefined && base?.kind === "production" ? blobId(Buffer.from(text)) : undefined;
    const spans = blob && text !== undefined ? baseSpans(text, lines, h) : [];
    const hits = (segs: Segments): boolean => spans.some(([a, b]) => ranIn(segs, a, b));
    for (const [byCov, into] of [[blob && by?.coverage.get(blob), atLoad], [blob && by?.after.get(blob), afterHit]] as const) {
      if (!byCov) continue;
      for (const [hash, pages] of byCov) {
        const segs = idx.coverage(hash);
        if (!segs) continue;
        const p = pages.and(loaders);
        covered.orInPlace(p);
        if (hits(segs)) into.orInPlace(p);
      }
    }
    const afterOnly = afterHit.andNot(atLoad);
    sets.exact = atLoad.or(afterOnly);
    sets.possible = loaders.andNot(sets.exact);
    const reasons: string[] = [];
    if (!atLoad.isEmpty()) reasons.push(REASON.scriptRuns);
    if (!afterOnly.isEmpty()) reasons.push(REASON.scriptRunsAfter);
    const notRun = covered.andNot(sets.exact);
    if (!notRun.and(idx.explored).isEmpty()) reasons.push(REASON.scriptNotReached);
    if (!notRun.andNot(idx.explored).isEmpty()) reasons.push(REASON.scriptNotRun);
    if (!loaders.andNot(covered).isEmpty()) reasons.push(covered.isEmpty() ? REASON.scriptLoaded : REASON.scriptNoCoverage);
    if (afterOnly.isEmpty()) return { sets, reasons };
    return { sets, reasons, after: { pages: afterOnly.count(), example: this.afterExample(path, blob!, afterOnly, hits) } };
  }

  /** The fewest interactions found to run the edited code, on one of the first pages where they do. */
  private afterExample(path: string, blob: string, pages: PageSet, hits: (s: Segments) => boolean): { url: string; steps: string[] } | undefined {
    const idx = this.host.index()!;
    const keys = this.keysFor(path);
    let best: { url: string; steps: string[] } | undefined;
    let n = 0;
    for (const id of pages.ids()) {
      if (++n > 10) break;
      const row = idx.pages[id];
      if (!row) continue;
      const own = keys.filter((k) => row.loaded?.[k] === blob);
      const actions = idx.actions(row);
      for (const a of actions) {
        if (a.inherited || (best && a.depth >= best.steps.length)) continue;
        if (!own.some((k) => a.ran[k] && hits(a.ran[k]))) continue;
        const chain: string[] = [];
        for (let x: (typeof actions)[number] | undefined = a; x; x = x.parent >= 0 ? actions[x.parent] : undefined) chain.unshift(stepText(x));
        best = { url: row.url, steps: chain };
      }
      if (best?.steps.length === 1) break;
    }
    return best;
  }

  private result(s: ScriptState, tab: Tab): ScriptResult {
    const idx = this.host.index();
    const stamp = [s.version, idx?.revision.id ?? "-", tab, this.host.scopeGen()].join("|");
    if (s.cache?.stamp === stamp) return s.cache.result;
    const t0 = performance.now();
    const text = this.tabText(s, tab) ?? "";
    // Not loaded yet (the scan or tab just changed): nothing to count until it is.
    const hunks = s.base ? diffHunks(s.base.text ?? "", text) : [];
    const { pages: loaders, reason, urls, by } = this.pagesOf(s.path);
    const lines = lineStarts(s.base?.text ?? "");
    const per = hunks.map((h): ReturnType<ScriptTracker["hunkPages"]> =>
      idx && !reason ? this.hunkPages(s.path, h, s.base, lines, loaders, by) : { sets: Sets.empty(idx?.size ?? 0), reasons: [reason!] },
    );
    const sets = Sets.empty(idx?.size ?? 0);
    for (const p of per) sets.orInPlace(p.sets);
    const countOf = (x: Sets): Count => (idx ? { ...x.count(false), complete: true } : { ...ZERO, complete: false });
    const count = countOf(sets);
    const changes: ChangeAnswer[] = hunks.map((h, i) => ({ id: h.id, kind: "script", line: Math.max(1, Math.min(h.start, h.end)), selector: hunkLabel(h), pages: countOf(per[i].sets), conditions: [], reasons: per[i].reasons, ...(per[i].after ? { after: per[i].after } : {}) }));
    const totalReasons = reason ? [reason] : [...new Set(per.flatMap((p) => p.reasons))];
    if (s.base?.note) totalReasons.push(`diff-base:${s.base.kind} (${s.base.note})`);
    if (!hunks.length) totalReasons.push(REASON.noEffectiveChange);
    const answer: FileAnswer = {
      queryId: this.host.nextQueryId(),
      level: 0,
      indexRevision: idx?.revision.id ?? null,
      editRevision: s.editRevision,
      file: s.path,
      diffBase: s.base?.kind ?? "production",
      editing: false,
      total: hunks.length ? count : { ...ZERO, complete: !!idx },
      totalReasons,
      changes,
      mapping: { mapped: urls.length > 0, urls, linkedPages: loaders.count() },
      freshness: null,
      basis: "LOCAL_INDEX",
      timingMs: Math.round((performance.now() - t0) * 100) / 100,
      ...(s.doc && tab !== "all" && text !== s.doc.text ? { matchesEditor: false } : {}),
    };
    const result = { hunks, answer, sets, hunkSets: per.map((p) => p.sets) };
    s.cache = { stamp, result };
    return result;
  }

  private require(path: string): ScriptState {
    const s = this.files.get(resolve(path));
    if (s) return s;
    const p = resolve(path);
    const text = readText(p);
    return { path: p, diskText: text, version: 0, editRevision: this.host.editRevision(), base: { text, kind: "saved" } };
  }

  answerFor(path: string): FileAnswer {
    return this.result(this.require(path), this.host.tab()).answer;
  }

  private async answer(s: ScriptState): Promise<FileAnswer> {
    await this.ensureBase(s);
    return this.result(s, this.host.tab()).answer;
  }

  /** Changed scripts for the session total (bases must be loaded: `prepare`). */
  changed(): Array<{ path: string; open: boolean; r: ScriptResult }> {
    const tab = this.host.tab();
    const out: Array<{ path: string; open: boolean; r: ScriptResult }> = [];
    for (const s of this.files.values()) {
      if (!s.base) continue;
      const r = this.result(s, tab);
      if (r.hunks.length) out.push({ path: s.path, open: !!s.doc, r });
    }
    return out;
  }

  /**
   * Changed scripts as the page diffs apply them, with only the edits `keep`
   * picks: the URL paths each is served at, its base, and its text then.
   */
  renderable(keep: (path: string, id: string) => boolean): Array<{ path: string; keys: string[]; base?: BaseText; text: string; applied: number; of: number }> {
    const tab = this.host.tab();
    const out: Array<{ path: string; keys: string[]; base?: BaseText; text: string; applied: number; of: number }> = [];
    for (const { path, r } of this.changed()) {
      const s = this.files.get(path)!;
      const ids = new Set(r.hunks.filter((h) => keep(path, h.id)).map((h) => h.id));
      if (!ids.size) continue;
      const full = this.tabText(s, tab) ?? "";
      const text = ids.size === r.hunks.length ? full : applyHunks(s.base?.text ?? "", full, (h) => ids.has(h.id));
      out.push({ path, keys: this.keysFor(path), base: s.base, text, applied: ids.size, of: r.hunks.length });
    }
    return out;
  }

  /** The editor's per-line counts: each changed run of lines is a "rule". */
  rules(path: string): RuleCount[] {
    // The editor's lines: the open text, or the file on disk.
    const r = this.result(this.require(path), "all");
    return r.answer.changes.map((c, i) => {
      const h = r.hunks[i];
      return { line: c.line, endLine: Math.max(c.line, h.end), selector: c.selector!, pages: c.pages, conditions: [], reasons: c.reasons };
    });
  }

  /** The pages of one file (or one of its edits; or the one on a line). */
  sets(path: string, changeId?: string, line?: number): { sets: Sets; editRevision: number } {
    const s = this.require(path);
    const tab = line !== undefined && !changeId ? "all" : this.host.tab();
    const r = this.result(s, tab);
    let i = -1;
    if (changeId) {
      i = r.hunks.findIndex((h) => h.id === changeId);
      if (i < 0) throw new Error(`change ${changeId} no longer exists`);
    } else if (line !== undefined) {
      i = r.hunks.findIndex((h) => line >= Math.min(h.start, h.end) && line <= Math.max(h.start, h.end));
      if (i < 0) throw new Error(`no edit on line ${line}`);
    }
    return { sets: i < 0 ? r.sets : r.hunkSets[i], editRevision: s.editRevision };
  }

  detail(path: string, changeId: string): { line: number; summary: string; editRevision: number } | undefined {
    const s = this.require(path);
    const r = this.result(s, this.host.tab());
    const h = r.hunks.find((x) => x.id === changeId);
    if (!h) return undefined;
    const parts = [h.added && `${h.added} line${h.added === 1 ? "" : "s"} added`, h.removed && `${h.removed} removed`].filter(Boolean);
    return { line: Math.max(1, Math.min(h.start, h.end)), summary: `${hunkLabel(h)}: ${parts.join(", ")}`, editRevision: s.editRevision };
  }

  // ------------------------------------------------------- live highlights

  /** Scripts that differ from the live site (open ones, and closed ones on disk), with each edit's lines. */
  async liveEdits(): Promise<Array<{ file: string; open: boolean; pages: Count; edits: LiveEdit[] }>> {
    const out: Array<{ file: string; open: boolean; pages: Count; edits: LiveEdit[] }> = [];
    const paths = new Set([...[...this.files.values()].filter((s) => s.doc).map((s) => s.path), ...this.liveClosed]);
    for (const p of paths) {
      const s = this.files.get(p) ?? this.require(p);
      if (!s.doc && s.diskText === undefined) s.diskText = readText(p);
      await this.ensureBase(s);
      if (s.base?.kind !== "production") continue;
      const r = this.result(s, "all");
      if (!r.hunks.length) continue;
      const edits = r.answer.changes.map((c, i) => ({ ...c, ranges: hunkRanges(r.hunks[i]) }));
      out.push({ file: s.path, open: !!s.doc, pages: r.answer.total, edits });
    }
    return out;
  }

  /** The live version of the file (the editor's change bars); null when there is none. */
  async liveOriginal(path: string): Promise<string | null> {
    const s = this.require(path);
    await this.ensureBase(s);
    return s.base?.kind === "production" ? s.base.text ?? "" : null;
  }
}

/** Changed runs of lines from `before` to `after`, with ids stable while the run's content is. */
export function diffHunks(before: string, after: string): Hunk[] {
  return diffPieces(before, after).hunks;
}

/** `before` with only the changed runs `keep` picks from `after`. */
export function applyHunks(before: string, after: string, keep: (h: Hunk) => boolean): string {
  const { hunks, pieces } = diffPieces(before, after);
  return pieces.map((p) => (typeof p === "string" ? p : keep(hunks[p.hunk]) ? p.added : p.removed)).join("");
}

/** The diff's hunks, and its text as unchanged runs and the hunks' removed and added text, in order. */
function diffPieces(before: string, after: string): { hunks: Hunk[]; pieces: Array<string | { hunk: number; removed: string; added: string }> } {
  const out: Hunk[] = [];
  const pieces: Array<string | { hunk: number; removed: string; added: string }> = [];
  const seen = new Map<string, number>();
  let line = 1;
  let baseLine = 1;
  let cur: { start: number; baseStart: number; added: string[]; removed: string[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const key = sha256(`${cur.removed.join("")}\0${cur.added.join("")}`).slice(0, 12);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    pieces.push({ hunk: out.length, removed: cur.removed.join(""), added: cur.added.join("") });
    out.push({ id: `s:${key}:${n}`, start: cur.start, end: cur.start + cur.added.length - 1, baseStart: cur.baseStart, added: cur.added.length, removed: cur.removed.length });
    cur = undefined;
  };
  for (const part of diffLines(before, after)) {
    const lines = splitLines(part.value);
    if (!part.added && !part.removed) {
      flush();
      pieces.push(part.value);
      line += lines.length;
      baseLine += lines.length;
      continue;
    }
    cur ??= { start: line, baseStart: baseLine, added: [], removed: [] };
    if (part.added) {
      cur.added.push(...lines);
      line += lines.length;
    } else {
      cur.removed.push(...lines);
      baseLine += lines.length;
    }
  }
  flush();
  return { hunks: out, pieces };
}

/** Offsets where each line starts (index 0: line 1). */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/**
 * The base text a hunk replaces, as offset spans to look up in coverage:
 * each removed line without its surrounding whitespace (a closing brace
 * belongs to its function, not the newline after it), or for added lines
 * only, the point they are inserted at.
 */
function baseSpans(text: string, starts: number[], h: Hunk): Array<[number, number]> {
  const lineStart = (n: number) => (n - 1 < starts.length ? starts[n - 1] : text.length);
  if (!h.removed) {
    const at = Math.min(lineStart(h.baseStart), Math.max(0, text.length - 1));
    return [[at, at]];
  }
  const out: Array<[number, number]> = [];
  for (let n = h.baseStart; n < h.baseStart + h.removed; n++) {
    let a = lineStart(n);
    let b = lineStart(n + 1);
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    out.push(a < b ? [a, b] : [lineStart(n), lineStart(n)]);
  }
  return out;
}

function splitLines(v: string): string[] {
  const parts = v.split(/(?<=\n)/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function hunkLabel(h: Hunk): string {
  if (h.added === 0) return `Lines removed before line ${h.start}`;
  return h.added === 1 ? `Line ${h.start}` : `Lines ${h.start}–${h.end}`;
}

/** The editor lines to highlight: the added ones, else the line the removal is at. */
function hunkRanges(h: Hunk): Array<[number, number]> {
  if (h.added) return [[h.start, h.end]];
  const at = Math.max(1, h.start - 1);
  return [[at, at]];
}
