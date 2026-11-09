// A VS Code project on the server: one analysis session per site it has
// linked groups on, fed the same documents, tab and selection. Answers are
// combined: page counts add up (a site's pages are its own), page lists are
// joined, and page-level calls go to the page's site.

import { EventEmitter } from "node:events";
import type { Session, SharedResources } from "../daemon/session.js";
import { Session as SessionClass } from "../daemon/session.js";
import type { ChangeAnswer, Count, FileAnswer, RuleCount } from "../engine/contract.js";
import type { RpcPeer } from "../rpc/connection.js";
import {
  ERR,
  RpcError,
  type AssessParams,
  type AssessProgress,
  type ChangeDetail,
  type DocResult,
  type DrilldownParams,
  type DrilldownResult,
  type EditSelection,
  type GetPagesParams,
  type IndexStatus,
  type LiveEditsResult,
  type LiveOriginal,
  type OpenLiveParams,
  type PageDiffParams,
  type PageDiffView,
  type PageItem,
  type PagesResult,
  type RulesResult,
  type SessionTotal,
  type SetSelectionResult,
} from "../rpc/protocol.js";
import type { Tab } from "../daemon/diffBase.js";
import type { TextChange } from "../daemon/documents.js";
import type { Site } from "./site.js";

export interface ProjectHost {
  /** The sites of the linked groups, in server order. */
  sitesFor(linked: string[]): Site[];
  /** No site linked: the site whose session answers (the first one), if any. */
  fallback(): Site | undefined;
  /** No site at all: resources with an empty index. */
  blank(): SharedResources;
}

interface Member {
  /** The site's id ("" for the blank one). */
  key: string;
  site?: Site;
  session: Session;
  assess?: AssessProgress;
}

const ZERO: Count = { exact: 0, possible: 0, unknown: 0, complete: true };

function add(a: Count, b: Count): Count {
  return { exact: a.exact + b.exact, possible: a.possible + b.possible, unknown: a.unknown + b.unknown, complete: a.complete && b.complete };
}

const any = (c: Count) => c.exact + c.possible + c.unknown > 0;

/** Reasons of the sites that reach pages; when none does, every site's (why it's zero). */
function reasons(list: Array<{ count: Count; reasons: string[] }>): string[] {
  const hit = list.filter((x) => any(x.count));
  return [...new Set((hit.length ? hit : list).flatMap((x) => x.reasons))];
}

const union = <T>(lists: T[][]): T[] => [...new Set(lists.flat())];

function mergeChange(list: ChangeAnswer[]): ChangeAnswer {
  if (list.length === 1) return list[0];
  const sum = (k: "gained" | "lost") => (list.some((c) => c[k]) ? list.reduce((s, c) => (c[k] ? add(s, c[k]!) : s), ZERO) : undefined);
  const gained = sum("gained");
  const lost = sum("lost");
  return {
    ...list[0],
    pages: list.reduce((s, c) => add(s, c.pages), ZERO),
    ...(gained ? { gained } : {}),
    ...(lost ? { lost } : {}),
    conditions: union(list.map((c) => c.conditions)),
    reasons: reasons(list.map((c) => ({ count: c.pages, reasons: c.reasons }))),
  };
}

/** Items with the same id across sites, in first-seen order. */
function byKey<T>(lists: T[][], key: (x: T) => string | number): T[][] {
  const out = new Map<string | number, T[]>();
  for (const list of lists) {
    for (const x of list) {
      const k = key(x);
      const have = out.get(k);
      if (have) have.push(x);
      else out.set(k, [x]);
    }
  }
  return [...out.values()];
}

export class Project extends EventEmitter {
  private members: Member[] = [];
  readonly peers = new Set<RpcPeer>();
  linked: string[] = [];
  serial: Promise<unknown> = Promise.resolve();
  /** editRevision:selectionRevision last announced to diff viewers. */
  sentEdit = "";
  idle?: NodeJS.Timeout;
  private selection?: EditSelection | null;
  private readonly revs = new Map<string, { key: string; n: number }>();

  constructor(
    readonly id: string,
    readonly root: string,
    readonly name: string,
    private readonly host: ProjectHost,
  ) {
    super();
  }

  // ------------------------------------------------------------- members

  /** The session on a site, if the project has one there. */
  sessionOn(siteId: string): Session | undefined {
    return this.members.find((m) => m.key === siteId)?.session;
  }

  sessions(): Session[] {
    return this.members.map((m) => m.session);
  }

