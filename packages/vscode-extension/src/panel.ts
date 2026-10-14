// On-demand page list. The host owns RPC; the webview receives only display data.

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { RpcCallError, type DaemonClient } from "./daemonClient";
import type { DaemonLifecycle } from "./daemonLifecycle";
import { DIFF_BASE_LABEL, branchNote, formatCount } from "./format";
import { ERR, type AssessProgress, type ChangeAnswer, type FileAnswer, type PagesResult, type PagesTarget, type PageSetName } from "./protocol";
import type { ImpactState } from "./state";
import { DiffTab } from "./diffTab";

const PAGE_SIZE = 100;
type Side = "pages" | "gained" | "lost";

type FromWebview =
  | { type: "ready" }
  | { type: "load"; set: PageSetName | "all"; group?: string; side?: Side; offset: number; editRevision?: number }
  | { type: "filter"; path?: string; changeId?: string }
  | { type: "search"; query: string }
  | { type: "searchMore"; query: string; offset: number }
  | { type: "assess" }
  | { type: "page"; url: string };

interface Chip {
  path: string;
  label: string;
  changes: Array<{ id: string; label: string; count: string; lost: number }>;
  count: string;
  changed: number;
}

export class PagesPanel implements vscode.Disposable {
  private static current?: PagesPanel;
  private readonly subs: vscode.Disposable[] = [];
  private target: PagesTarget = { title: "All edits" };
  private refreshTimer?: NodeJS.Timeout;
  private loadSeq = 0;
  private ready = false;
  private filters: { set: PageSetName | "all"; group?: string; side?: Side } = { set: "all" };
  private answers = new Map<string, FileAnswer>();
  private answersRevision = "";
  private searchQuery = "";
  private searchSeq = 0;
  private searchMatches: PagesResult["pages"] = [];
  private searchResult?: PagesResult;
  private lastChips: Chip[] = [];

  static show(ext: vscode.ExtensionContext, client: DaemonClient, life: DaemonLifecycle, state: ImpactState, target: PagesTarget): void {
    if (!PagesPanel.current) PagesPanel.current = new PagesPanel(ext, client, life, state);
    PagesPanel.current.open(target);
  }

  static toggle(ext: vscode.ExtensionContext, client: DaemonClient, life: DaemonLifecycle, state: ImpactState): void {
    if (PagesPanel.current) PagesPanel.current.dispose();
    else PagesPanel.show(ext, client, life, state, { title: "All edits" });
  }

