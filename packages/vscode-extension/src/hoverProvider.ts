// Hover surface: full answer-contract detail for the selector under the
// cursor (confidence tag, basis, reason codes, condition qualifiers).

import * as vscode from "vscode";
import type { ImpactStore } from "./impactStore.js";
import type { SelectorImpact } from "./answerContract.js";

function renderMarkdown(s: SelectorImpact, baseIndexRevision: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`### CSS Blast Radius — \`${s.selector}\`\n\n`);
  if (s.conditionPath.length) {
    md.appendMarkdown(`**Condition:** ${s.conditionPath.join(" → ")}\n\n`);
  }
  md.appendMarkdown(`| Metric | Value |\n|---|---|\n`);
  md.appendMarkdown(`| \`matches\` | ${s.matches} (exact, real DOM) |\n`);
  for (const a of s.applies) {
    md.appendMarkdown(`| \`applies\` (${a.property}) | ${a.winCount} of ${a.sampledCount} sampled |\n`);
  }
  md.appendMarkdown(`| \`inheritsInto\` | ${s.inheritsInto} (descendant reach, understates blast radius) |\n`);
  md.appendMarkdown(`| \`confidence\` | ${s.confidence} |\n`);
  md.appendMarkdown(`| \`basis\` | ${s.basis} |\n`);
  md.appendMarkdown(`| \`overlayState\` | ${s.overlayState} |\n`);
  md.appendMarkdown(`| \`baseIndexRevision\` | ${baseIndexRevision} |\n`);
  if (s.reasonCodes.length) {
    md.appendMarkdown(`\n**Reason codes:** ${s.reasonCodes.map((r) => `\`${r}\``).join(", ")}\n`);
  }
  if (s.losses.length) {
    md.appendMarkdown(`\n**⚠ Pages losing this styling:**\n\n`);
    for (const loss of s.losses.slice(0, 10)) {
      md.appendMarkdown(
        `- ${loss.pageUrl} loses \`${loss.property}\`${loss.hasFallbackRule ? " (another rule still supplies it)" : " — **no fallback rule found**"}\n`,
      );
    }
  }
  md.appendMarkdown(`\n[Show full drilldown](command:cssBlastRadius.showDrilldown?${encodeURIComponent(JSON.stringify(["", s.selector]))})`);
  return md;
}

export class ImpactHoverProvider implements vscode.HoverProvider {
  constructor(private readonly store: ImpactStore) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const answer = this.store.get(document.uri.fsPath);
    if (!answer) return undefined;
    const line = document.lineAt(position.line).text;

    for (const s of answer.selectors) {
      if (line.includes(s.selector)) {
        return new vscode.Hover(renderMarkdown(s, answer.baseIndexRevision));
      }
    }
    return undefined;
  }
}