  /** Sites spanned: group names get the site's name when there's more than one. */
  private get multi(): boolean {
    return this.members.length > 1;
  }

  private label(m: Member, group: string): string {
    return this.multi && m.site ? `${group} · ${m.site.name}` : group;
  }

  private member(site?: string): Member {
    if (!site) return this.members[0];
    const m = this.members.find((x) => x.key === site);
    if (!m) throw new RpcError(ERR.invalidParams, "that site isn't linked to this project any more");
    return m;
  }

  /**
   * Links the project to these groups (ids from any site): starts a session on
   * each newly linked site with the open documents, stops the unlinked ones.
   */
  async relink(linked: string[]): Promise<SessionTotal> {
    this.linked = linked;
    const sites = this.host.sitesFor(linked);
    const fallback = sites.length ? undefined : this.host.fallback();
    const wanted: Array<{ key: string; site?: Site }> = sites.length ? sites.map((s) => ({ key: s.id, site: s })) : [{ key: fallback?.id ?? "", site: fallback }];
    const state = this.members[0]?.session.editorState();
    const keep = new Map(this.members.map((m) => [m.key, m]));
    const next: Member[] = [];
    for (const w of wanted) {
      const scope = w.site?.scopeFor(linked) ?? [];
      const have = keep.get(w.key);
      if (have && have.site === w.site) {
        keep.delete(w.key);
        have.session.setScope(scope);
        next.push(have);
        continue;
      }
      const session = await SessionClass.create({ workspaceRoot: this.root, shared: w.site?.shared ?? this.host.blank(), scope });
      if (state) {
        await session.setTab(state.tab, state.mainChanges);
        for (const d of state.docs) await session.open(d.path, d.text, d.version);
      }
      if (this.selection !== undefined) session.setSelection(this.selection);
      const m: Member = { key: w.key, site: w.site, session };
      this.wire(m);
      next.push(m);
    }
    this.members = next;
    for (const m of keep.values()) {
      m.session.removeAllListeners();
      await m.session.dispose();
    }
    this.emit("status", this.status());
    this.emit("publish", { session: this.sessionTotal() });
    return this.sessionTotal();
  }

  private wire(m: Member): void {
    const s = m.session;
    const mine = () => this.members.includes(m);
    s.on("refined", (x: { answer: FileAnswer; rules: boolean }) => {
      if (!mine()) return;
      const answer = this.fileAnswer(x.answer.file);
      this.emit("refined", { answer: { ...answer, level: Math.min(answer.level, x.answer.level) as 0 | 1 }, session: this.sessionTotal(), rules: x.rules });
    });
    s.on("publish", () => mine() && this.emit("publish", { session: this.sessionTotal() }));
    s.on("status", () => mine() && this.emit("status", this.status()));
    s.on("revision", (x: { result?: unknown }) => mine() && this.emit("revision", { indexRevision: this.indexRevision(), result: x.result }));
    s.on("captureProgress", (x) => mine() && this.emit("captureProgress", x));
    s.on("degraded", (x) => mine() && this.emit("degraded", x));
    s.on("externalChange", (x: { files: string[]; before?: Count }) => {
      if (!mine()) return;
      // The other sites' totals didn't move.
      const before = x.before && this.members.reduce((sum, o) => add(sum, o === m ? x.before! : o.session.sessionTotal().total), ZERO);
      this.emit("externalChange", { files: x.files, session: this.sessionTotal(), ...(before ? { before } : {}) });
    });
    s.on("assess", (x: AssessProgress) => {
      if (!mine()) return;
      m.assess = x;
      this.emit("assess", this.assessProgress());
    });
    s.on("selection", () => mine() && this.emit("selection", { selectionRevision: this.selectionRevision }));
  }

  // ----------------------------------------------------------- revisions

  /** A number that goes up whenever the sites' own numbers change (sessions come and go). */
  private rev(name: string, key: string): number {
    let r = this.revs.get(name);
    if (!r) this.revs.set(name, (r = { key, n: 1 }));
    else if (r.key !== key) {
      r.key = key;
      r.n++;
    }
    return r.n;
  }

  get editRevision(): number {
    return this.rev("edit", this.members.map((m) => `${m.key}:${m.session.editRevision}`).join());
  }

  get selectionRevision(): number {
    return this.rev("selection", this.members.map((m) => `${m.key}:${m.session.selectionRevision}`).join());
  }

  private indexRevision(): number | null {
    if (!this.members.some((m) => m.session.index)) return null;
    return this.rev("index", this.members.map((m) => `${m.key}:${m.session.index?.revision.id ?? "-"}`).join());
  }

