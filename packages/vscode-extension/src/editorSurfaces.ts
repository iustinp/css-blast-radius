// Editor surfaces (§7.1): end-of-line decorations and the status bar update
// immediately from each answer; CodeLens settles once typing pauses; the
// hover explains; Problems only carries important negatives.

import * as vscode from "vscode";
import type { DaemonClient } from "./daemonClient";
import type { DaemonLifecycle } from "./daemonLifecycle";
import { isCssDocument, type DocumentSync } from "./documentSync";
import {
  DIFF_BASE_LABEL,
  formatChange,
  formatCount,
  freshnessText,
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
      }),
      state.onSession(() => this.updateStatus()),
      state.onStatus(() => {
        this.updateStatus();
        this.lensEmitter.fire();
      }),
      state.onRulesInvalidated(() => this.lensEmitter.fire()),
      life.onState(() => this.updateStatus()),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const p of state.answers.keys()) this.decorate(p);
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
      if (a) {
        const suffix = (a.editing ? " · editing" : "") + (a.freshness?.stale ? " · stale" : "");
        const seen = new Set<number>();
        for (const ch of a.changes) {
          const line = Math.min(Math.max(ch.line - 1, 0), ed.document.lineCount - 1);
          if (seen.has(line)) continue;
          seen.add(line);
          const end = ed.document.lineAt(line).range.end;
          const opt: vscode.DecorationOptions = {
            range: new vscode.Range(end, end),
            renderOptions: { after: { contentText: `${formatChange(ch)}${suffix}` } },
          };
          (this.isAttention(ch) ? attention : normal).push(opt);
        }
      }
      ed.setDecorations(this.normal, normal);
      ed.setDecorations(this.attention, attention);
    }
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
      const d = new vscode.Diagnostic(at(1), "The index is older than this stylesheet or your markup: counts describe the captured site. Recapture for exact numbers.", vscode.DiagnosticSeverity.Information);
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
    item.command = "cssBlastRadius.showPages";
    if (life.state === "FAILED") {
      item.text = "$(error) Blast radius";
      item.tooltip = life.stateDetail;
      item.command = "cssBlastRadius.showOutput";
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      return;
    }
    if (life.state === "STARTING") {
      item.text = "$(sync~spin) Blast radius";
      item.tooltip = "Starting the CSS Blast Radius daemon…";
      return;
    }
    if (life.state === "DISCONNECTED") {
      item.text = "$(debug-disconnect) Blast radius";
      item.tooltip = `${life.stateDetail} Results shown may be stale.`;
      item.command = "cssBlastRadius.restartDaemon";
      return;
    }
    if (st?.capture?.running) {
      item.text = `$(sync~spin) Capturing ${st.capture.done}/${st.capture.total}`;
      item.tooltip = "Capturing the site in the background. Answers switch to the new index when it's ready.";
      return;
    }
    if (st && !st.ready) {
      item.text = "$(circle-slash) Blast radius: no index";
      item.tooltip = "No index yet. Click to capture the site.";
      item.command = "cssBlastRadius.captureSite";
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }
    const s = this.state.session;
    const warn = st?.health === "DEGRADED" || this.state.degraded ? " $(warning)" : "";
    const stale = st?.markupChanged ? " · stale" : "";
    if (!s || s.files.length === 0) item.text = `$(pass) No CSS edits${stale}${warn}`;
    else item.text = `$(flame) Your edits: ${formatCount(s.total, s.reasons)}${stale}${warn}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**CSS Blast Radius** — compared with ${DIFF_BASE_LABEL[s?.diffBase ?? st?.diffBase ?? "HEAD"] ?? s?.diffBase}\n\n`);
    if (s?.files.length) {
      md.appendMarkdown(`Your edits reach ${countLine(s.total)} pages\n\n`);
      for (const f of s.files.slice(0, 12)) {
        md.appendMarkdown(`- \`${vscode.workspace.asRelativePath(f.file)}\`: ${formatCount(f.pages)} (${f.changes} change${f.changes === 1 ? "" : "s"})\n`);
      }
      if (s.files.length > 12) md.appendMarkdown(`- …and ${s.files.length - 12} more files\n`);
    } else md.appendMarkdown("No CSS changes against the diff base.\n");
    if (st) {
      md.appendMarkdown(`\n\nIndex: ${st.pages.toLocaleString("en-US")} pages`);
      if (st.capturedAt) md.appendMarkdown(`, captured ${new Date(st.capturedAt).toLocaleString()}`);
      if (st.failedPages) md.appendMarkdown(` · ${st.failedPages} failed`);
      if (st.markupChanged) md.appendMarkdown("\n\n$(warning) Markup changed since the capture: counts describe the captured site.");
    }
    if (this.state.degraded) md.appendMarkdown(`\n\n$(warning) ${this.state.degraded}`);
    md.appendMarkdown(`\n\n${commandLink("Show pages", "cssBlastRadius.showPages", {})} · ${commandLink("Change diff base", "cssBlastRadius.setDiffBase", {})} · ${commandLink("Recapture", "cssBlastRadius.captureSite", {})}`);
    item.tooltip = md;
  }

  // -------------------------------------------------------------- CodeLens

  async provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (!isCssDocument(doc) || !this.client.connected || !this.sync.isTracked(doc.uri.fsPath)) return [];
    if (vscode.workspace.getConfiguration("cssBlastRadius").get<boolean>("codeLens") === false) return [];
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
    const path = doc.uri.fsPath;
    const a = this.state.answers.get(path);
    const line = pos.line + 1;
    const ch = a?.changes.find((c) => c.line === line);
    // Only on a changed line or a rule's first line, so typing isn't covered by hovers.
    const rule = ch ? undefined : this.state.rules.get(path)?.rules.find((r) => r.line === line);
    if (!ch && !rule) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = false;
    if (ch && a) this.hoverChange(md, a, ch);
    else if (rule) this.hoverRule(md, path, rule);
    return new vscode.Hover(md);
  }

  private hoverChange(md: vscode.MarkdownString, a: FileAnswer, ch: ChangeAnswer): void {
    const label = KIND_LABEL[ch.kind] ?? ch.kind;
    md.appendMarkdown(`**${label}**${ch.selector ? ` — \`${ch.selector}\`` : ""}\n\n`);
    if (ch.oldSelector && ch.oldSelector !== ch.selector) md.appendMarkdown(`was \`${ch.oldSelector}\`\n\n`);
    if (ch.definition) md.appendMarkdown(`${ch.definition.kind} \`${ch.definition.name}\` ${ch.definition.change}\n\n`);
    if (ch.changedProps?.length) md.appendMarkdown(`Properties: ${ch.changedProps.map((p) => `\`${p}\``).join(", ")}\n\n`);
    md.appendMarkdown(`Pages reached: ${countLine(ch.pages)}\n\n`);
    if (ch.gained && ch.lost) md.appendMarkdown(`Starts reaching: ${countLine(ch.gained)}  \nStops reaching: ${countLine(ch.lost)}\n\n`);
    else if (ch.kind === "removed" && ch.lost) md.appendMarkdown(`Pages that lose the rule: ${countLine(ch.lost)}\n\n`);
    if (ch.conditions.length) md.appendMarkdown(`Conditions: ${ch.conditions.map((c) => `\`${c}\``).join(", ")}\n\n`);
    for (const r of ch.reasons) md.appendMarkdown(`- ${reasonText(r)}\n`);
    if (ch.hint) md.appendMarkdown(`\n${ch.hint}\n`);
    if (ch.detail) md.appendMarkdown(`\n${ch.detail}\n`);
    md.appendMarkdown(`\n\n_Matching is not changing: open a page to see what actually changes._\n\n`);
    md.appendMarkdown(this.footer(a));
    const sides: PagesTarget["sides"] = ["pages", ...(ch.gained ? (["gained"] as const) : []), ...(ch.lost ? (["lost"] as const) : [])];
    const base = { path: a.file, changeId: ch.id, sides: sides.length > 1 ? sides : undefined };
    const links = [commandLink("Show pages", "cssBlastRadius.showPages", { ...base, title: ch.selector ?? label } satisfies PagesTarget)];
    if (ch.gained && !isZero(ch.gained)) links.push(commandLink("gained", "cssBlastRadius.showPages", { ...base, side: "gained", title: ch.selector ?? label } satisfies PagesTarget));
    if (ch.lost && !isZero(ch.lost)) links.push(commandLink("lost", "cssBlastRadius.showPages", { ...base, side: "lost", title: ch.selector ?? label } satisfies PagesTarget));
    md.appendMarkdown(`\n\n${links.join(" · ")}`);
  }

  private hoverRule(md: vscode.MarkdownString, path: string, r: RuleCount): void {
    md.appendMarkdown(`**\`${r.selector}\`** reaches ${countLine(r.pages)} pages\n\n`);
    if (r.conditions.length) md.appendMarkdown(`Conditions: ${r.conditions.map((c) => `\`${c}\``).join(", ")}\n\n`);
    for (const x of r.reasons) md.appendMarkdown(`- ${reasonText(x)}\n`);
    const a = this.state.answers.get(path);
    if (a) md.appendMarkdown(`\n\n${this.footer(a)}`);
    if (!isZero(r.pages)) md.appendMarkdown(`\n\n${commandLink("Show pages", "cssBlastRadius.showPages", { path, line: r.line, title: r.selector } satisfies PagesTarget)}`);
  }

  private footer(a: FileAnswer): string {
    const parts = [`L${a.level}`, `vs ${DIFF_BASE_LABEL[a.diffBase] ?? a.diffBase}`, freshnessText(a.freshness)];
    if (!a.mapping.mapped) parts.push("file not mapped to a deployed stylesheet");
    else parts.push(`linked from ${a.mapping.linkedPages.toLocaleString("en-US")} pages`);
    if (a.editing) parts.push("mid-edit: last valid version");
    return `_${parts.join(" · ")}_`;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.normal.dispose();
    this.attention.dispose();
    this.statusItem.dispose();
    this.diagnostics.dispose();
    this.lensEmitter.dispose();
  }
}
