// Editor → daemon document events (§6.1, §12). Keystrokes are sent as
// incremental ranges; while a request is in flight, new edits are coalesced
// into the next one, so there is no fixed debounce and no queue build-up.

import * as path from "node:path";
import * as vscode from "vscode";
import { RpcCallError, type DaemonClient } from "./daemonClient";
import { ERR, type Count, type DocResult, type SessionTotal } from "./protocol";
import { sameCount } from "./format";
import type { ImpactState } from "./state";

interface TextChange {
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  text: string;
}

interface Tracked {
  doc: vscode.TextDocument;
  /** Version as the daemon knows it (independent of the editor's version). */
  version: number;
  queue: TextChange[];
  /** Requests sent and not answered yet (a save can overlap a change). */
  inFlight: number;
  opening?: Promise<void>;
  idle: Array<() => void>;
  savedAt?: number;
  /** Unsaved edits, as of the last event. */
  dirty: boolean;
  /** Reloaded from disk (changed outside the editor), and the session's total just before. */
  reloaded?: boolean;
  reloadFrom?: Count;
}

/** A CSS file inside the project (the first workspace folder): files from elsewhere would be matched by name and miscounted. */
export function isCssDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file" || !(doc.languageId === "css" || doc.uri.fsPath.toLowerCase().endsWith(".css"))) return false;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return false;
  const rel = path.relative(root, doc.uri.fsPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export class DocumentSync implements vscode.Disposable {
  private readonly docs = new Map<string, Tracked>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly client: DaemonClient,
    private readonly state: ImpactState,
    private readonly log: (msg: string) => void,
    private readonly onReload: (path: string, session: SessionTotal, before?: Count) => void,
  ) {
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.open(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.change(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.save(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.close(d)),
    );
  }

  /** (Re)open every CSS document: called after each (re)connect. */
  async openAll(): Promise<void> {
    this.docs.clear();
    await Promise.all(vscode.workspace.textDocuments.filter(isCssDocument).map((d) => this.open(d)));
  }

  isTracked(path: string): boolean {
    return this.docs.has(path);
  }

  /** The file's own document: git's copy and the live copy behind the change bars share its path, not its URI. */
  private tracked(doc: vscode.TextDocument): Tracked | undefined {
    const t = this.docs.get(doc.uri.fsPath);
    return t && t.doc.uri.toString() === doc.uri.toString() ? t : undefined;
  }

  /** Resolves once every edit made so far has been answered. */
  whenSynced(path: string): Promise<void> {
    const t = this.docs.get(path);
    if (!t || (t.inFlight === 0 && !t.queue.length && !t.opening)) return Promise.resolve();
    return new Promise((r) => t.idle.push(r));
  }

  private accept(r: DocResult): void {
    this.state.acceptAnswer(r.answer);
    this.state.acceptSession(r.session);
    const tracked = this.docs.get(r.answer.file);
    if (tracked?.reloaded) {
      const before = tracked.reloadFrom;
      tracked.reloaded = false;
      tracked.reloadFrom = undefined;
      if (!before || !sameCount(before, r.session.total)) this.onReload(r.answer.file, this.state.session ?? r.session, before);
    }
  }

  private open(doc: vscode.TextDocument): Promise<void> {
    if (!isCssDocument(doc) || !this.client.connected) return Promise.resolve();
    const path = doc.uri.fsPath;
    const t: Tracked = this.docs.get(path) ?? { doc, version: 0, queue: [], inFlight: 0, idle: [], dirty: doc.isDirty };
    t.doc = doc;
    t.dirty = doc.isDirty;
    t.reloaded = false;
    this.docs.set(path, t);
    t.queue = [];
    t.version = 1;
    const opening = this.client
      .call<DocResult>("document/open", { path, text: doc.getText(), version: t.version })
      .then((r) => this.accept(r))
      .catch((err) => this.log(`document/open ${path}: ${err?.message ?? err}`))
      .finally(() => {
        if (t.opening === opening) t.opening = undefined;
        this.flush(t);
      });
    t.opening = opening;
    return opening;
  }

  private change(e: vscode.TextDocumentChangeEvent): void {
    const t = this.tracked(e.document);
    if (!t || e.contentChanges.length === 0) return;
    // Clean before and after: reloaded from disk. Not an undo back to the saved text (dirty before).
    const wasDirty = t.dirty;
    t.dirty = e.document.isDirty;
    if (!wasDirty && !t.dirty && Date.now() - (t.savedAt ?? 0) > 1000 && !t.reloaded) {
      t.reloaded = true;
      t.reloadFrom = this.state.session?.total;
    }
    for (const c of e.contentChanges) {
      t.queue.push({
        range: {
          start: { line: c.range.start.line, character: c.range.start.character },
          end: { line: c.range.end.line, character: c.range.end.character },
        },
        text: c.text,
      });
    }
    this.flush(t);
  }

  private flush(t: Tracked, force = false): void {
    if (t.opening || (t.inFlight > 0 && !force)) return;
    if (!t.queue.length) {
      if (t.inFlight === 0) for (const r of t.idle.splice(0)) r();
      return;
    }
    const changes = t.queue;
    t.queue = [];
    t.version++;
    t.inFlight++;
    const path = t.doc.uri.fsPath;
    this.client
      .call<DocResult>("document/change", { path, version: t.version, changes })
      .then((r) => this.accept(r))
      .catch((err) => {
        if (err instanceof RpcCallError && (err.code === ERR.resync || err.code === ERR.unknownDocument)) {
          this.log(`resync ${path} (${err.message})`);
          void this.open(t.doc);
        } else this.log(`document/change ${path}: ${err?.message ?? err}`);
      })
      .finally(() => {
        t.inFlight--;
        this.flush(t);
      });
  }

  private async save(doc: vscode.TextDocument): Promise<void> {
    const t = this.tracked(doc);
    if (!t) return;
    t.savedAt = Date.now();
    t.dirty = false;
    t.reloaded = false;
    while (t.opening) await t.opening;
    // Edits made before the save must reach the daemon first; the daemon
    // handles document events strictly in arrival order.
    this.flush(t, true);
    t.inFlight++;
    this.client
      .call<DocResult>("document/save", { path: doc.uri.fsPath })
      .then((r) => this.accept(r))
      .catch((err) => this.log(`document/save: ${err?.message ?? err}`))
      .finally(() => {
        t.inFlight--;
        this.flush(t);
      });
  }

  private close(doc: vscode.TextDocument): void {
    const path = doc.uri.fsPath;
    const t = this.tracked(doc);
    if (!t) return;
    this.docs.delete(path);
    for (const r of t.idle.splice(0)) r();
    this.state.forget(path);
    this.client
      .call<SessionTotal>("document/close", { path })
      .then((s) => this.state.acceptSession(s))
      .catch(() => {});
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
