// Problems-panel diagnostics: reserved for high-signal negative states only
// (deletions/renames that leave pages with no fallback rule, unsupported
// constructs, stale/missing index). Neutral informational counts must not
// spam this panel (see architecture doc "How results surface in-editor").

import * as vscode from "vscode";
import type { ImpactStore } from "./impactStore.js";
import type { ImpactAnswer } from "./answerContract.js";

function findSelectorRange(document: vscode.TextDocument, selector: string): vscode.Range {
  const text = document.getText();
  const idx = text.indexOf(selector);
  if (idx < 0) return new vscode.Range(0, 0, 0, 0);
  const start = document.positionAt(idx);
  const end = document.positionAt(idx + selector.length);
  return new vscode.Range(start, end);
}

export function buildDiagnostics(document: vscode.TextDocument, answer: ImpactAnswer): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const s of answer.selectors) {
    const range = findSelectorRange(document, s.selector);

    const unfixedLosses = s.losses.filter((l) => !l.hasFallbackRule);
    if (unfixedLosses.length > 0) {
      const pages = [...new Set(unfixedLosses.map((l) => l.pageUrl))];
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          `Removing "${s.selector}" leaves ${pages.length} page(s) with no rule supplying: ` +
            [...new Set(unfixedLosses.map((l) => l.property))].join(", "),
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }

    if (s.confidence === "UNSUPPORTED") {
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          `Selector "${s.selector}" uses a construct the index cannot evaluate (${s.reasonCodes.join(", ")}).`,
          vscode.DiagnosticSeverity.Information,
        ),
      );
    }

    if (s.confidence === "STALE") {
      diagnostics.push(
        new vscode.Diagnostic(
          range,
          `Index is stale for "${s.selector}"; results may not reflect the current DOM.`,
          vscode.DiagnosticSeverity.Information,
        ),
      );
    }
  }

  return diagnostics;
}

export function wireDiagnostics(store: ImpactStore, collection: vscode.DiagnosticCollection) {
  store.onDidUpdate((file) => {
    const answer = store.get(file);
    if (!answer) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (!doc) return;
    collection.set(doc.uri, buildDiagnostics(doc, answer));
  });
}
