// Per-connection workspace session: overlay documents (open/unsaved editor
// buffers), the crawled corpus, the external filesystem watcher, and the
// monotonic epoch counter used to drop superseded in-flight results.
//
// File-watching ownership rule (see architecture doc): while a path is
// "overlay-owned" (open in the editor), editor document/* events drive
// analysis and raw FS events for that same path are suppressed unless the
// on-disk content hash disagrees with the last-known overlay hash (external
// overwrite).

import { createHash } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { crawlSite, type Corpus } from "../crawl/crawler.js";
import { analyzeChange } from "./analysis.js";
import type { ImpactAnswer } from "../css/answerContract.js";

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

interface OverlayDoc {
  path: string;
  content: string;
  contentHash: string;
  lastIndexedContent: string;
  dirty: boolean;
  overlayOwned: boolean;
}

export type PublishImpactHandler = (answer: ImpactAnswer) => void;
export type StatusChangedHandler = (status: { state: string; detail?: string }) => void;

export class WorkspaceSession {
  readonly siteRoot: string;
  corpus!: Corpus;
  private overlays = new Map<string, OverlayDoc>();
  private watcher?: FSWatcher;
  private epoch = 0;
  private onPublishImpact?: PublishImpactHandler;
  private onStatusChanged?: StatusChangedHandler;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;

  constructor(siteRoot: string, opts: { debounceMs?: number } = {}) {
    this.siteRoot = path.resolve(siteRoot);
    this.debounceMs = opts.debounceMs ?? 200;
  }

  on(event: "publishImpact", handler: PublishImpactHandler): void;
  on(event: "statusChanged", handler: StatusChangedHandler): void;
  on(event: string, handler: any) {
    if (event === "publishImpact") this.onPublishImpact = handler;
    if (event === "statusChanged") this.onStatusChanged = handler;
  }

  async attach(): Promise<void> {
    this.onStatusChanged?.({ state: "CRAWLING" });
    this.corpus = await crawlSite(this.siteRoot);
    this.onStatusChanged?.({ state: "READY", detail: `${this.corpus.pages.size} pages indexed` });
    this.startWatching();
  }

  private startWatching() {
    this.watcher = chokidar.watch(`${this.siteRoot}/**/*.css`, {
      ignoreInitial: true,
    });
    this.watcher.on("change", (filePath) => this.handleFsChange(filePath));
  }

  private async handleFsChange(filePath: string) {
    const resolved = path.resolve(filePath);
    const overlay = this.overlays.get(resolved);
    if (overlay?.overlayOwned) {
      // Editor owns this path; verify it's not a genuine external overwrite.
      const onDisk = await readFile(resolved, "utf8").catch(() => null);
      if (onDisk !== null && hashOf(onDisk) === overlay.contentHash) return; // duplicate of our own save
    }
    const newText = await readFile(resolved, "utf8").catch(() => null);
    if (newText === null) return;
    this.scheduleAnalysis(resolved, newText, overlay?.lastIndexedContent ?? "");
  }

  private scheduleAnalysis(resolved: string, newText: string, oldText: string) {
    const existing = this.debounceTimers.get(resolved);
    if (existing) clearTimeout(existing);
    const myEpoch = ++this.epoch;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(resolved);
      if (myEpoch !== this.epoch) return; // superseded by a newer edit
      const answer = analyzeChange({
        corpus: this.corpus,
        cssFilePath: resolved,
        oldText,
        newText,
        epoch: myEpoch,
      });
      const overlay = this.overlays.get(resolved) ?? {
        path: resolved,
        content: newText,
        contentHash: hashOf(newText),
        lastIndexedContent: newText,
        dirty: false,
        overlayOwned: false,
      };
      overlay.lastIndexedContent = newText;
      this.overlays.set(resolved, overlay);
      this.onPublishImpact?.(answer);
    }, this.debounceMs);
    this.debounceTimers.set(resolved, timer);
  }

  // --- Editor-driven overlay lifecycle (document/open|change|save|close) ---

  async documentOpen(filePath: string, content: string) {
    const resolved = path.resolve(filePath);
    const onDiskOrEmpty = await readFile(resolved, "utf8").catch(() => content);
    this.overlays.set(resolved, {
      path: resolved,
      content,
      contentHash: hashOf(content),
      lastIndexedContent: onDiskOrEmpty,
      dirty: content !== onDiskOrEmpty,
      overlayOwned: true,
    });
  }

  documentChange(filePath: string, content: string): ImpactAnswer {
    const resolved = path.resolve(filePath);
    const overlay = this.overlays.get(resolved) ?? {
      path: resolved,
      content: "",
      contentHash: "",
      lastIndexedContent: "",
      dirty: false,
      overlayOwned: true,
    };
    const oldText = overlay.lastIndexedContent;
    overlay.content = content;
    overlay.contentHash = hashOf(content);
    overlay.dirty = true;
    overlay.overlayOwned = true;
    this.overlays.set(resolved, overlay);

    const myEpoch = ++this.epoch;
    const answer = analyzeChange({
      corpus: this.corpus,
      cssFilePath: resolved,
      oldText,
      newText: content,
      epoch: myEpoch,
    });
    answer.selectors.forEach((s) => {
      if (s.overlayState === "CLEAN") s.overlayState = "OPEN_BUFFER_OVERLAY";
    });
    return answer;
  }

  documentSave(filePath: string, content: string) {
    const resolved = path.resolve(filePath);
    const overlay = this.overlays.get(resolved);
    if (overlay) {
      overlay.lastIndexedContent = content;
      overlay.dirty = false;
      overlay.contentHash = hashOf(content);
    }
  }

  documentClose(filePath: string) {
    const resolved = path.resolve(filePath);
    const overlay = this.overlays.get(resolved);
    if (overlay) overlay.overlayOwned = false;
  }

  status() {
    return {
      siteRoot: this.siteRoot,
      pageCount: this.corpus?.pages.size ?? 0,
      cssFileCount: this.corpus?.cssFiles.size ?? 0,
      clusterCount: this.corpus?.clusters.size ?? 0,
      builtAt: this.corpus?.builtAt ?? 0,
    };
  }

  async dispose() {
    await this.watcher?.close();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
  }
}
