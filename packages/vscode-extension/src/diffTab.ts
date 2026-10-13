import * as vscode from "vscode";
import * as crypto from "node:crypto";
import type { DaemonLifecycle } from "./daemonLifecycle";
import { diffUrl, serverOrigin } from "./urls";

/** One reusable editor tab; the server owns rendering and keyboard shortcuts. */
export class DiffTab implements vscode.Disposable {
  private static current?: DiffTab;
  private readonly panel: vscode.WebviewPanel;
  private readonly onAttached: vscode.Disposable;
  private pagePath = "";
  private life: DaemonLifecycle;

  static open(life: DaemonLifecycle, pagePath: string): void {
    if (!life.init || !pagePath.startsWith("/") || pagePath.startsWith("//")) return;
    if (!DiffTab.current) DiffTab.current = new DiffTab(life);
    DiffTab.current.life = life;
    DiffTab.current.show(pagePath);
  }

  static openInBrowser(): void {
    void DiffTab.current?.browse();
  }

  private constructor(life: DaemonLifecycle) {
    this.life = life;
    this.onAttached = life.onAttached(() => {
      if (this.pagePath) this.panel.webview.html = this.html();
    });
    this.panel = vscode.window.createWebviewPanel("cssBlastRadius.diff", "Diff", vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [],
    });
    this.panel.onDidDispose(() => this.dispose());
    this.panel.onDidChangeViewState(() => void vscode.commands.executeCommand("setContext", "cssBlastRadius.diffActive", this.panel.active));
    this.panel.webview.onDidReceiveMessage((m: { type?: string; url?: string }) => {
      if (m.type === "cbr-open-external" && m.url) void this.browse(m.url);
    });
  }

  private show(pagePath: string): void {
    this.pagePath = pagePath;
    this.panel.title = `Diff · ${pagePath}`;
    this.panel.webview.html = this.html();
    this.panel.reveal(vscode.ViewColumn.One);
    void vscode.commands.executeCommand("setContext", "cssBlastRadius.diffActive", this.panel.active);
  }

  private async browse(requested?: string): Promise<void> {
    const init = this.life.init;
    if (!init) return;
    try {
      const url = requested ?? diffUrl(this.life.serverUrl, init.sessionId, this.pagePath);
      const parsed = new URL(url);
      if (parsed.origin !== serverOrigin(this.life.serverUrl).origin || parsed.pathname !== "/diff"
        || parsed.searchParams.get("s") !== init.sessionId || parsed.searchParams.get("url") !== this.pagePath) return;
      parsed.searchParams.delete("embed");
      await vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
    } catch (err: any) {
      this.life.output.appendLine(`Couldn't open the page in a browser: ${err?.message ?? err}`);
    }
  }

  private html(): string {
    const init = this.life.init!;
    const origin = serverOrigin(this.life.serverUrl).origin;
    const src = diffUrl(this.life.serverUrl, init.sessionId, this.pagePath, true).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
</head><body><iframe title="Page before and after" src="${src}"></iframe>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
window.addEventListener("message",e=>{
  if(e.origin===${JSON.stringify(origin)} && e.source===document.querySelector("iframe").contentWindow
    && e.data?.type==="cbr-open-external" && typeof e.data.url==="string")
    vscode.postMessage({type:"cbr-open-external",url:e.data.url});
});
</script></body></html>`;
  }

  dispose(): void {
    if (DiffTab.current === this) DiffTab.current = undefined;
    void vscode.commands.executeCommand("setContext", "cssBlastRadius.diffActive", false);
    this.onAttached.dispose();
    this.panel.dispose();
  }
}
