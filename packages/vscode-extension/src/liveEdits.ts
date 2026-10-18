// CSS the live site doesn't have yet, wherever it came from (this editor,
// other tools, a pull): file badges, line highlights, change bars and an
// Explorer list. Always compared with the live site, whatever tab the
// Blast Radius panel shows.

import * as vscode from "vscode";
import * as path from "node:path";
import { RpcCallError, type DaemonClient } from "./daemonClient";
import type { DaemonLifecycle } from "./daemonLifecycle";
import { badgeText, editLabel, editsText, formatChange, formatCount, KIND_LABEL, losesPages, span } from "./format";
import type { LiveEdit, LiveEditsResult, LiveOriginal } from "./protocol";
import type { ImpactState } from "./state";

type LiveFile = LiveEditsResult["files"][number];
type Node = { file: LiveFile; edit?: LiveEdit };

/** The live site's copy of a file, for change bars and side-by-side comparisons. */
const SCHEME = "cbr-live";
const COMPARE = "cssBlastRadius.compareWithLiveSite";
const VIEW = "cssBlastRadius.liveEdits";
const METHOD_NOT_FOUND = -32601;

const liveUri = (file: vscode.Uri) => vscode.Uri.from({ scheme: SCHEME, path: file.path });
const fileOf = (live: vscode.Uri) => vscode.Uri.from({ scheme: "file", path: live.path });

function commandLink(title: string, command: string, args: unknown): string {
  return `[${title}](command:${command}?${encodeURIComponent(JSON.stringify([args]))})`;
}

/** The latest liveEdits answer, refetched shortly after anything that may change it. */
class LiveEditsModel implements vscode.Disposable {
  files = new Map<string, LiveFile>();
  private timer?: NodeJS.Timeout;
  private seq = 0;
  private unsupported = false;
  private readonly emitter = new vscode.EventEmitter<string[]>();
  /** The files whose edits changed (every refresh fires, so the live copies are refetched). */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly client: DaemonClient, private readonly log: (m: string) => void) {}

  schedule(delay = 300): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  async refresh(): Promise<void> {
    const seq = ++this.seq;
    if (!this.client.connected) return this.set(undefined);
    try {
      const r = await this.client.call<LiveEditsResult>("analysis/liveEdits", {}, 120_000);
      if (seq === this.seq) this.set(r);
    } catch (err: any) {
      if (seq !== this.seq) return;
      if (err instanceof RpcCallError && err.code === METHOD_NOT_FOUND) {
        if (!this.unsupported) this.log("Live-site highlights need a newer server: restart it to see them.");
        this.unsupported = true;
        return this.set(undefined);
      }
      this.log(`Live-site highlights: ${err?.message ?? err}`);
    }
  }

  private set(r: LiveEditsResult | undefined): void {
    const next = new Map((r?.files ?? []).map((f) => [f.file, f] as const));
    const changed: string[] = [];
    for (const [p, f] of next) if (JSON.stringify(this.files.get(p)) !== JSON.stringify(f)) changed.push(p);
    for (const p of this.files.keys()) if (!next.has(p)) changed.push(p);
    this.files = next;
    this.emitter.fire(changed);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.seq++;
    this.emitter.dispose();
  }
}

export class LiveEdits implements vscode.Disposable, vscode.FileDecorationProvider, vscode.TreeDataProvider<Node>, vscode.TextDocumentContentProvider {
  readonly model: LiveEditsModel;
  private readonly subs: vscode.Disposable[] = [];
  private readonly lineType: vscode.TextEditorDecorationType;
  private readonly warnLineType: vscode.TextEditorDecorationType;
  private readonly markType: vscode.TextEditorDecorationType;
  private readonly warnMarkType: vscode.TextEditorDecorationType;
  private readonly decoEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decoEmitter.event;
  private readonly treeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.treeEmitter.event;
  private readonly contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.contentEmitter.event;
  private readonly tree: vscode.TreeView<Node>;
  /** Live copies VS Code holds open (refetched when the edits change). */
  private readonly served = new Map<string, vscode.Uri>();
  private scm?: vscode.SourceControl;
  private group?: vscode.SourceControlResourceGroup;