  private fileRevision(path: string, revs: number[]): number {
    return this.rev(`file:${path}`, this.members.map((m, i) => `${m.key}:${revs[i]}`).join());
  }

  private checkRevision(asked?: number): void {
    const have = this.editRevision;
    if (asked !== undefined && asked < have) throw new RpcError(ERR.superseded, `edit revision ${asked} was superseded by ${have}`, { editRevision: have });
  }

  // ------------------------------------------------------------- answers

  status(): IndexStatus {
    const all = this.members.map((m) => ({ m, s: m.session.status() }));
    const first = all[0].s;
    const health = all.some((x) => x.s.health === "BLOCKED") ? "BLOCKED" : all.some((x) => x.s.health === "DEGRADED") ? "DEGRADED" : "READY";
    const captured = all.map((x) => x.s.capturedAt).filter((c): c is string => !!c).sort();
    const caps = all.map((x) => x.s.capture).filter((c): c is NonNullable<IndexStatus["capture"]> => !!c);
    const scopes = all.filter((x) => x.s.scope);
    return {
      ...first,
      health,
      ready: all.some((x) => x.s.ready),
      indexRevision: this.indexRevision(),
      ...(captured.length ? { capturedAt: captured[captured.length - 1] } : {}),
      pages: all.reduce((n, x) => n + x.s.pages, 0),
      okPages: all.reduce((n, x) => n + x.s.okPages, 0),
      failedPages: all.reduce((n, x) => n + x.s.failedPages, 0),
      variants: union(all.map((x) => x.s.variants)),
      markupChanged: all.some((x) => x.s.markupChanged),
      ...(caps.length
        ? { capture: { running: caps.some((c) => c.running), done: caps.reduce((n, c) => n + c.done, 0), total: caps.reduce((n, c) => n + c.total, 0), ...(caps.find((c) => c.error) ? { error: caps.find((c) => c.error)!.error } : {}) } }
        : {}),
      ...(scopes.length
        ? {
            scope: {
              linked: scopes.some((x) => x.s.scope!.linked),
              groups: scopes.flatMap((x) => x.s.scope!.groups.map((g) => ({ ...g, name: this.label(x.m, g.name) }))),
              pages: scopes.reduce((n, x) => n + x.s.scope!.pages, 0),
            },
          }
        : {}),
      limitations: union(all.map((x) => x.s.limitations)),
      messages: union(all.map((x) => x.s.messages)),
    };
  }

  sessionTotal(): SessionTotal {
    const all = this.members.map((m) => m.session.sessionTotal());
    const files = byKey(
      all.map((t) => t.files),
      (f) => f.file,
    ).map((list) => ({ file: list[0].file, pages: list.reduce((s, f) => add(s, f.pages), ZERO), changes: Math.max(...list.map((f) => f.changes)), open: list.some((f) => f.open) }));
    const total = all.reduce((s, t) => add(s, t.total), ZERO);
    const branch = all.find((t) => t.branch)?.branch;
    return {
      editRevision: this.editRevision,
      indexRevision: this.indexRevision(),
      tab: all[0].tab,
      total,
      reasons: reasons(all.map((t) => ({ count: t.total, reasons: t.reasons }))),
      files,
      ...(branch ? { branch } : {}),
    };
  }

  fileAnswer(path: string): FileAnswer {
    const all = this.members.map((m) => m.session.fileAnswer(path));
    const first = all[0];
    const fresh = all.map((a) => a.freshness).filter((f): f is NonNullable<FileAnswer["freshness"]> => !!f);
    fresh.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return {
      ...first,
      level: Math.min(...all.map((a) => a.level)) as 0 | 1,
      indexRevision: this.indexRevision(),
      editRevision: this.fileRevision(first.file, all.map((a) => a.editRevision)),
      ...(all.some((a) => a.matchesEditor === false) ? { matchesEditor: false } : {}),
      editing: all.some((a) => a.editing),
      total: all.reduce((s, a) => add(s, a.total), ZERO),
      totalReasons: reasons(all.map((a) => ({ count: a.total, reasons: a.totalReasons }))),
      changes: byKey(
        all.map((a) => a.changes),
        (c) => c.id,
      ).map(mergeChange),
      mapping: { mapped: all.some((a) => a.mapping.mapped), urls: union(all.map((a) => a.mapping.urls)), linkedPages: all.reduce((n, a) => n + a.mapping.linkedPages, 0) },
      freshness: fresh[0] ?? null,
      timingMs: Math.max(...all.map((a) => a.timingMs)),
    };
  }

