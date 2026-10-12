// Extension host entry point (thin client). Owns: document lifecycle
// events, daemon discovery/launch/attach, UI surfacing. Never runs
// crawling/CSSOM parsing/browser automation itself (architecture doc
// "What runs in the extension host").

import * as vscode from "vscode";
import * as path from "node:path";
import { DaemonLifecycle } from "./daemonLifecycle.js";
import { ImpactStore } from "./impactStore.js";
import { ImpactCodeLensProvider } from "./codeLensProvider.js";
import { ImpactHoverProvider } from "./hoverProvider.js";
import { wireDiagnostics } from "./diagnostics.js";
import { showDrilldownPanel } from "./drilldownPanel.js";
import type { ImpactAnswer } from "./answerContract.js";

let lifecycle: DaemonLifecycle | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return; // no workspace open: nothing to attach to

  const config = vscode.workspace.getConfiguration("cssBlastRadius");
  const configuredRoot = config.get<string>("siteRoot");
  const siteRoot = configuredRoot ? path.resolve(folder.uri.fsPath, configuredRoot) : folder.uri.fsPath;

  lifecycle = new DaemonLifecycle(folder.uri.fsPath, siteRoot);
  context.subscriptions.push(lifecycle);

  const store = new ImpactStore();
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("cssBlastRadius");
  context.subscriptions.push(diagnosticCollection);
  wireDiagnostics(store, diagnosticCollection);

  const codeLensProvider = new ImpactCodeLensProvider(store);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "css" }, codeLensProvider),
    vscode.languages.registerHoverProvider({ language: "css" }, new ImpactHoverProvider(store)),
  );

  await lifecycle.start();

  lifecycle.client.onNotification((method, params) => {
    if (method === "analysis/publishImpact") {
      store.set(params as ImpactAnswer);
    } else if (method === "server/degraded" || method === "index/statusChanged") {
      // Surfaced via the status bar item already owned by DaemonLifecycle.
    }
  });

  // Attach the daemon to this workspace once connected.
  try {
    await lifecycle.client.call("workspace/attach", { siteRoot });
  } catch {
    // Health already reflects BLOCKED/DEGRADED; nothing further to do here.
  }

  function isCssDoc(doc: vscode.TextDocument) {
    return doc.languageId === "css";
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (doc) => {
      if (!isCssDoc(doc)) return;
      try {
        await lifecycle!.client.call("document/open", { path: doc.uri.fsPath, content: doc.getText() });
      } catch {
        /* daemon not ready yet; the periodic reconnect will catch up */
      }
    }),
    vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (!isCssDoc(e.document)) return;
      try {
        const answer = await lifecycle!.client.call<ImpactAnswer>("document/change", {
          path: e.document.uri.fsPath,
          content: e.document.getText(),
        });
        store.set(answer);
      } catch {
        /* dropped; a subsequent edit or the fs watcher fallback will retry */
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!isCssDoc(doc)) return;
      try {
        await lifecycle!.client.call("document/save", { path: doc.uri.fsPath, content: doc.getText() });
      } catch {
        /* ignore */
      }
    }),
    vscode.workspace.onDidCloseTextDocument(async (doc) => {
      if (!isCssDoc(doc)) return;
      try {
        await lifecycle!.client.call("document/close", { path: doc.uri.fsPath });
      } catch {
        /* ignore */
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cssBlastRadius.showDrilldown", (filePath: string, selector: string) => {
      const activeFile = filePath || vscode.window.activeTextEditor?.document.uri.fsPath;
      const answer = activeFile ? store.get(activeFile) : undefined;
      if (!answer) {
        vscode.window.showInformationMessage("No CSS Blast Radius data for this file yet.");
        return;
      }
      showDrilldownPanel(context, answer, selector);
    }),
    vscode.commands.registerCommand("cssBlastRadius.restartDaemon", async () => {
      lifecycle?.dispose();
      lifecycle = new DaemonLifecycle(folder.uri.fsPath, siteRoot);
      await lifecycle.start();
    }),
    vscode.commands.registerCommand("cssBlastRadius.verifyExactly", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !isCssDoc(doc)) return;
      vscode.window.showInformationMessage("CSS Blast Radius: verify-exactly requested (re-analyzing full corpus).");
      try {
        const answer = await lifecycle!.client.call<ImpactAnswer>("document/change", {
          path: doc.uri.fsPath,
          content: doc.getText(),
        });
        store.set(answer);
      } catch (err: any) {
        vscode.window.showErrorMessage(`CSS Blast Radius: verify failed: ${err?.message ?? err}`);
      }
    }),
  );
}

export function deactivate() {
  lifecycle?.dispose();
}
