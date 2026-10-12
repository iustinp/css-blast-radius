// Dedicated webview: full page list / element drilldown for a selector.
// Per architecture doc, the webview never talks to the daemon directly —
// it only receives data the extension host already fetched/proxied.

import * as vscode from "vscode";
import type { SelectorImpact, ImpactAnswer } from "./answerContract.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function showDrilldownPanel(context: vscode.ExtensionContext, answer: ImpactAnswer, selector: string) {
  const impact: SelectorImpact | undefined = answer.selectors.find((s) => s.selector === selector);
  const panel = vscode.window.createWebviewPanel(
    "cssBlastRadiusDrilldown",
    `Blast radius: ${selector}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );

  if (!impact) {
    panel.webview.html = `<html><body><p>No impact data for <code>${escapeHtml(selector)}</code> yet.</p></body></html>`;
    return;
  }

  const rows = impact.matchedPages
    .map((p) => `<tr><td>${escapeHtml(p.url)}</td><td>${p.matches}</td></tr>`)
    .join("\n");

  const lossRows = impact.losses
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.pageUrl)}</td><td>${escapeHtml(l.property)}</td><td>${l.hasFallbackRule ? "covered by another rule" : "⚠ no fallback"}</td></tr>`,
    )
    .join("\n");

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); padding: 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
</style>
</head>
<body>
  <h2><code>${escapeHtml(impact.selector)}</code></h2>
  <p>
    <span class="badge">${impact.confidence}</span>
    <span class="badge">${impact.basis}</span>
    <span class="badge">${impact.matches} matches</span>
  </p>
  ${impact.conditionPath.length ? `<p>Condition: ${impact.conditionPath.map(escapeHtml).join(" → ")}</p>` : ""}
  <h3>Matched pages</h3>
  <table><thead><tr><th>Page</th><th>Matches</th></tr></thead><tbody>${rows || "<tr><td colspan=2>None</td></tr>"}</tbody></table>
  ${
    impact.losses.length
      ? `<h3>Pages losing styling</h3><table><thead><tr><th>Page</th><th>Property</th><th>Status</th></tr></thead><tbody>${lossRows}</tbody></table>`
      : ""
  }
  <p><em>Reason codes: ${impact.reasonCodes.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ") || "none"}</em></p>
</body>
</html>`;
}
