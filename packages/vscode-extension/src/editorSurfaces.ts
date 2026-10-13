// Editor surfaces (§7.1): end-of-line decorations and the status bar update
// immediately from each answer; CodeLens settles once typing pauses; the
// hover explains; Problems only carries important negatives.

import * as vscode from "vscode";
import type { DaemonClient } from "./daemonClient";
import type { DaemonLifecycle } from "./daemonLifecycle";
import { isCssDocument, type DocumentSync } from "./documentSync";
import {
  DIFF_BASE_LABEL,
  changeAtCursor,
  formatCount,
  formatAge,
  ghostText,
  isZero,
  reasonText,
  span,
} from "./format";
import type { ChangeAnswer, Count, FileAnswer, PagesTarget, RuleCount, RulesResult } from "./protocol";
import type { ImpactState } from "./state";

function commandLink(title: string, command: string, args: unknown): string {
  return `[${title}](command:${command}?${encodeURIComponent(JSON.stringify([args]))})`;
}

function countLine(c: Count): string {
  const parts = [`**${c.exact.toLocaleString("en-US")}** exact`];
  if (c.possible) parts.push(`${c.possible.toLocaleString("en-US")} possible`);
  if (c.unknown) parts.push(`${c.unknown.toLocaleString("en-US")} unknown`);
  return parts.join(" · ") + (c.complete ? "" : " _(resolving…)_");
}

const KIND_LABEL: Record<string, string> = {
  declarations: "Declarations changed",
  selector: "Selector changed",
  condition: "Condition changed",
  added: "Rule added",
  removed: "Rule removed",
  moved: "Rule moved",
  definition: "Definition changed",
  "layer-order": "Layer order changed",
  import: "@import changed",
  namespace: "@namespace changed",
  unrecognized: "At-rule changed",
};