  private constructor(
    private readonly ext: vscode.ExtensionContext,
    private readonly client: DaemonClient,
    private readonly life: DaemonLifecycle,
    private readonly state: ImpactState,
    private readonly panel = vscode.window.createWebviewPanel("cssBlastRadius.pages", "BLAST RADIUS",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ext.extensionUri, "media")],
      }),
  ) {
    panel.iconPath = new vscode.ThemeIcon("circle-large-outline");
    panel.webview.html = this.html();
    this.subs.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
      state.onSession(() => {
        this.answersRevision = "";
        this.scheduleRefresh();
      }),
      state.onFile((file) => {
        if (this.target.path === file || this.state.session?.files.some((f) => f.file === file)) {
          this.answersRevision = "";
          this.scheduleRefresh();
        }
      }),
      state.onStatus(() => this.scheduleRefresh()),
      client.onNotification((method, p: AssessProgress) => {
        if (method !== "analysis/assessProgress" || !this.ready) return;
        void this.post({ type: "assessProgress", progress: p });
        // Done (or out of date): the list comes back ranked by impact.
        if (!p.running) this.scheduleRefresh();
      }),
    );
  }

  private open(target: PagesTarget): void {
    this.target = target;
    this.filters = { set: "all", side: target.side };
    this.panel.reveal(undefined, true);
    if (!this.ready) return;
    void this.post({ type: "target", target });
    void this.load(0);
  }

  private scheduleRefresh(): void {
    if (!this.ready) return;
    ++this.loadSeq; // A reply already in flight must not replace a newer edit.
    ++this.searchSeq;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.load(0, undefined, true), 350);
  }

  private post(msg: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  private async fileChips(seq: number): Promise<Chip[]> {
    const session = this.state.session;
    if (!session) return [];
    const revision = `${session.indexRevision}:${session.editRevision}`;
    if (revision !== this.answersRevision) {
      const entries = await Promise.all(session.files.map(async (f) => {
        try {
          const a = this.state.answers.get(f.file) ?? await this.client.call<FileAnswer>("analysis/queryImpacts", { path: f.file, scope: "file" });
          return [f.file, a] as const;
        } catch {
          return undefined;
        }
      }));
      if (seq !== this.loadSeq) return [];
      this.answers = new Map(entries.filter((e): e is readonly [string, FileAnswer] => !!e));
      this.answersRevision = revision;
    }
    return session.files.map((f) => {
      const a = this.answers.get(f.file);
      return {
        path: f.file,
        label: vscode.workspace.asRelativePath(f.file),
        count: formatCount(f.pages),
        changed: f.changes,
        changes: (a?.changes ?? []).map((ch) => ({
          id: ch.id,
          label: ch.selector || ch.definition?.name || `Edit on line ${ch.line}`,
          count: formatCount(ch.pages, ch.reasons),
          lost: (ch.lost ?? (ch.kind === "removed" ? ch.pages : undefined))?.exact ?? 0,
        })),
      };
    });
  }

  private async load(offset: number, editRevision?: number, refresh = false): Promise<void> {
    const t = this.target;
    const seq = ++this.loadSeq;
    try {
      const chips = await this.fileChips(seq);
      if (seq !== this.loadSeq) return;
      this.lastChips = chips;
      const res = await this.client.call<PagesResult>("analysis/getPages", {
        path: t.path, changeId: t.changeId, line: t.changeId ? undefined : t.line,
        side: this.filters.side, set: this.filters.set, group: this.filters.group,
        offset, limit: PAGE_SIZE, editRevision,
      });
      if (seq !== this.loadSeq || t !== this.target) return;
      const answer = t.path ? this.answers.get(t.path) : undefined;
      const ms = t.path ? answer?.timingMs : [...this.answers.values()].reduce((n, a) => n + a.timingMs, 0);
      const lost = chips.reduce((n, f) => n + f.changes.reduce((sum, ch) => sum + ch.lost, 0), 0);
      const lostChanges = chips.reduce((n, f) => n + f.changes.filter((ch) => ch.lost).length, 0);
      void this.post({
        type: "pages", result: res, append: offset > 0, refresh,
        summary: formatCount(res.count), allCount: this.state.session?.total,
        scopePages: this.state.status?.scope.pages ?? 0,
        ms, lost, lostChanges, chips, target: t, filters: this.filters,
        baseLabel: DIFF_BASE_LABEL[this.state.session?.diffBase ?? this.state.status?.diffBase ?? "production"] ?? "the live site",
        branchNote: branchNote(this.state.session?.branch),
      });
      void this.annotateLosses(seq, res, chips);
      if (this.searchQuery) void this.search(this.searchQuery);
    } catch (err: any) {
      if (seq !== this.loadSeq || t !== this.target) return;
      if (err instanceof RpcCallError && err.code === ERR.superseded) {
        if (editRevision !== undefined) return this.load(0, undefined, true);
        this.target = t.path ? { path: t.path, title: path.basename(t.path) } : { title: "All edits" };
        return this.load(0, undefined, true);
      }
      void this.post({ type: "error", message: err instanceof RpcCallError && err.code === ERR.noIndex
        ? "No pages scanned yet. Rescan your linked groups to see the page list." : String(err?.message ?? err) });
    }
  }

  private async search(query: string): Promise<void> {
    this.searchQuery = query.trim();
    const seq = ++this.searchSeq;
    const loadSeq = this.loadSeq;
    if (!this.searchQuery) {
      this.searchMatches = [];
      return;
    }
    const t = this.target;
    const filters = { ...this.filters };
    const matches: PagesResult["pages"] = [];
    let offset = 0;
    let lastResult: PagesResult | undefined;
    try {
      while (seq === this.searchSeq && loadSeq === this.loadSeq) {
        const res = await this.client.call<PagesResult>("analysis/getPages", {
          path: t.path, changeId: t.changeId, line: t.changeId ? undefined : t.line,
          side: filters.side, set: filters.set, group: filters.group, offset, limit: 1000,
        });
        if (seq !== this.searchSeq || loadSeq !== this.loadSeq) return;
        lastResult = res;
        matches.push(...res.pages.filter((p) => p.url.toLowerCase().includes(this.searchQuery.toLowerCase())));
        offset += res.pages.length;
        if (!res.pages.length || offset >= res.total) break;
      }
      if (seq !== this.searchSeq || loadSeq !== this.loadSeq) return;
      this.searchMatches = matches;
      this.searchResult = lastResult;
      void this.post({ type: "searchResults", query: this.searchQuery, total: matches.length, pages: matches.slice(0, PAGE_SIZE) });
      if (lastResult) void this.annotateLosses(loadSeq, { ...lastResult, pages: matches.slice(0, PAGE_SIZE) }, this.lastChips);
    } catch (err: any) {
      if (seq === this.searchSeq) void this.post({ type: "error", message: `Couldn't search page URLs: ${err?.message ?? err}` });
    }
  }

  private async annotateLosses(seq: number, result: PagesResult, chips: Chip[]): Promise<void> {
    const visible = new Set(result.pages.map((p) => p.url));
    if (!visible.size) return;
    const labels = new Map<string, Set<string>>();
    await Promise.all(chips.flatMap((f) => f.changes.filter((ch) => ch.lost).map(async (ch) => {
      let offset = 0;
      while (seq === this.loadSeq) {
        let page: PagesResult;
        try {
          page = await this.client.call<PagesResult>("analysis/getPages",
            { path: f.path, changeId: ch.id, side: "lost", offset, limit: 1000 });
        } catch {
          return;
        }
        if (seq !== this.loadSeq) return;
        for (const item of page.pages) {
          if (!visible.has(item.url)) continue;
          if (!labels.has(item.url)) labels.set(item.url, new Set());
          labels.get(item.url)!.add(ch.label);
        }
        offset += page.pages.length;
        if (!page.pages.length || offset >= page.total) break;
      }
    })));
    if (seq === this.loadSeq && labels.size) void this.post({
      type: "losses", editRevision: result.editRevision,
      pages: Object.fromEntries([...labels].map(([url, names]) => [url, [...names]])),
    });
  }

  /** Checks every page of the current list visually, in the background (analysis/assess). */
  private async assess(): Promise<void> {
    const t = this.target;
    try {
      const p = await this.client.call<AssessProgress>("analysis/assess", {
        path: t.path, changeId: t.changeId, line: t.changeId ? undefined : t.line,
        side: this.filters.side, set: this.filters.set, group: this.filters.group,
      });
      if (t !== this.target) return;
      void this.post({ type: "assessProgress", progress: p });
      if (!p.running) this.scheduleRefresh();
    } catch (err: any) {
      void this.post({ type: "assessProgress", progress: { running: false, done: 0, total: 0 } });
      void this.post({ type: "error", message: `Couldn't assess the impact: ${err?.message ?? err}` });
    }
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "assess":
        return this.assess();
      case "ready":
        this.ready = true;
        void this.post({ type: "target", target: this.target });
        return this.load(0);
      case "load":
        this.filters = { set: m.set, group: m.group, side: m.side };
        return this.load(m.offset, m.offset ? m.editRevision : undefined);
      case "search":
        return this.search(m.query);
      case "searchMore":
        if (m.query === this.searchQuery) {
          const pages = this.searchMatches.slice(m.offset, m.offset + PAGE_SIZE);
          void this.post({ type: "searchMore", query: m.query, pages });
          if (this.searchResult) void this.annotateLosses(this.loadSeq, { ...this.searchResult, pages }, this.lastChips);
        }
        return;
      case "filter": {
        if (!m.path) return this.open({ title: "All edits" });
        if (!this.state.session?.files.some((f) => f.file === m.path)) return;
        const ch: ChangeAnswer | undefined = this.answers.get(m.path)?.changes.find((c) => c.id === m.changeId);
        const sides: PagesTarget["sides"] = ch ? ["pages", ...(ch.gained ? (["gained"] as const) : []), ...(ch.lost ? (["lost"] as const) : [])] : undefined;
        return this.open({ path: m.path, changeId: ch?.id, sides, title: ch?.selector || path.basename(m.path) });
      }
      case "page":
        if (m.url.startsWith("/") && !m.url.startsWith("//")) DiffTab.open(this.life, m.url);
        return;
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString("base64");
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ext.extensionUri, "media", f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("panel.css")}">
<title>Blast radius</title>
</head>
<body>
<header>BLAST RADIUS</header>
<section id="summaryBox">
  <div id="number">0</div><div id="summary"></div>
  <div id="meta" class="muted"></div><div id="branch" class="muted" hidden></div><div id="warning" class="warning"></div>
</section>
<nav id="chips"></nav>
<div id="toolbar">
  <div id="sides"></div><div id="sets"></div>
  <select id="group" aria-label="Page group"></select>
  <input id="search" type="search" placeholder="Filter pages by URL" aria-label="Filter pages by URL">
  <button id="assess" hidden title="Check each page in this list with your edits applied, then sort the list by how much each page changes.">Assess impact</button>
</div>
<div id="list"><div id="pages"></div><button id="more" hidden>Show more</button><div id="error" class="warning" hidden></div></div>
<script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (PagesPanel.current === this) PagesPanel.current = undefined;
    ++this.loadSeq;
    ++this.searchSeq;
    clearTimeout(this.refreshTimer);
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }
}
