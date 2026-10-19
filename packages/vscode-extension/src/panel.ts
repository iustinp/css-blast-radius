// On-demand page list. The host owns RPC; the webview receives only display data.

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { RpcCallError, type DaemonClient } from "./daemonClient";
import type { DaemonLifecycle } from "./daemonLifecycle";
import { TABS, branchNote, editSides, effectiveTab, formatCount, mainName, scanLine, span } from "./format";
import { ERR, type AssessProgress, type ChangeDetail, type FileAnswer, type PagesResult, type PagesTarget, type PageSetName, type Tab } from "./protocol";
import type { ImpactState } from "./state";
import { DiffTab } from "./diffTab";
import { fileState, isPicked, normalize, pickedCount, single, toggleAll, toggleChange, toggleFile, toWire, type FileEdits, type Picked } from "./selection";

const PAGE_SIZE = 100;
type Side = "pages" | "gained" | "lost";

type FromWebview =
  | { type: "ready" }
  | { type: "load"; set: PageSetName | "all"; group?: string; side?: Side; offset: number; editRevision?: number }
  | { type: "toggle"; path?: string; changeId?: string }
  | { type: "search"; query: string }
  | { type: "searchMore"; query: string; offset: number }
  | { type: "assess" }
  | { type: "tab"; tab: Tab }
  | { type: "mainChanges"; show: boolean }
  | { type: "rule"; path: string; changeId: string; seq: number }
  | { type: "goto"; path: string; changeId: string }
  | { type: "copy"; text: string }
  | { type: "page"; url: string };

interface Chip {
  path: string;
  label: string;
  changes: Array<{ id: string; label: string; count: string; lost: number; sides: Array<{ side: Side; count: string }>; line: number; props?: string[]; selected?: boolean }>;
  count: string;
  changed: number;
  state?: "all" | "some" | "none";
}