  constructor(
    private readonly client: DaemonClient,
    private readonly life: DaemonLifecycle,
    private readonly state: ImpactState,
    private readonly folder: vscode.Uri,
    extensionUri: vscode.Uri,
    log: (m: string) => void,
  ) {
    this.model = new LiveEditsModel(client, log);
    const lines = (warn: boolean): vscode.DecorationRenderOptions => ({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(warn ? "cssBlastRadius.liveEditWarningBackground" : "cssBlastRadius.liveEditBackground"),
      overviewRulerColor: new vscode.ThemeColor(warn ? "cssBlastRadius.liveEditWarningRuler" : "cssBlastRadius.liveEditRuler"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    this.lineType = vscode.window.createTextEditorDecorationType(lines(false));
    this.warnLineType = vscode.window.createTextEditorDecorationType(lines(true));
    const mark = (icon: string): vscode.DecorationRenderOptions => ({ gutterIconPath: vscode.Uri.joinPath(extensionUri, "media", icon), gutterIconSize: "contain" });
    this.markType = vscode.window.createTextEditorDecorationType(mark("live-edit.svg"));
    this.warnMarkType = vscode.window.createTextEditorDecorationType(mark("live-edit-warning.svg"));
    this.tree = vscode.window.createTreeView(VIEW, { treeDataProvider: this, showCollapseAll: true });

    const refetch = () => this.model.schedule();
    this.subs.push(
      this.model,
      this.tree,
      vscode.window.registerFileDecorationProvider(this),
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.commands.registerCommand(COMPARE, (arg?: vscode.Uri | Node | string) => this.compare(arg)),
      this.model.onDidChange((changed) => this.render(changed)),
      state.onFile(refetch),
      state.onSession(refetch),
      state.onStatus(refetch),
      life.onState(refetch),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.scheme === SCHEME) this.served.delete(d.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("cssBlastRadius.liveSite")) return;
        this.syncScm();
        this.decorateAll();
        this.decoEmitter.fire(undefined);
      }),
    );
    this.syncScm();
    this.updateTreeMessage();
  }

  private setting(key: "lineHighlights" | "fileBadges" | "changeBars"): boolean {
    return vscode.workspace.getConfiguration("cssBlastRadius").get<boolean>(`liveSite.${key}`) !== false;
  }

  private threshold(): number {
    return vscode.workspace.getConfiguration("cssBlastRadius").get<number>("warnLostPages") ?? 10;
  }

  private render(changed: string[]): void {
    const uris = changed.map((p) => vscode.Uri.file(p));
    if (uris.length) this.decoEmitter.fire(uris);
    this.treeEmitter.fire(undefined);
    this.updateTreeMessage();
    this.syncScm();
    this.decorateAll();
    for (const uri of this.served.values()) this.contentEmitter.fire(uri);
  }

  // -------------------------------------------------------- line highlights

  private decorateAll(): void {
    for (const ed of vscode.window.visibleTextEditors) this.decorate(ed);
  }

  private decorate(ed: vscode.TextEditor): void {
    if (ed.document.uri.scheme !== "file") return;
    const f = this.setting("lineHighlights") ? this.model.files.get(ed.document.uri.fsPath) : undefined;
    const lines: vscode.DecorationOptions[] = [];
    const warnLines: vscode.DecorationOptions[] = [];
    const marks: vscode.DecorationOptions[] = [];
    const warnMarks: vscode.DecorationOptions[] = [];
    const last = ed.document.lineCount - 1;
    for (const e of f?.edits ?? []) {
      const warn = losesPages(e, this.threshold());
      const hover = this.hover(f!, e);
      for (const [from, to] of e.ranges) {
        const a = Math.min(Math.max(from - 1, 0), last);
        const b = Math.min(Math.max(to - 1, a), last);
        (warn ? warnLines : lines).push({ range: new vscode.Range(a, 0, b, 0), hoverMessage: hover });
      }
      const first = Math.min(Math.max((e.ranges[0]?.[0] ?? e.line) - 1, 0), last);
      (warn ? warnMarks : marks).push({ range: new vscode.Range(first, 0, first, 0) });
    }
    ed.setDecorations(this.lineType, lines);
    ed.setDecorations(this.warnLineType, warnLines);
    ed.setDecorations(this.markType, marks);
    ed.setDecorations(this.warnMarkType, warnMarks);
  }