  ruleCounts(path: string): RulesResult {
    const all = this.members.map((m) => m.session.ruleCounts(path));
    const rules = byKey(
      all.map((r) => r.rules),
      (r) => r.line,
    ).map(
      (list): RuleCount =>
        list.length === 1
          ? list[0]
          : {
              ...list[0],
              pages: list.reduce((s, r) => add(s, r.pages), ZERO),
              conditions: union(list.map((r) => r.conditions)),
              reasons: reasons(list.map((r) => ({ count: r.pages, reasons: r.reasons }))),
            },
    );
    return {
      file: all[0].file,
      editRevision: this.fileRevision(this.members[0].session.fileAnswer(path).file, all.map((r) => r.editRevision)),
      indexRevision: this.indexRevision(),
      level: Math.min(...all.map((r) => r.level)) as 0 | 1,
      rules,
    };
  }

  changeDetail(path: string, changeId: string): ChangeDetail {
    let err: unknown;
    for (const m of this.members) {
      try {
        return { ...m.session.changeDetail(path, changeId), editRevision: this.fileAnswer(path).editRevision };
      } catch (e) {
        err = e;
      }
    }
    throw err;
  }

  async liveEdits(): Promise<LiveEditsResult> {
    const all = await Promise.all(this.members.map((m) => m.session.liveEdits()));
    const files = byKey(
      all.map((r) => r.files),
      (f) => f.file,
    ).map((list) => ({
      file: list[0].file,
      open: list.some((f) => f.open),
      pages: list.reduce((s, f) => add(s, f.pages), ZERO),
      edits: byKey(
        list.map((f) => f.edits),
        (e) => e.id,
      ).map((es) => ({ ...es[0], ...mergeChange(es), ranges: es[0].ranges })),
    }));
    const branch = all.find((r) => r.branch)?.branch;
    return { editRevision: this.editRevision, indexRevision: this.indexRevision(), files, ...(branch ? { branch } : {}) };
  }

  /** Compared with the site that loaded the file most recently. */
  async liveOriginal(path: string): Promise<LiveOriginal> {
    const order = [...this.members].sort((a, b) => (b.session.index?.revision.createdAt ?? "").localeCompare(a.session.index?.revision.createdAt ?? ""));
    for (const m of order) {
      const r = await m.session.liveOriginal(path);
      if (r.text !== null) return r;
    }
    return { path, text: null };
  }

  // ----------------------------------------------------------- page lists

  /** The member a page-list group filter names, and the group's own name there. */
  private groupFilter(group?: string): { m?: Member; group?: string } {
    if (!group) return {};
    for (const m of this.members) for (const g of m.site?.scopeFor(this.linked) ?? []) if (this.label(m, g.name) === group) return { m, group: g.name };
    return { group };
  }

  async getPages(p: GetPagesParams): Promise<PagesResult> {
    this.checkRevision(p.editRevision);
    const offset = Math.max(0, p.offset ?? 0);
    const limit = Math.min(Math.max(1, p.limit ?? 200), 2000);
    const filter = this.groupFilter(p.group);
    const runs = await Promise.allSettled(
      this.members.map((m) =>
        filter.m && filter.m !== m
          ? m.session.getPages({ ...p, group: undefined, offset: 0, limit: 1, editRevision: undefined }).then((r) => ({ m, r, only: "groups" as const }))
          : m.session.getPages({ ...p, group: filter.group, offset: 0, limit: offset + limit, editRevision: undefined }).then((r) => ({ m, r, only: undefined })),
      ),
    );
    const ok = runs.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
    if (!ok.length) throw (runs[0] as PromiseRejectedResult).reason;
    const listed = ok.filter((x) => !x.only);
    const site = (m: Member, it: PageItem): PageItem => ({
      ...it,
      ...(m.site ? { site: m.site.id, siteName: m.site.name } : {}),
      ...(it.groups ? { groups: it.groups.map((g) => this.label(m, g)) } : {}),
    });
    const items = listed.flatMap((x) => x.r.pages.map((it) => site(x.m, it)));
    const running = listed.some((x) => x.r.assessment.running);
    if (!running && listed.length > 1) {
      const rank = (it: PageItem) => (!it.impact ? 1 : it.impact.status === "changed" ? 0 : it.impact.status === "inconclusive" ? 2 : 3);
      items.sort((a, b) => rank(a) - rank(b) || (b.impact?.changed ?? 0) - (a.impact?.changed ?? 0) || (b.impact?.moved ?? 0) - (a.impact?.moved ?? 0));
    }
    const as = listed.map((x) => x.r.assessment);
    return {
      editRevision: this.editRevision,
      indexRevision: this.indexRevision() ?? 0,
      level: 1,
      count: listed.reduce((s, x) => add(s, x.r.count), ZERO),
      groups: ok.flatMap((x) => x.r.groups.map((g) => ({ ...g, name: this.label(x.m, g.name) }))),
      total: listed.reduce((n, x) => n + x.r.total, 0),
      offset,
      pages: items.slice(offset, offset + limit),
      assessment: {
        running,
        done: as.reduce((n, a) => n + a.done, 0),
        total: as.reduce((n, a) => n + a.total, 0),
        assessed: as.reduce((n, a) => n + a.assessed, 0),
        pending: as.reduce((n, a) => n + a.pending, 0),
        changed: as.reduce((n, a) => n + a.changed, 0),
        maxChanged: Math.max(0, ...as.map((a) => a.maxChanged)),
      },
    };
  }

