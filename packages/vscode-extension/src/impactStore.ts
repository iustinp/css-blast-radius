// Latest-impact-per-file cache shared by the CodeLens/hover/diagnostics
// providers and the drilldown webview. Also owns supersede semantics: a
// result with a lower epoch than what's already stored for a file is
// dropped (see architecture doc "epoch bump ... never show stale results
// out of order").

import * as vscode from "vscode";
import type { ImpactAnswer } from "./answerContract.js";

export class ImpactStore {
  private byFile = new Map<string, ImpactAnswer>();
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidUpdate = this.emitter.event;

  set(answer: ImpactAnswer): void {
    const existing = this.byFile.get(answer.file);
    if (existing && existing.epoch > answer.epoch) return; // superseded, drop
    this.byFile.set(answer.file, answer);
    this.emitter.fire(answer.file);
  }

  get(file: string): ImpactAnswer | undefined {
    return this.byFile.get(file);
  }
}