  private hover(f: LiveFile, e: LiveEdit): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: [COMPARE] };
    md.appendMarkdown(`$(cloud-upload) **Not on the live site yet** · ${KIND_LABEL[e.kind] ?? e.kind} · ${formatChange(e)}\n\n`);
    md.appendMarkdown(commandLink("Compare with the live site", COMPARE, f.file));
    return md;
  }

  // ------------------------------------------------------------ file badges

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file" || !this.setting("fileBadges")) return undefined;
    const f = this.model.files.get(uri.fsPath);
    if (!f) return undefined;
    const d = new vscode.FileDecoration(
      badgeText(f.edits.length),
      `${editsText(f.edits.length)} not on the live site yet · ${formatCount(f.pages)}`,
      new vscode.ThemeColor("cssBlastRadius.liveEditForeground"),
    );
    d.propagate = true;
    return d;
  }

  // ------------------------------------------------------------ change bars

  /** A "Live site" source control: its change bars and a list of the files that differ. */
  private syncScm(): void {
    if (!this.setting("changeBars")) {
      this.scm?.dispose();
      this.scm = this.group = undefined;
      return;
    }
    if (!this.scm) {
      this.scm = vscode.scm.createSourceControl("cssBlastRadius", "Live site (CSS Blast Radius)", this.folder);
      this.scm.inputBox.visible = false;
      this.scm.count = 0;
      this.scm.quickDiffProvider = {
        provideOriginalResource: (uri) => (uri.scheme === "file" && this.model.files.has(uri.fsPath) ? liveUri(uri) : undefined),
      };
      this.group = this.scm.createResourceGroup("notLive", "Not on the live site yet");
      this.group.hideWhenEmpty = true;
    }
    this.group!.resourceStates = [...this.model.files.values()].map((f) => {
      const uri = vscode.Uri.file(f.file);
      return {
        resourceUri: uri,
        command: { title: "Compare with the live site", command: COMPARE, arguments: [uri] },
        decorations: { tooltip: `${editsText(f.edits.length)} · ${formatCount(f.pages)}` },
      };
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    this.served.set(uri.toString(), uri);
    const file = fileOf(uri);
    try {
      const r = await this.client.call<LiveOriginal>("analysis/liveOriginal", { path: file.fsPath });
      if (r.text !== null) return r.text;
    } catch {
      // Offline or an older server: show no differences rather than an empty file.
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString());
    if (open) return open.getText();
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    } catch {
      return "";
    }
  }

  private async compare(arg?: vscode.Uri | Node | string): Promise<void> {
    const file = typeof arg === "string" ? vscode.Uri.file(arg)
      : arg && "file" in arg && typeof arg.file === "object" ? vscode.Uri.file((arg as Node).file.file)
      : (arg as vscode.Uri | undefined) ?? vscode.window.activeTextEditor?.document.uri;
    if (!file || file.scheme !== "file") return;
    const name = path.basename(file.fsPath);
    await vscode.commands.executeCommand("vscode.diff", liveUri(file), file, `${name} (live site ↔ yours)`);
  }

  // ------------------------------------------------------------ Explorer list

  getChildren(node?: Node): Node[] {
    if (!node) return [...this.model.files.values()].map((file) => ({ file }));
    if (node.edit) return [];
    return node.file.edits.map((edit) => ({ file: node.file, edit }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const uri = vscode.Uri.file(node.file.file);
    const e = node.edit;
    if (!e) {
      const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.file.file;
      const dir = path.dirname(vscode.workspace.asRelativePath(uri));
      item.description = `${dir && dir !== "." ? `${dir} · ` : ""}${editsText(node.file.edits.length)} · ${span(node.file.pages)} pages`;
      item.tooltip = `${vscode.workspace.asRelativePath(uri)}\n${editsText(node.file.edits.length)} not on the live site yet · ${formatCount(node.file.pages)}`;
      item.contextValue = "cssBlastRadius.liveFile";
      item.command = { title: "Open", command: "vscode.open", arguments: [uri] };
      return item;
    }
    const item = new vscode.TreeItem(editLabel(e), vscode.TreeItemCollapsibleState.None);
    item.id = `${node.file.file}#${e.id}`;
    const line = e.ranges[0]?.[0] ?? e.line;
    item.description = `${formatChange(e)} · line ${line}`;
    item.tooltip = `${KIND_LABEL[e.kind] ?? e.kind}${e.oldSelector && e.oldSelector !== e.selector ? ` (was ${e.oldSelector})` : ""}\n${formatChange(e)}`;
    const warn = losesPages(e, this.threshold());
    item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(warn ? "cssBlastRadius.liveEditWarningRuler" : "cssBlastRadius.liveEditRuler"));
    item.contextValue = "cssBlastRadius.liveEdit";
    const at = new vscode.Range(line - 1, 0, line - 1, 0);
    item.command = { title: "Go to edit", command: "vscode.open", arguments: [uri, { selection: at } satisfies vscode.TextDocumentShowOptions] };
    return item;
  }

  private updateTreeMessage(): void {
    const files = [...this.model.files.values()];
    const n = files.reduce((s, f) => s + f.edits.length, 0);
    this.tree.description = n ? `${editsText(n)} in ${files.length} file${files.length === 1 ? "" : "s"}` : undefined;
    if (n) this.tree.message = undefined;
    else if (!this.client.connected) this.tree.message = "Waiting for the CSS Blast Radius server…";
    else if (this.state.status && !this.state.status.ready) this.tree.message = "Scan your linked page groups to compare your CSS with the live site.";
    else this.tree.message = "Your CSS matches the live site.";
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.scm?.dispose();
    this.lineType.dispose();
    this.warnLineType.dispose();
    this.markType.dispose();
    this.warnMarkType.dispose();
    this.decoEmitter.dispose();
    this.treeEmitter.dispose();
    this.contentEmitter.dispose();
  }
}
