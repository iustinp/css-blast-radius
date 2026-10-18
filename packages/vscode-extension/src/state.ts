// Latest answers, ordered so an older answer never replaces a newer one (§6.8).

import * as vscode from "vscode";
import type { FileAnswer, IndexStatus, RulesResult, SessionTotal, WatchStatus } from "./protocol";

const rev = (n: number | null | undefined) => n ?? -1;

export class ImpactState implements vscode.Disposable {
  readonly answers = new Map<string, FileAnswer>();
  readonly rules = new Map<string, RulesResult>();
  session?: SessionTotal;
  status?: IndexStatus;
  degraded?: string;
  /** Whether the server keeps the scan equal to the site. */
  watch?: WatchStatus;

  private readonly fileEmitter = new vscode.EventEmitter<string>();
  private readonly sessionEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<void>();
  private readonly rulesEmitter = new vscode.EventEmitter<string | undefined>();
  private readonly watchEmitter = new vscode.EventEmitter<void>();
  readonly onWatch = this.watchEmitter.event;
  readonly onFile = this.fileEmitter.event;
  readonly onSession = this.sessionEmitter.event;
  readonly onStatus = this.statusEmitter.event;
  /** CodeLens should re-query (a file, or all when undefined). */
  readonly onRulesInvalidated = this.rulesEmitter.event;

  acceptAnswer(a: FileAnswer): boolean {
    const prev = this.answers.get(a.file);
    if (prev) {
      if (rev(a.indexRevision) < rev(prev.indexRevision)) return false;
      if (a.indexRevision === prev.indexRevision) {
        if (a.editRevision < prev.editRevision) return false;
        if (a.editRevision === prev.editRevision && a.level < prev.level) return false;
      }
    }
    this.answers.set(a.file, a);
    this.fileEmitter.fire(a.file);
    return true;
  }

  acceptSession(s: SessionTotal): boolean {
    const prev = this.session;
    if (prev && rev(s.indexRevision) === rev(prev.indexRevision) && s.editRevision < prev.editRevision) return false;
    if (prev && rev(s.indexRevision) < rev(prev.indexRevision)) return false;
    this.session = s;
    this.sessionEmitter.fire();
    return true;
  }

  acceptRules(r: RulesResult): boolean {
    const prev = this.rules.get(r.file);
    if (prev) {
      if (rev(r.indexRevision) < rev(prev.indexRevision)) return false;
      if (rev(r.indexRevision) === rev(prev.indexRevision) && r.editRevision < prev.editRevision) return false;
      if (rev(r.indexRevision) === rev(prev.indexRevision) && r.editRevision === prev.editRevision && r.level < prev.level) return false;
    }
    this.rules.set(r.file, r);
    return true;
  }

  invalidateRules(path?: string): void {
    this.rulesEmitter.fire(path);
  }

  setStatus(s: IndexStatus): void {
    this.status = s;
    this.statusEmitter.fire();
  }

  setWatch(w: WatchStatus | undefined): void {
    this.watch = w;
    this.watchEmitter.fire();
  }

  setDegraded(msg: string | undefined): void {
    this.degraded = msg;
    this.statusEmitter.fire();
  }

  forget(path: string): void {
    this.answers.delete(path);
    this.rules.delete(path);
    this.fileEmitter.fire(path);
  }

  /** A new daemon restarts revisions from zero: drop everything. */
  reset(): void {
    const files = [...this.answers.keys()];
    this.answers.clear();
    this.rules.clear();
    this.session = undefined;
    this.degraded = undefined;
    for (const f of files) this.fileEmitter.fire(f);
    this.sessionEmitter.fire();
    this.rulesEmitter.fire(undefined);
  }

  dispose(): void {
    this.fileEmitter.dispose();
    this.sessionEmitter.dispose();
    this.statusEmitter.dispose();
    this.rulesEmitter.dispose();
    this.watchEmitter.dispose();
  }
}
