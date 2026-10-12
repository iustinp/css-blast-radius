// The page panel (§7.1): L1 page list → page detail (L1 elements, L2 render)
// → live check (L3). The webview never talks to the daemon; the host does.

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { RpcCallError, type DaemonClient } from "./daemonClient";
import { DIFF_BASE_LABEL, formatCount, reasonText } from "./format";
import { ERR, type DrilldownResult, type PagesResult, type PagesTarget, type PageSetName } from "./protocol";
import type { ImpactState } from "./state";

const PAGE_SIZE = 200;

type FromWebview =
  | { type: "ready" }
  | { type: "load"; set: PageSetName | "all"; group?: string; side?: "pages" | "gained" | "lost"; offset: number; editRevision?: number }
  | { type: "page"; url: string }
  | { type: "render"; url: string; screenshots: boolean }
  | { type: "live"; url: string; screenshots: boolean }
  | { type: "openFile"; path: string; line?: number };

interface FileTarget {
  path: string;
  changeId?: string;
  line?: number;
}

export class PagesPanel implements vscode.Disposable {
  private static current?: PagesPanel;
  private readonly subs: vscode.Disposable[] = [];
  private target: PagesTarget = { title: "Your edits" };
  private refreshTimer?: NodeJS.Timeout;
  private loadSeq = 0;
  /** Messages posted before the webview script runs are lost; it says "ready". */
  private ready = false;
  private filters: { set: PageSetName | "all"; group?: string; side?: "pages" | "gained" | "lost" } = { set: "all" };

  static show(ext: vscode.ExtensionContext, client: DaemonClient, state: ImpactState, target: PagesTarget): void {
    if (!PagesPanel.current) PagesPanel.current = new PagesPanel(ext, client, state);
    PagesPanel.current.open(target);
  }

  private constructor(
    private readonly ext: vscode.ExtensionContext,
    private readonly client: DaemonClient,
    private readonly state: ImpactState,
    private readonly panel = vscode.window.createWebviewPanel("cssBlastRadius.pages", "Blast radius", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ext.extensionUri, "media")],
    }),
  ) {
    panel.iconPath = new vscode.ThemeIcon("flame");
    panel.webview.html = this.html();
    this.subs.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
      state.onSession(() => this.scheduleRefresh()),
      state.onFile((p) => {
        if (this.target.path === p) this.scheduleRefresh();
      }),
    );
  }

  private open(target: PagesTarget): void {
    this.target = target;
    this.filters = { set: "all", side: target.side };
    this.panel.title = `Blast radius: ${target.title}`;
    this.panel.reveal(undefined, true);
    if (!this.ready) return;
    void this.post({ type: "target", target, subtitle: this.subtitle() });
    void this.load(0);
  }

  private subtitle(): string {
    const base = this.state.session?.diffBase ?? this.state.status?.diffBase ?? "HEAD";
    const parts: string[] = [];
    if (this.target.path) parts.push(vscode.workspace.asRelativePath(this.target.path));
    if (this.target.line !== undefined && !this.target.changeId) parts.push(`rule on line ${this.target.line}`);
    else parts.push(`compared with ${DIFF_BASE_LABEL[base] ?? base}`);
    return parts.join(" · ");
  }

  /** Edits moved the answer: reload the list (debounced), keep the open page. */
  private scheduleRefresh(): void {
    if (!this.ready) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.load(0, undefined, true), 400);
  }

  private post(msg: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  private async load(offset: number, editRevision?: number, refresh = false): Promise<void> {
    const t = this.target;
    // Only the latest request may update the list (replies can arrive out of order).
    const seq = ++this.loadSeq;
    try {
      const res = await this.client.call<PagesResult>("analysis/getPages", {
        path: t.path,
        changeId: t.changeId,
        line: t.changeId ? undefined : t.line,
        side: this.filters.side,
        set: this.filters.set,
        group: this.filters.group,
        offset,
        limit: PAGE_SIZE,
        editRevision,
      });
      if (t !== this.target || seq !== this.loadSeq) return;
      void this.post({ type: "pages", result: res, append: offset > 0, refresh, summary: formatCount(res.count), subtitle: this.subtitle(), filters: this.filters });
    } catch (err: any) {
      if (t !== this.target || seq !== this.loadSeq) return;
      if (err instanceof RpcCallError && err.code === ERR.superseded && editRevision !== undefined) return this.load(0, undefined, true);
      void this.post({ type: "error", scope: "list", message: this.explain(err) });
    }
  }

  private explain(err: any): string {
    if (err instanceof RpcCallError) {
      if (err.code === ERR.noIndex) return reasonText("index-missing");
      if (err.code === ERR.superseded) return "This change no longer exists in the file (it was edited away).";
    }
    return String(err?.message ?? err);
  }

  /** Session lists span files; page details are asked per changed file. */
  private fileTargets(): FileTarget[] {
    const t = this.target;
    if (t.path) return [{ path: t.path, changeId: t.changeId, line: t.changeId ? undefined : t.line }];
    return (this.state.session?.files ?? []).filter((f) => f.changes > 0).map((f) => ({ path: f.file }));
  }

  private async drill(type: "page" | "render" | "live", url: string, screenshots: boolean): Promise<void> {
    const targets = this.fileTargets();
    const t0 = Date.now();
    const results = await Promise.all(
      targets.map(async (ft) => {
        try {
          const r =
            type === "live"
              ? await this.client.call<DrilldownResult>("analysis/openLive", { ...ft, url, screenshots }, 120_000)
              : await this.client.call<DrilldownResult>("analysis/getDrilldown", { ...ft, url, level: type === "render" ? 2 : 1, screenshots }, 120_000);
          return { file: vscode.workspace.asRelativePath(ft.path), path: ft.path, result: r };
        } catch (err: any) {
          return { file: vscode.workspace.asRelativePath(ft.path), path: ft.path, error: this.explain(err) };
        }
      }),
    );
    void this.post({ type: "detail", kind: type, url, results, ms: Date.now() - t0 });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready":
        this.ready = true;
        void this.post({ type: "target", target: this.target, subtitle: this.subtitle() });
        return this.load(0);
      case "load":
        this.filters = { set: m.set, group: m.group, side: m.side };
        return this.load(m.offset, m.offset > 0 ? m.editRevision : undefined);
      case "page":
        return this.drill("page", m.url, false);
      case "render":
        return this.drill("render", m.url, m.screenshots);
      case "live":
        return this.drill("live", m.url, m.screenshots);
      case "openFile": {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
        const line = Math.max((m.line ?? 1) - 1, 0);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0) });
        return;
      }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("panel.css")}">
<title>Blast radius</title>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <div id="subtitle" class="muted"></div>
  <div id="summary"></div>
</header>
<div id="toolbar">
  <span id="sides" class="seg"></span>
  <span id="sets" class="seg"></span>
  <select id="group" title="Section"></select>
  <span id="listmeta" class="muted"></span>
</div>
<main>
  <section id="list"><ul id="pages"></ul><button id="more" hidden>Load more</button><div id="listerror" class="error" hidden></div></section>
  <section id="detail"><div class="muted placeholder">Select a page to see which elements the edit reaches.</div></section>
</main>
<script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (PagesPanel.current === this) PagesPanel.current = undefined;
    clearTimeout(this.refreshTimer);
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }
}