/** Page-list parameters: a rule's pages, the one picked edit (it has sides), or every picked edit. */
type ListQuery = { path?: string; changeId?: string; line?: number; side?: Side };

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
  /** Each edit's pages that lose a style ("path\nid" -> URLs), until the answers change: picking edits shows their notes at once. */
  private lostPages = new Map<string, Set<string>>();
  /** The picked edits: the list, the impact assessment and the diff viewer follow them. */
  private picked: Picked = undefined;
  /** The server predates picking edits (it was started by an older version). */
  private oldServer = false;
  /** The tab (and whether main's newer changes count) the list was last loaded for. */
  private tabKey?: string;

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
      state.onWatch(() => { if (this.ready) this.postTabs(); }),
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
    // A rule's pages (line, no change) keep the picked edits; anything else picks what it names.
    if (target.path && target.changeId) this.picked = new Map([[target.path, new Set([target.changeId])]]);
    else if (target.path && target.line === undefined) this.picked = new Map([[target.path, "all"]]);
    else if (!target.path) this.picked = undefined;
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
      this.lostPages = new Map();
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
          sides: editSides(ch).map((side) => ({ side, count: span(side === "pages" ? ch.pages : ch[side]!) })),
          line: ch.line,
          props: ch.changedProps,
        })),
      };
    });
  }

  private get files(): FileEdits[] {
    return this.lastChips.map((c) => ({ path: c.path, ids: c.changes.map((ch) => ch.id) }));
  }

  private query(): ListQuery {
    const t = this.target;
    if (t.path && t.line !== undefined && !t.changeId) return { path: t.path, line: t.line };
    const one = single(this.picked, this.files);
    return one ? { path: one.path, changeId: one.id, side: this.filters.side } : {};
  }

  /** The chips with what is picked; the one picked edit, if one is. */
  private decorate(chips: Chip[]): { chips: Chip[]; one?: { chip: Chip["changes"][number] } } {
    const files = this.files;
    const out = chips.map((c, i) => ({
      ...c,
      state: fileState(this.picked, files[i]),
      changes: c.changes.map((ch) => ({ ...ch, selected: isPicked(this.picked, c.path, ch.id) })),
    }));
    const one = single(this.picked, files);
    const chip = one && out.find((c) => c.path === one.path)?.changes.find((ch) => ch.id === one.id);
    return { chips: out, one: chip && { chip } };
  }

  /** Tells the server which edits are picked (the diff viewer and the assessment apply them). */
  private async sendSelection(): Promise<void> {
    try {
      await this.client.call("session/setSelection", { selection: toWire(this.picked) ?? null });
      this.oldServer = false;
    } catch (err) {
      if (!(err instanceof RpcCallError && err.code === ERR.methodNotFound)) throw err;
      this.oldServer = true;
    }
  }

  private get tab(): Tab {
    return this.state.session?.tab ?? this.state.status?.tab ?? "all";
  }

  /** The tab row: the active tab, the tabs this project has, the scan and main's newer commits. */
  private postTabs(): void {
    const git = this.state.status?.git;
    const b = this.state.session?.branch;
    void this.post({
      type: "tabs", tab: this.tab,
      tabs: TABS.filter((t) => effectiveTab(t.tab, git) === t.tab),
      main: b && b.behind > 0 && b.mainShown !== undefined ? { name: mainName(b), behind: b.behind, shown: b.mainShown } : undefined,
      scan: scanLine(this.state.watch),
    });
  }

  private async load(offset: number, editRevision?: number, refresh = false, union = false): Promise<void> {
    // Another tab counts other edits: start from all of them.
    // (No session yet while reconnecting: the tab isn't known, keep the picks.)
    const s = this.state.session;
    const tabKey = s && `${s.tab}:${s.branch?.mainShown === true}`;
    if (tabKey && this.tabKey !== undefined && tabKey !== this.tabKey && offset === 0) {
      this.picked = undefined;
      this.target = { title: "All edits" };
      this.filters = { set: "all", group: this.filters.group };
      void this.post({ type: "target", target: this.target });
    }
    if (tabKey) this.tabKey = tabKey;
    this.postTabs();
    const t = this.target;
    const seq = ++this.loadSeq;
    try {
      const raw = await this.fileChips(seq);
      if (seq !== this.loadSeq) return;
      this.lastChips = raw;
      this.picked = normalize(this.picked, this.files);
      // The edit it was opened for is gone (undone, or merged into another): show its file.
      if (t.path && t.changeId && pickedCount(this.picked, this.files) === 0
        && !this.files.some((f) => f.path === t.path && f.ids.includes(t.changeId!))) {
        this.picked = normalize(new Map([[t.path, "all"]]), this.files);
      }
      await this.sendSelection();
      if (seq !== this.loadSeq) return;
      const q = union ? {} : this.query();
      const res = await this.client.call<PagesResult>("analysis/getPages", {
        ...q, set: this.filters.set, group: this.filters.group, offset, limit: PAGE_SIZE, editRevision,
      });
      if (seq !== this.loadSeq || t !== this.target) return;
      const { chips, one } = this.decorate(raw);
      const ms = [...this.answers.values()].reduce((n, a) => n + a.timingMs, 0);
      const picked = chips.flatMap((f) => f.changes.filter((ch) => ch.selected));
      const lost = picked.reduce((n, ch) => n + ch.lost, 0);
      const lostChanges = picked.filter((ch) => ch.lost).length;
      const ruleList = q.line !== undefined;
      // The loss notes come with the list when known, so a pick redraws it once (no shorter list in between).
      const known = this.knownLosses(res.pages, chips);
      void this.post({
        type: "pages", result: res, append: offset > 0, refresh,
        summary: formatCount(res.count), allCount: this.state.session?.total,
        scopePages: this.state.status?.scope.pages ?? 0,
        ms, lost, lostChanges, chips, target: t, filters: this.filters,
        all: !this.picked, pickedEdits: pickedCount(this.picked, this.files),
        ruleList, sides: !ruleList && one && one.chip.sides.length > 1 ? one.chip.sides : undefined,
        single: !ruleList && one ? one.chip.label : undefined,
        branchNote: branchNote(this.state.session?.branch),
        losses: known.pages,
      });
      if (this.oldServer && this.picked && !single(this.picked, this.files)) {
        void this.post({ type: "error", message: "The CSS Blast Radius server running now is an older version: it shows all your edits, not just the picked ones. Stop it and reload the window to use the new one." });
      }
      if (known.missing) void this.annotateLosses(seq, res, chips);
      if (this.searchQuery) void this.search(this.searchQuery);
    } catch (err: any) {
      if (seq !== this.loadSeq || t !== this.target) return;
      if (err instanceof RpcCallError && err.code === ERR.superseded) {
        if (editRevision !== undefined) return this.load(0, undefined, true);
        // The rule or the picked edit is gone: list the picked edits' pages.
        if (t.line !== undefined) this.target = { title: "All edits" };
        this.answersRevision = "";
        return this.load(0, undefined, true, true);
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
    const q = this.query();
    const filters = { ...this.filters };
    const matches: PagesResult["pages"] = [];
    let offset = 0;
    let lastResult: PagesResult | undefined;
    try {
      while (seq === this.searchSeq && loadSeq === this.loadSeq) {
        const res = await this.client.call<PagesResult>("analysis/getPages", {
          ...q, set: filters.set, group: filters.group, offset, limit: 1000,
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
      if (lastResult) void this.annotateLosses(loadSeq, { ...lastResult, pages: matches.slice(0, PAGE_SIZE) }, this.decorate(this.lastChips).chips);
    } catch (err: any) {
      if (seq === this.searchSeq) void this.post({ type: "error", message: `Couldn't search page URLs: ${err?.message ?? err}` });
    }
  }

  /** The listed pages that lose a style, with the picked edits that make them (from lostPages); `missing`: some edits aren't looked up yet. */
  private knownLosses(pages: PagesResult["pages"], chips: Chip[]): { pages: Record<string, string[]>; missing: boolean } {
    const lossy = chips.flatMap((f) => f.changes.filter((ch) => ch.lost && ch.selected !== false)
      .map((ch) => ({ urls: this.lostPages.get(`${f.path}\n${ch.id}`), label: ch.label })));
    const out: Record<string, string[]> = {};
    for (const p of pages) {
      const labels = [...new Set(lossy.filter((e) => e.urls?.has(p.url)).map((e) => e.label))];
      if (labels.length) out[p.url] = labels;
    }
    return { pages: out, missing: lossy.some((e) => !e.urls) };
  }

  /** Looks up the picked edits' lost pages not known yet, then sends the listed pages' loss notes. */
  private async annotateLosses(seq: number, result: PagesResult, chips: Chip[]): Promise<void> {
    if (!result.pages.length) return;
    const cache = this.lostPages;
    await Promise.all(chips.flatMap((f) => f.changes.filter((ch) => ch.lost && ch.selected !== false && !cache.has(`${f.path}\n${ch.id}`)).map(async (ch) => {
      const urls = new Set<string>();
      let offset = 0;
      while (seq === this.loadSeq) {
        let page: PagesResult;
        try {
          page = await this.client.call<PagesResult>("analysis/getPages",
            { path: f.path, changeId: ch.id, side: "lost", offset, limit: 1000 });
        } catch {
          return;
        }
        for (const item of page.pages) urls.add(item.url);
        offset += page.pages.length;
        if (!page.pages.length || offset >= page.total) {
          cache.set(`${f.path}\n${ch.id}`, urls);
          return;
        }
      }
    })));
    if (seq !== this.loadSeq || cache !== this.lostPages) return;
    const known = this.knownLosses(result.pages, chips);
    if (Object.keys(known.pages).length) void this.post({ type: "losses", editRevision: result.editRevision, pages: known.pages });
  }

  /** The edit card: the edit's whole rule, the edited declarations marked. */
  private async rule(file: string, changeId: string, seq: number): Promise<void> {
    try {
      const detail = await this.client.call<ChangeDetail>("analysis/getChange", { path: file, changeId });
      void this.post({ type: "rule", path: file, changeId, seq, detail });
    } catch (err: any) {
      const code = err instanceof RpcCallError ? err.code : undefined;
      void this.post({
        type: "rule", path: file, changeId, seq,
        error: code === ERR.methodNotFound
          ? "The CSS Blast Radius server running now is an older version: stop it and reload the window to see the whole rule here."
          : code === ERR.superseded ? "This edit just changed: the list is updating." : `Couldn't read the rule: ${err?.message ?? err}`,
      });
    }
  }

  /** Opens the edit's file at the changed declaration (or the rule), to adjust it. */
  private async goto(file: string, changeId: string): Promise<void> {
    const chip = this.lastChips.find((c) => c.path === file)?.changes.find((ch) => ch.id === changeId);
    let at: { line: number; column?: number; rule?: { line: number; endLine: number } } = { line: chip?.line ?? 1 };
    try {
      const d = await this.client.call<ChangeDetail>("analysis/getChange", { path: file, changeId });
      at = { line: d.line, column: d.column, rule: d.rule && !d.rule.removed ? d.rule : undefined };
    } catch {
      // An older server, or the edit just changed: the line the list has.
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const line = Math.min(Math.max(at.line, 1), doc.lineCount) - 1;
      const text = doc.lineAt(line);
      const pos = new vscode.Position(line, at.column ? Math.min(at.column - 1, text.text.length) : text.firstNonWhitespaceCharacterIndex);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.editorColumn(doc), selection: new vscode.Range(pos, pos) });
      // The whole rule in view when it fits.
      if (at.rule && at.rule.endLine - at.rule.line < 40) {
        editor.revealRange(new vscode.Range(at.rule.line - 1, 0, at.rule.endLine - 1, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (err: any) {
      void vscode.window.showErrorMessage(`CSS Blast Radius: couldn't open ${vscode.workspace.asRelativePath(file)}: ${err?.message ?? err}`);
    }
  }

  /** Where the file shows: its editor if visible, else an editor group other than the panel's. */
  private editorColumn(doc: vscode.TextDocument): vscode.ViewColumn {
    const editors = vscode.window.visibleTextEditors;
    const shown = editors.find((e) => e.document.uri.toString() === doc.uri.toString() && e.viewColumn);
    if (shown?.viewColumn) return shown.viewColumn;
    const other = editors.find((e) => e.viewColumn && e.viewColumn !== this.panel.viewColumn);
    if (other?.viewColumn) return other.viewColumn;
    return this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
  }

  /** Checks every page of the current list visually, in the background (analysis/assess). */
  private async assess(): Promise<void> {
    const t = this.target;
    try {
      const p = await this.client.call<AssessProgress>("analysis/assess", {
        ...this.query(), set: this.filters.set, group: this.filters.group,
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
          if (this.searchResult) void this.annotateLosses(this.loadSeq, { ...this.searchResult, pages }, this.decorate(this.lastChips).chips);
        }
        return;
      case "toggle": {
        const files = this.files;
        this.picked = !m.path
          ? toggleAll(this.picked, files)
          : m.changeId
            ? toggleChange(this.picked, files, m.path, m.changeId)
            : toggleFile(this.picked, files, m.path);
        // Back from a rule's pages or one edit's side to the picked edits' pages.
        this.target = { title: "Picked edits" };
        this.filters = { set: "all", group: this.filters.group };
        return this.load(0);
      }
      case "page":
        if (m.url.startsWith("/") && !m.url.startsWith("//")) DiffTab.open(this.life, m.url);
        return;
      case "rule":
        return this.rule(m.path, m.changeId, m.seq);
      case "goto":
        return this.goto(m.path, m.changeId);
      case "copy":
        await vscode.env.clipboard.writeText(String(m.text));
        return;
      case "tab":
      case "mainChanges":
        await vscode.commands.executeCommand("cssBlastRadius.setTab",
          m.type === "tab" ? { tab: m.tab } : { tab: this.tab, mainChanges: m.show });
        this.postTabs(); // back to the active tab if switching failed
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
<nav id="tabs" role="tablist" aria-label="Which changes to show"></nav>
<section id="summaryBox">
  <div id="number">0</div><div id="summary"></div>
  <div id="meta" class="muted"></div><div id="branch" class="muted" hidden></div>
  <label id="mainBox" class="muted" hidden><input type="checkbox" id="mainChanges"> <span id="mainLabel"></span></label>
  <div id="scanLine" class="muted" hidden></div>
  <div id="warning" class="warning"></div>
</section>
<nav id="chips"></nav>
<div id="card" role="dialog" aria-label="The edit's rule" hidden></div>
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
    // Nothing shows the picks any more: the diff viewer goes back to every edit.
    if (this.picked) this.client.call("session/setSelection", { selection: null }).catch(() => undefined);
    ++this.loadSeq;
    ++this.searchSeq;
    clearTimeout(this.refreshTimer);
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }
}
