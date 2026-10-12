// CodeLens surface: one lens above each changed rule showing the primary
// impact-contract summary. Full contract detail lives in the hover.
//
// MVP simplification: since selector-text-to-source-range mapping stays in
// the daemon's authoritative CSS parse (thin-client rule — see architecture
// doc), the extension re-locates each selector's line via a plain text
// search over the open document rather than re-parsing CSS itself. This is
// good enough for flat, non-minified authored CSS; a future protocol
// addition could have the daemon return source ranges directly.

import * as vscode from "vscode";
import type { ImpactStore } from "./impactStore.js";
import type { SelectorImpact } from "./answerContract.js";

function summaryText(s: SelectorImpact): string {
  const parts = [`Affects ${s.matches} match${s.matches === 1 ? "" : "es"}`];
  const pages = s.matchedPages.length;
  if (pages) parts.push(`${pages} page${pages === 1 ? "" : "s"}`);
  const applies = s.applies.find((a) => a.sampledCount > 0);
  if (applies) parts.push(`applies ${applies.winCount}/${applies.sampledCount} sampled`);
  if (s.kind === "removed") parts.unshift("[REMOVED]");
  parts.push(`(${s.confidence})`);
  return parts.join(" · ");
}

function findSelectorLine(document: vscode.TextDocument, selector: string): number | undefined {
  const text = document.getText();
  const idx = text.indexOf(selector);
  if (idx < 0) return undefined;
  return document.positionAt(idx).line;
}

export class ImpactCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly store: ImpactStore) {
    store.onDidUpdate(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const answer = this.store.get(document.uri.fsPath);
    if (!answer) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const s of answer.selectors) {
      const line = findSelectorLine(document, s.selector);
      if (line === undefined) continue;
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: summaryText(s),
          command: "cssBlastRadius.showDrilldown",
          arguments: [document.uri.fsPath, s.selector],
        }),
      );
    }
    return lenses;
  }
}
