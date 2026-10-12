// CSS Blast Radius for VS Code: wires the daemon, document sync, editor
// surfaces and the page panel together (§7, §10.4).

import * as vscode from "vscode";
import * as path from "node:path";
import { RpcCallError } from "./daemonClient";
import { DaemonLifecycle } from "./daemonLifecycle";
import { DocumentSync, isCssDocument } from "./documentSync";
import { EditorSurfaces } from "./editorSurfaces";
import { DIFF_BASE_LABEL } from "./format";
import { PagesPanel } from "./panel";
import type { CaptureProgressParams, DiffBaseKind, IndexStatus, PagesTarget, RefinedParams, SessionTotal } from "./protocol";
import { ImpactState } from "./state";

const RESTART_SETTINGS = ["siteRoot", "baseUrl", "dataDir", "daemonPath", "nodePath", "diffBase"];

export function activate(ctx: vscode.ExtensionContext): void {
  // Multi-root workspaces: the first folder only (v1).
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const life = new DaemonLifecycle(folder.uri.fsPath);
  const client = life.client;
  const state = new ImpactState();
  const log = (m: string) => life.output.appendLine(m);
  const sync = new DocumentSync(client, state, log);
  const surfaces = new EditorSurfaces(client, life, state, sync);
  ctx.subscriptions.push(life, state, sync, surfaces);

  let captureUi: { report(p: CaptureProgressParams): void; done(): void } | undefined;

  client.onNotification((method, p) => {
    switch (method) {
      case "analysis/refined": {
        const r = p as RefinedParams;
        state.acceptAnswer(r.answer);
        state.acceptSession(r.session);
        if (r.rules) state.invalidateRules(r.answer.file);
        return;
      }
      case "analysis/publishImpact":
        state.acceptSession((p as { session: SessionTotal }).session);
        return;
      case "index/statusChanged": {
        const s = p as IndexStatus;
        state.setStatus(s);
        if (captureUi && !s.capture?.running) {
          captureUi.done();
          captureUi = undefined;
          if (s.capture?.error) void vscode.window.showErrorMessage(`Capture failed: ${s.capture.error}`);
          else void vscode.window.showInformationMessage(`Captured ${s.okPages.toLocaleString("en-US")} pages${s.failedPages ? ` (${s.failedPages} failed)` : ""}.`);
        }
        return;
      }
      case "index/revisionSwitched":
        log(`index revision ${(p as { indexRevision: number | null }).indexRevision}`);
        state.invalidateRules(undefined);
        return;
      case "index/captureProgress": {
        const pr = p as CaptureProgressParams;
        if (!pr.ok) log(`capture failed: ${pr.url}`);
        captureUi?.report(pr);
        const st = state.status;
        if (st?.capture) {
          st.capture.done = pr.done;
          st.capture.total = pr.total;
          state.setStatus(st);
        }
        return;
      }
      case "server/degraded": {
        const msg = (p as { message: string }).message;
        log(`degraded: ${msg}`);
        state.setDegraded(msg);
        return;
      }
    }
  });

  life.onAttached(async (init) => {
    log(`attached: daemon ${init.serviceVersion}, ${init.status.pages} pages indexed`);
    state.reset();
    state.setStatus(init.status);
    await sync.openAll();
    try {
      state.acceptSession(await client.call<SessionTotal>("analysis/queryImpacts", { scope: "session" }));
    } catch (err: any) {
      if (!(err instanceof RpcCallError)) log(`session: ${err?.message ?? err}`);
    }
    state.invalidateRules(undefined);
    if (!init.status.ready && !init.status.capture?.running) {
      const pick = await vscode.window.showInformationMessage(
        "CSS Blast Radius hasn't captured this site yet. Capture it now? (It runs in the background.)",
        "Capture site",
      );
      if (pick) void vscode.commands.executeCommand("cssBlastRadius.captureSite");
    }
  });

  life.onState((s) => {
    if ((s === "DISCONNECTED" || s === "FAILED") && captureUi) {
      captureUi.done();
      captureUi = undefined;
    }
  });

  const requireConnected = (): boolean => {
    if (client.connected) return true;
    void vscode.window.showWarningMessage(`CSS Blast Radius isn't connected to its daemon. ${life.stateDetail}`, "Show output").then((x) => x && life.output.show());
    return false;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("cssBlastRadius.showPages", (target?: PagesTarget) => {
      if (!requireConnected()) return;
      PagesPanel.show(ctx, client, state, target && typeof target === "object" && "title" in target ? target : { title: "Your edits" });
    }),

    vscode.commands.registerCommand("cssBlastRadius.showFilePages", (uri?: vscode.Uri) => {
      if (!requireConnected()) return;
      const doc = uri ? undefined : vscode.window.activeTextEditor?.document;
      const file = uri?.fsPath ?? (doc && isCssDocument(doc) ? doc.uri.fsPath : undefined);
      if (!file) return void vscode.window.showInformationMessage("Open a CSS file first.");
      PagesPanel.show(ctx, client, state, { path: file, title: path.basename(file) });
    }),

    vscode.commands.registerCommand("cssBlastRadius.captureSite", async () => {
      if (!requireConnected()) return;
      if (state.status?.capture?.running) return void vscode.window.showInformationMessage("A capture is already running.");
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "CSS Blast Radius: capturing the site", cancellable: false },
        (progress) =>
          new Promise<void>((resolve) => {
            let pct = 0;
            captureUi = {
              report: (p) => {
                const next = p.total ? (p.done / p.total) * 100 : 0;
                progress.report({ increment: Math.max(next - pct, 0), message: `${p.done}/${p.total}` });
                pct = Math.max(pct, next);
              },
              done: resolve,
            };
            client.call("index/capture", {}).catch((err: any) => {
              captureUi = undefined;
              resolve();
              void vscode.window.showErrorMessage(`Couldn't start the capture: ${err?.message ?? err}`);
            });
          }),
      );
    }),

    vscode.commands.registerCommand("cssBlastRadius.setDiffBase", async () => {
      if (!requireConnected()) return;
      const bases: DiffBaseKind[] = life.init?.capabilities.diffBases ?? ["HEAD", "saved", "session"];
      const current = state.session?.diffBase ?? state.status?.diffBase;
      const pick = await vscode.window.showQuickPick(
        bases.map((b) => ({ label: DIFF_BASE_LABEL[b] ?? b, description: b === current ? "current" : undefined, base: b })),
        { title: "Compare your CSS edits with…" },
      );
      if (!pick) return;
      try {
        state.acceptSession(await client.call<SessionTotal>("session/setDiffBase", { base: pick.base }, 120_000));
        state.setStatus(await client.call<IndexStatus>("index/getStatus"));
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Couldn't change the diff base: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand("cssBlastRadius.restartDaemon", () => life.restart()),
    vscode.commands.registerCommand("cssBlastRadius.showOutput", () => life.output.show()),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("cssBlastRadius.codeLens")) state.invalidateRules(undefined);
      if (RESTART_SETTINGS.some((k) => e.affectsConfiguration(`cssBlastRadius.${k}`))) {
        const pick = await vscode.window.showInformationMessage("Restart the CSS Blast Radius daemon to apply the new settings?", "Restart");
        if (pick) await life.restart();
      }
    }),
  );

  void life.start();
}

export function deactivate(): void {}