export class EditorSurfaces implements vscode.Disposable, vscode.CodeLensProvider, vscode.HoverProvider {
  private readonly normal = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 2.5em", color: new vscode.ThemeColor("editorCodeLens.foreground"), fontStyle: "italic" },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly attention = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 2.5em", color: new vscode.ThemeColor("editorWarning.foreground"), fontStyle: "italic" },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly statusItem = vscode.window.createStatusBarItem("cssBlastRadius.status", vscode.StatusBarAlignment.Left, 50);
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("css-blast-radius");
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private readonly ruleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly client: DaemonClient,
    private readonly life: DaemonLifecycle,
    private readonly state: ImpactState,
    private readonly sync: DocumentSync,
  ) {
    this.statusItem.name = "CSS Blast Radius";
    this.statusItem.show();
    this.subs.push(
      state.onFile((path) => {
        this.decorate(path);
        this.diagnose(path);
        this.scheduleRules(path);
      }),
      state.onSession(() => this.updateStatus()),
      state.onStatus(() => {
        this.updateStatus();
        this.lensEmitter.fire();
        for (const ed of vscode.window.visibleTextEditors) this.decorate(ed.document.uri.fsPath);
      }),
      state.onRulesInvalidated(() => this.lensEmitter.fire()),
      life.onState(() => this.updateStatus()),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const p of state.answers.keys()) this.decorate(p);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => this.decorate(e.textEditor.document.uri.fsPath)),
      vscode.window.onDidChangeActiveTextEditor(() => {
        for (const ed of vscode.window.visibleTextEditors) this.decorate(ed.document.uri.fsPath);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cssBlastRadius.cursorCount") || e.affectsConfiguration("cssBlastRadius.warnLostPages")) {
          for (const path of this.state.answers.keys()) {
            this.decorate(path);
            this.diagnose(path);
          }
        }
      }),
      vscode.languages.registerCodeLensProvider({ language: "css", scheme: "file" }, this),
      vscode.languages.registerHoverProvider({ language: "css", scheme: "file" }, this),
    );
    this.updateStatus();
  }

  // ------------------------------------------------------------ decorations

  private decorate(path: string): void {
    const a = this.state.answers.get(path);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.fsPath !== path) continue;
      const normal: vscode.DecorationOptions[] = [];
      const attention: vscode.DecorationOptions[] = [];
      if (a && this.state.status?.scope?.linked && vscode.workspace.getConfiguration("cssBlastRadius", ed.document.uri).get<boolean>("cursorCount") !== false
        && vscode.window.activeTextEditor === ed && ed.selections.length) {
        const line = ed.selection.active.line;
        const ch = changeAtCursor(a.changes, this.rulesFor(a), line + 1);
        if (ch || a.editing) {
          const end = ed.document.lineAt(line).range.end;
          const opt: vscode.DecorationOptions = {
            range: new vscode.Range(end, end),
            renderOptions: { after: { contentText: ch ? ghostText(a, ch) : "◀ finish typing…" } },
          };
          (ch && this.isAttention(ch) ? attention : normal).push(opt);
        }
      }
      ed.setDecorations(this.normal, normal);
      ed.setDecorations(this.attention, attention);
    }
  }

  private rulesFor(a: FileAnswer): RuleCount[] {
    const r = this.state.rules.get(a.file);
    return r?.editRevision === a.editRevision && r.indexRevision === a.indexRevision ? r.rules : [];
  }

  /** Rule ranges are fetched independently of the instant answer/decorations path. */
  private scheduleRules(path: string): void {
    clearTimeout(this.ruleTimers.get(path));
    const a = this.state.answers.get(path);
    if (!a || !this.client.connected || !this.sync.isTracked(path)) return;
    this.ruleTimers.set(path, setTimeout(() => {
      this.ruleTimers.delete(path);
      void this.client.call<RulesResult>("analysis/queryImpacts", { path, scope: "rules" }).then((r) => {
        if (this.state.acceptRules(r) && this.state.answers.get(path)?.editRevision === r.editRevision) this.decorate(path);
      }).catch(() => {});
    }, 180));
  }

  private lostThreshold(): number {
    return vscode.workspace.getConfiguration("cssBlastRadius").get<number>("warnLostPages") ?? 10;
  }

  private isAttention(ch: ChangeAnswer): boolean {
    const lost = ch.kind === "removed" ? ch.lost ?? ch.pages : ch.kind === "selector" ? ch.lost : undefined;
    return !!lost && lost.exact >= this.lostThreshold();
  }

  // ------------------------------------------------------------- Problems

  private diagnose(path: string): void {
    const a = this.state.answers.get(path);
    const uri = vscode.Uri.file(path);
    if (!a) {
      this.diagnostics.delete(uri);
      return;
    }
    const out: vscode.Diagnostic[] = [];
    const at = (line: number) => new vscode.Range(Math.max(line - 1, 0), 0, Math.max(line - 1, 0), 1000);
    for (const ch of a.changes) {
      if (!this.isAttention(ch)) continue;
      const lost = ch.kind === "removed" ? ch.lost ?? ch.pages : ch.lost!;
      const msg =
        ch.kind === "removed"
          ? `Removing ${ch.selector ?? "this rule"} takes it away from ${span(lost)} pages.`
          : `${ch.selector} no longer reaches ${span(lost)} pages that ${ch.oldSelector} matched.`;
      const d = new vscode.Diagnostic(at(ch.line), msg, vscode.DiagnosticSeverity.Warning);
      d.source = "CSS Blast Radius";
      out.push(d);
    }
    for (const r of a.totalReasons) {
      const m = /^(?:invalid-on-save|parse-error):line (\d+)/.exec(r);
      if (!m) continue;
      const d = new vscode.Diagnostic(at(Number(m[1])), reasonText(r), vscode.DiagnosticSeverity.Warning);
      d.source = "CSS Blast Radius";
      out.push(d);
    }
    if (a.freshness?.stale && a.changes.length) {
      const d = new vscode.Diagnostic(at(1), "Pages changed since the last scan. Rescan linked groups for exact numbers.", vscode.DiagnosticSeverity.Information);
      d.source = "CSS Blast Radius";
      out.push(d);
    }
    this.diagnostics.set(uri, out);
  }

  // ------------------------------------------------------------ status bar

  private updateStatus(): void {
    const item = this.statusItem;
    const st = this.state.status;
    const life = this.life;
    item.backgroundColor = undefined;
    item.command = "cssBlastRadius.togglePanel";
    if (life.state === "STARTING" && !st) {
      item.text = "$(sync~spin) Blast radius";
      item.tooltip = "Connecting to the CSS Blast Radius server…";
      return;
    }
    if (life.state !== "CONNECTED") {
      item.text = "$(warning) Blast radius: server offline";
      item.tooltip = `${life.stateDetail} Click to retry or start the server.`;
      item.command = "cssBlastRadius.reconnectServer";
      return;
    }
    if (!st?.scope?.linked) {
      item.text = "$(link) Link page groups";
      item.tooltip = "Link page groups to this project to see which pages your CSS edits affect.";
      item.command = "cssBlastRadius.linkGroups";
      return;
    }
    if (st?.capture?.running) {
      item.text = `$(sync~spin) Scanning ${st.capture.done}/${st.capture.total}`;
      item.tooltip = "Scanning linked groups in the background.";
      return;
    }
    if (st && !st.ready) {
      item.text = "$(circle-slash) Blast radius: no scanned pages";
      item.tooltip = "No pages scanned yet. Click to rescan linked groups.";
      item.command = "cssBlastRadius.rescanGroups";
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }
    const s = this.state.session;
    const warn = st?.health === "DEGRADED" || this.state.degraded ? " $(warning)" : "";
    item.text = `◎ ${formatCount(s?.total ?? { exact: 0, possible: 0, unknown: 0, complete: true })}${warn}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ["cssBlastRadius.showAllPages", "cssBlastRadius.linkGroups"] };
    md.appendMarkdown(`**CSS Blast Radius** — compared with ${DIFF_BASE_LABEL[s?.diffBase ?? st?.diffBase ?? "production"] ?? "the live site"}\n\n`);
    md.appendMarkdown(`Linked groups: ${st.scope.groups.map((g) => g.name.replace(/[\\`*_~\[\]<>]/g, "\\$&") + (g.active ? "" : " (paused)")).join(", ") || "none"} (${st.scope.pages.toLocaleString("en-US")} active pages)\n\n`);
    if (s?.files.length) {
      md.appendMarkdown(`Your edits reach ${countLine(s.total)} pages\n\n`);
      for (const f of s.files.slice(0, 12)) {
        md.appendMarkdown(`- \`${vscode.workspace.asRelativePath(f.file)}\`: ${formatCount(f.pages)} (${f.changes} change${f.changes === 1 ? "" : "s"})\n`);
      }
      if (s.files.length > 12) md.appendMarkdown(`- …and ${s.files.length - 12} more files\n`);
    } else md.appendMarkdown("No CSS changes compared with the live site.\n");
    if (st) {
      const scanned = st.capturedAt ? formatAge(Math.max(0, Date.now() - Date.parse(st.capturedAt))) : "not yet";
      md.appendMarkdown(`\n\n${s?.diffBase === "production" || !s ? "Compared with the live site" : "The live site was scanned"} (${s?.diffBase === "production" || !s ? "scanned " : ""}${scanned})`);
      if (st.failedPages) md.appendMarkdown(` · ${st.failedPages} failed`);
      if (st.markupChanged) md.appendMarkdown("\n\n$(warning) Pages changed since the last scan.");
    }
    if (this.state.degraded) md.appendMarkdown(`\n\n$(warning) ${this.state.degraded}`);
    md.appendMarkdown(`\n\n${commandLink("Show all affected pages", "cssBlastRadius.showAllPages", {})} · ${commandLink("Link page groups", "cssBlastRadius.linkGroups", {})}`);
    item.tooltip = md;
  }

  // -------------------------------------------------------------- CodeLens

  async provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (!isCssDocument(doc) || !this.client.connected || !this.sync.isTracked(doc.uri.fsPath)) return [];
    if (vscode.workspace.getConfiguration("cssBlastRadius").get<boolean>("codeLens") !== true) return [];
    const path = doc.uri.fsPath;
    await this.sync.whenSynced(path);
    if (token.isCancellationRequested) return [];
    let res: RulesResult;
    try {
      res = await this.client.call<RulesResult>("analysis/queryImpacts", { path, scope: "rules" });
    } catch {
      return [];
    }
    // An older reply than one already shown must not replace it.
    this.state.acceptRules(res);
    this.decorate(path);
    const rules = this.state.rules.get(res.file) ?? res;
    const lenses: vscode.CodeLens[] = [];
    for (const r of rules.rules) {
      const line = r.line - 1;
      if (line < 0 || line >= doc.lineCount) continue;
      const range = new vscode.Range(line, 0, line, 0);
      const cond = r.conditions.length ? ` · ${r.conditions.join(", ")}` : "";
      const title = `${formatCount(r.pages, r.reasons)}${cond}`;
      const target: PagesTarget = { path, line: r.line, title: r.selector };
      lenses.push(
        isZero(r.pages)
          ? new vscode.CodeLens(range, { title, command: "" })
          : new vscode.CodeLens(range, { title, command: "cssBlastRadius.showPages", arguments: [target], tooltip: "Show the pages this rule reaches" }),
      );
    }
    return lenses;
  }

  // ----------------------------------------------------------------- hover

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!this.state.status?.scope?.linked) return undefined;
    const path = doc.uri.fsPath;
    const a = this.state.answers.get(path);
    const line = pos.line + 1;
    const ch = a && changeAtCursor(a.changes, this.rulesFor(a), line);
    if (!ch || !a) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ["cssBlastRadius.showPages", "cssBlastRadius.showAllPages"] };
    md.supportHtml = false;
    this.hoverChange(md, a, ch);
    return new vscode.Hover(md);
  }

  private hoverChange(md: vscode.MarkdownString, a: FileAnswer, ch: ChangeAnswer): void {
    const label = KIND_LABEL[ch.kind] ?? ch.kind;
    md.appendMarkdown(`**${label}**${ch.selector ? ` — \`${ch.selector}\`` : ""}\n\n`);
    if (ch.oldSelector && ch.oldSelector !== ch.selector) md.appendMarkdown(`was \`${ch.oldSelector}\`\n\n`);
    if (ch.definition) md.appendMarkdown(`${ch.definition.kind} \`${ch.definition.name}\` ${ch.definition.change}\n\n`);
    if (ch.changedProps?.length) md.appendMarkdown(`Properties: ${ch.changedProps.map((p) => `\`${p}\``).join(", ")}\n\n`);
    md.appendMarkdown(`**${formatCount(ch.pages, ch.reasons)}** affected\n\n`);
    if (ch.gained && ch.lost) md.appendMarkdown(`Starts reaching: ${countLine(ch.gained)}  \nStops reaching: ${countLine(ch.lost)}\n\n`);
    else if (ch.kind === "removed" && ch.lost) md.appendMarkdown(`Pages that lose the rule: ${countLine(ch.lost)}\n\n`);
    if (ch.conditions.length) md.appendMarkdown(`Conditions: ${ch.conditions.map((c) => `\`${c}\``).join(", ")}\n\n`);
    for (const r of ch.reasons) md.appendMarkdown(`- ${reasonText(r)}\n`);
    if (ch.hint) md.appendMarkdown(`\n${ch.hint}\n`);
    if (ch.detail) md.appendMarkdown(`\n${ch.detail}\n`);
    md.appendMarkdown(`\n\n_Open a page to see what actually changes._\n\n`);
    md.appendMarkdown(this.footer(a));
    const sides: PagesTarget["sides"] = ["pages", ...(ch.gained ? (["gained"] as const) : []), ...(ch.lost ? (["lost"] as const) : [])];
    const base = { path: a.file, changeId: ch.id, sides: sides.length > 1 ? sides : undefined };
    const links = [commandLink("Show pages", "cssBlastRadius.showPages", { ...base, title: ch.selector ?? label } satisfies PagesTarget)];
    if (ch.gained && !isZero(ch.gained)) links.push(commandLink("gained", "cssBlastRadius.showPages", { ...base, side: "gained", title: ch.selector ?? label } satisfies PagesTarget));
    if (ch.lost && !isZero(ch.lost)) links.push(commandLink("lost", "cssBlastRadius.showPages", { ...base, side: "lost", title: ch.selector ?? label } satisfies PagesTarget));
    links.push(commandLink("Show all affected pages", "cssBlastRadius.showAllPages", {}));
    md.appendMarkdown(`\n\n${links.join(" · ")} · ${process.platform === "darwin" ? "⌥B" : "Alt+B"}`);
  }

  private footer(a: FileAnswer): string {
    const parts = [`compared with ${DIFF_BASE_LABEL[a.diffBase] ?? "the live site"}`];
    if (a.freshness) parts.push(`scanned ${formatAge(a.freshness.ageMs)}`);
    if (!a.mapping.mapped) parts.push("file not matched to a stylesheet on the live site");
    if (a.editing) parts.push("finish typing to update");
    return `_${parts.join(" · ")}_`;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    for (const t of this.ruleTimers.values()) clearTimeout(t);
    this.normal.dispose();
    this.attention.dispose();
    this.statusItem.dispose();
    this.diagnostics.dispose();
    this.lensEmitter.dispose();
  }
}
