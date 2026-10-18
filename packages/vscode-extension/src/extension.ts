// Workspace editor session on the shared CSS Blast Radius server.

import * as vscode from "vscode";
import * as path from "node:path";
import { RpcCallError } from "./daemonClient";
import { DaemonLifecycle } from "./daemonLifecycle";
import { DocumentSync, isCssDocument } from "./documentSync";
import { DiffTab } from "./diffTab";
import { EditorSurfaces } from "./editorSurfaces";
import { ExternalNoticeBatch } from "./externalNotice";
import { LiveEdits } from "./liveEdits";
import { changeAtCursor, configuredBase, editSides, effectiveBase, externalChangeText, TABS } from "./format";
import { PagesPanel } from "./panel";
import type { CaptureProgressParams, Count, DiffBaseKind, FileAnswer, GroupInfo, IndexStatus, PagesTarget, RefinedParams, SessionTotal, WatchStatus } from "./protocol";
import { ImpactState } from "./state";
import { serverOrigin } from "./urls";

export function activate(ctx: vscode.ExtensionContext): void {
  // Multi-root workspaces: the first folder only (v1).
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    const watcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!vscode.workspace.workspaceFolders?.length) return;
      watcher.dispose();
      activate(ctx);
    });
    ctx.subscriptions.push(watcher);
    return;
  }
  const folderUri = folder.uri;

  const life = new DaemonLifecycle(folderUri.fsPath);
  const client = life.client;
  const state = new ImpactState();
  const log = (m: string) => life.output.appendLine(m);
  const notices = new ExternalNoticeBatch();
  let noticeTimer: NodeJS.Timeout | undefined;
  let captureUi: { report(p: CaptureProgressParams): void; done(): void } | undefined;

  function flushNotices(): void {
    clearTimeout(noticeTimer);
    const notice = notices.take(Date.now());
    if (notice) {
      void vscode.window.showInformationMessage(
        externalChangeText(notice.files.length, notice.session.total, notice.before),
        "Show pages", "Dismiss",
      ).then((choice) => { if (choice === "Show pages") void vscode.commands.executeCommand("cssBlastRadius.showAllPages"); });
    } else if (notices.waiting) noticeTimer = setTimeout(flushNotices, notices.delay(Date.now()));
  }

  function externalChange(files: string[], session: SessionTotal, before?: Count): void {
    state.acceptSession(session);
    if (!files.length) return;
    notices.add(files, state.session ?? session, before);
    flushNotices();
  }

  const sync = new DocumentSync(client, state, log, (file, session, before) => externalChange([file], session, before));
  const surfaces = new EditorSurfaces(client, life, state, sync);
  const live = new LiveEdits(client, life, state, folderUri, ctx.extensionUri, log);
  ctx.subscriptions.push(life, state, sync, surfaces, live, { dispose: () => { clearTimeout(noticeTimer); notices.clear(); } });

  async function refreshScope(): Promise<void> {
    try {
      state.setStatus(await client.call<IndexStatus>("index/getStatus"));
    } catch (err: any) {
      log(`group status: ${err?.message ?? err}`);
    }
  }

  async function refreshAnswers(): Promise<void> {
    await Promise.all(vscode.workspace.textDocuments.filter(isCssDocument).map(async (doc) => {
      try {
        state.acceptAnswer(await client.call<FileAnswer>("analysis/queryImpacts", { path: doc.uri.fsPath, scope: "file" }));
      } catch (err: any) {
        log(`Page count for ${doc.uri.fsPath}: ${err?.message ?? err}`);
      }
    }));
  }

  // The panel's tab: what this window compares your CSS with. It starts at the setting's tab and
  // stays across reconnects; the server applies one per project (windows on one project share it).
  const settingBase = () => configuredBase(vscode.workspace.getConfiguration("cssBlastRadius", folderUri).get("diffBase"));
  let tab: { base: DiffBaseKind; mainChanges: boolean } = { base: settingBase(), mainChanges: false };

  async function applyTab(refresh = true, git = state.status?.git): Promise<void> {
    if (!client.connected) return;
    const base = effectiveBase(tab.base, git);
    state.acceptSession(await client.call<SessionTotal>("session/setDiffBase", { base, mainChanges: tab.mainChanges }, 120_000));
    await refreshScope();
    if (refresh) await refreshAnswers();
  }

  async function switchTab(next: { base: DiffBaseKind; mainChanges?: boolean }): Promise<void> {
    tab = { base: next.base, mainChanges: next.mainChanges ?? tab.mainChanges };
    try {
      await applyTab();
    } catch (err: any) {
      void vscode.window.showErrorMessage(`Couldn't change what your edits are compared with: ${err?.message ?? err}`);
    }
  }

  async function setGroups(): Promise<void> {
    if (!client.connected) return;
    const groups = vscode.workspace.getConfiguration("cssBlastRadius", folderUri).get<string[]>("groups") ?? [];
    try {
      state.acceptSession(await client.call<SessionTotal>("session/setGroups", { groups }));
      await refreshScope();
      await refreshAnswers();
    } catch (err: any) {
      log(`linking groups: ${err?.message ?? err}`);
    }
  }

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
      case "analysis/externalChange": {
        const change = p as { files: string[]; session: SessionTotal; before?: Count };
        externalChange(change.files, change.session, change.before);
        return;
      }
      case "scan/watch":
        state.setWatch(p as WatchStatus);
        return;
      case "groups/changed":
        if (life.init) life.init.groups = (p as { groups: GroupInfo[] }).groups;
        void setGroups();
        return;
      case "index/statusChanged": {
        const s = p as IndexStatus;
        state.setStatus(s);
        if (captureUi && !s.capture?.running) {
          captureUi.done();
          captureUi = undefined;
          if (s.capture?.error) void vscode.window.showErrorMessage(`Scan failed: ${s.capture.error}`);
        }
        return;
      }
      case "index/revisionSwitched":
        log(`page scan updated`);
        state.invalidateRules(undefined);
        captureUi?.done();
        captureUi = undefined;
        void refreshScope();
        void refreshAnswers();
        return;
      case "index/captureProgress": {
        const pr = p as CaptureProgressParams;
        if (!pr.ok) log(`Page scan failed: ${pr.url}`);
        captureUi?.report(pr);
        return;
      }
      case "server/degraded": {
        const msg = (p as { message: string }).message;
        log(`Server needs attention: ${msg}`);
        state.setDegraded(msg);
      }
    }
  });

  life.onAttached(async (init) => {
    log(`Connected: ${init.serviceVersion}, ${init.status.pages} pages scanned`);
    state.reset();
    notices.clear();
    state.setStatus(init.status);
    state.setWatch(init.watch);
    try {
      await applyTab(false, init.status.git);
    } catch (err: any) {
      log(`Comparison base: ${err?.message ?? err}`);
    }
    // A new "This session": what the editor holds now, saved or not, is where it starts.
    await sync.openAll(init.sessionStarted === true);
    try {
      state.acceptSession(await client.call<SessionTotal>("analysis/queryImpacts", { scope: "session" }));
    } catch (err: any) {
      if (!(err instanceof RpcCallError)) log(`Page count: ${err?.message ?? err}`);
    }
    state.invalidateRules(undefined);
    if (!init.status.scope?.linked && !ctx.workspaceState.get<boolean>("promptedGroups")) {
      await ctx.workspaceState.update("promptedGroups", true);
      const pick = await vscode.window.showInformationMessage(
        "Link page groups to this project to see which pages your CSS edits affect.",
        "Link page groups", "Open setup page",
      );
      if (pick === "Link page groups") void vscode.commands.executeCommand("cssBlastRadius.linkGroups");
      if (pick === "Open setup page") void vscode.commands.executeCommand("cssBlastRadius.openSetupPage");
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
    void vscode.window.showWarningMessage(
      `CSS Blast Radius server is offline. ${life.stateDetail}`, "Reconnect to Server", "Show Output",
    ).then((choice) => {
      if (choice === "Reconnect to Server") void life.reconnect();
      if (choice === "Show Output") life.output.show();
    });
    return false;
  };

  const cursorTarget = (): PagesTarget => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isCssDocument(ed.document)) return { title: "All edits" };
    const file = ed.document.uri.fsPath;
    const a = state.answers.get(file);
    const r = state.rules.get(file);
    const rules = a && r?.editRevision === a.editRevision && r.indexRevision === a.indexRevision ? r.rules : [];
    const ch = a && changeAtCursor(a.changes, rules, ed.selection.active.line + 1);
    if (!ch) return { title: "All edits" };
    const sides = editSides(ch);
    return { path: file, changeId: ch.id, sides: sides.length > 1 ? sides : undefined, title: ch.selector || `Edit on line ${ch.line}` };
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("cssBlastRadius.showPages", (target?: PagesTarget) => {
      if (!requireConnected()) return;
      PagesPanel.show(ctx, client, life, state, target && typeof target === "object" && "title" in target ? target : cursorTarget());
    }),
    vscode.commands.registerCommand("cssBlastRadius.showAllPages", () => {
      if (requireConnected()) PagesPanel.show(ctx, client, life, state, { title: "All edits" });
    }),
    vscode.commands.registerCommand("cssBlastRadius.togglePanel", () => {
      if (requireConnected()) PagesPanel.toggle(ctx, client, life, state);
    }),
    vscode.commands.registerCommand("cssBlastRadius.openDiffInBrowser", () => DiffTab.openInBrowser()),
    vscode.commands.registerCommand("cssBlastRadius.linkGroups", async () => {
      if (!requireConnected()) return;
      try {
        const groups = await client.call<GroupInfo[]>("groups/list");
        const linked = new Set(vscode.workspace.getConfiguration("cssBlastRadius", folderUri).get<string[]>("groups") ?? []);
        const setup = { label: "$(link-external) Open setup page", description: "Add or manage groups", id: "" };
        const picks = await vscode.window.showQuickPick(
          [...groups.map((g) => ({
            label: g.name,
            description: g.active ? `${g.pages.toLocaleString("en-US")} pages` : "paused",
            picked: linked.has(g.id), id: g.id,
          })), setup],
          { title: "Link page groups to this project", placeHolder: "Choose the groups whose pages your CSS edits may affect", canPickMany: true },
        );
        if (!picks) return;
        if (picks.some((p) => !p.id)) void vscode.commands.executeCommand("cssBlastRadius.openSetupPage");
        const selected = picks.filter((p) => !!p.id).map((p) => p.id);
        if (selected.length || !picks.some((p) => !p.id)) {
          await vscode.workspace.getConfiguration("cssBlastRadius", folderUri).update("groups", selected, vscode.ConfigurationTarget.Workspace);
        }
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Couldn't load page groups: ${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand("cssBlastRadius.openSetupPage", async () => {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(serverOrigin(life.serverUrl).toString()));
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Couldn't open the setup page: ${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand("cssBlastRadius.rescanGroups", async () => {
      if (!requireConnected()) return;
      if (state.status?.capture?.running) return void vscode.window.showInformationMessage("A scan is already running.");
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "CSS Blast Radius: scanning linked groups", cancellable: false },
        (progress) => new Promise<void>((resolve) => {
          let pct = 0;
          captureUi = {
            report: (p) => {
              const next = p.total ? (p.done / p.total) * 100 : 0;
              progress.report({ increment: Math.max(next - pct, 0), message: `${p.done}/${p.total} pages` });
              pct = Math.max(pct, next);
            },
            done: resolve,
          };
          client.call("index/capture", {}).catch((err: any) => {
            captureUi = undefined;
            resolve();
            void vscode.window.showErrorMessage(`Couldn't start the scan: ${err?.message ?? err}`);
          });
        }),
      );
    }),
    vscode.commands.registerCommand("cssBlastRadius.setDiffBase", async (arg?: { base?: DiffBaseKind; mainChanges?: boolean }) => {
      if (!requireConnected()) return;
      if (arg?.base && TABS.some((t) => t.base === arg.base)) return switchTab({ base: arg.base, mainChanges: arg.mainChanges });
      const git = state.status?.git;
      const pick = await vscode.window.showQuickPick(
        TABS.filter((t) => effectiveBase(t.base, git) === t.base).map((t) => ({
          label: t.name, detail: t.tip, description: t.base === effectiveBase(tab.base, git) ? "current" : undefined, base: t.base,
        })),
        { title: "Which changes should CSS Blast Radius show?" },
      );
      if (pick) await switchTab({ base: pick.base });
    }),
    vscode.commands.registerCommand("cssBlastRadius.reconnectServer", () => life.reconnect()),
    vscode.commands.registerCommand("cssBlastRadius.showOutput", () => life.output.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cssBlastRadius.codeLens")) state.invalidateRules(undefined);
      if (e.affectsConfiguration("cssBlastRadius.groups")) void setGroups();
      if (e.affectsConfiguration("cssBlastRadius.diffBase")) void switchTab({ base: settingBase() });
      if (["server", "autoStartServer", "serverPath", "daemonPath", "nodePath"].some((k) => e.affectsConfiguration(`cssBlastRadius.${k}`))) {
        void life.reconnect();
      }
    }),
  );

  void life.start();
}

export function deactivate(): void {}