  private assessProgress(): AssessProgress {
    const all = this.members.map((m) => m.assess).filter((a): a is AssessProgress => !!a);
    return {
      editRevision: this.editRevision,
      indexRevision: this.indexRevision(),
      running: all.some((a) => a.running),
      done: all.reduce((n, a) => n + a.done, 0),
      total: all.reduce((n, a) => n + a.total, 0),
      ...(all.some((a) => a.cancelled) ? { cancelled: true } : {}),
    };
  }

  async assess(p: AssessParams): Promise<AssessProgress> {
    const filter = this.groupFilter(p.group);
    const targets = filter.m ? [filter.m] : this.members;
    for (const m of this.members) if (!targets.includes(m)) m.assess = undefined;
    const runs = await Promise.allSettled(targets.map(async (m) => (m.assess = await m.session.assess({ ...p, group: filter.group }))));
    if (!runs.some((r) => r.status === "fulfilled")) throw (runs[0] as PromiseRejectedResult).reason;
    return this.assessProgress();
  }

  async drilldown(p: DrilldownParams & { site?: string }): Promise<DrilldownResult> {
    this.checkRevision(p.editRevision);
    const r = await this.member(p.site).session.drilldown({ ...p, editRevision: undefined });
    return { ...r, editRevision: this.editRevision, indexRevision: this.indexRevision() ?? r.indexRevision };
  }

  async openLive(p: OpenLiveParams & { site?: string }): Promise<DrilldownResult> {
    this.checkRevision(p.editRevision);
    const r = await this.member(p.site).session.openLive({ ...p, editRevision: undefined });
    return { ...r, editRevision: this.editRevision, indexRevision: this.indexRevision() ?? r.indexRevision };
  }

  async pageDiff(p: PageDiffParams & { site?: string }): Promise<PageDiffView> {
    const r = await this.member(p.site).session.pageDiff(p);
    return { ...r, editRevision: this.editRevision };
  }

  // ------------------------------------------------------------ documents

  private async docResult(path: string, run: (s: Session) => Promise<unknown>): Promise<DocResult> {
    for (const m of this.members) await run(m.session);
    return { answer: this.fileAnswer(path), session: this.sessionTotal() };
  }

  open(path: string, text: string, version: number): Promise<DocResult> {
    return this.docResult(path, (s) => s.open(path, text, version));
  }

  change(path: string, version: number, changes: TextChange[]): Promise<DocResult> {
    return this.docResult(path, (s) => s.change(path, version, changes));
  }

  save(path: string, text?: string): Promise<DocResult> {
    return this.docResult(path, (s) => s.save(path, text));
  }

  async close(path: string): Promise<SessionTotal> {
    for (const m of this.members) await m.session.close(path);
    return this.sessionTotal();
  }

  async closeAll(): Promise<void> {
    for (const m of this.members) await m.session.closeAll();
  }

  async setTab(tab: Tab, mainChanges?: boolean): Promise<SessionTotal> {
    for (const m of this.members) await m.session.setTab(tab, mainChanges);
    return this.sessionTotal();
  }

  setSelection(sel?: EditSelection | null): SetSelectionResult {
    this.selection = sel;
    for (const m of this.members) m.session.setSelection(sel);
    return { selectionRevision: this.selectionRevision };
  }

  async dispose(): Promise<void> {
    for (const m of this.members) {
      m.session.removeAllListeners();
      await m.session.dispose();
    }
    this.members = [];
  }
}
