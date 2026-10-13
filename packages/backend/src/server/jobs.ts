// The scan queue: one scan at a time. A group rescan re-reads its sitemap
// first (new pages join, pages gone from the sitemap leave), then scans the
// group's pages. Scans are partial (other pages are carried forward) unless
// the site settings changed since the last scan, or it's a "rescan all".

import { Capturer, type CaptureProgress, type CaptureResult } from "../capture/capture.js";
import type { Store } from "../index/store.js";
import type { Groups } from "./groups.js";
import { buildConfig, isConfigured, siteKey, type SiteSettings } from "./settings.js";
import { readSitemap } from "./sitemap.js";

export type JobSpec = { kind: "group"; groupId: string } | { kind: "pages"; urls: string[]; label?: string } | { kind: "all" };

export interface JobState {
  label: string;
  groupId?: string;
  phase: "sitemap" | "capturing";
  done: number;
  total: number;
  queued: number;
}

export interface LastResult {
  id: number;
  groupId?: string;
  message: string;
  ok: boolean;
}

export interface JobHost {
  dataDir: string;
  store: Store;
  groups: Groups;
  settings(): SiteSettings;
  /** Index revisions still in use (not pruned). */
  keepRevisions(): number[];
  /** A scan published a new index revision. */
  published(res: CaptureResult): Promise<void>;
  /** A sitemap re-read changed a group's pages. */
  groupsChanged(): void;
  /** Per-page scan progress (editor notifications). */
  progress(p: CaptureProgress): void;
  /** Something visible changed (state broadcast). */
  changed(): void;
  log(msg: string): void;
}

interface Running extends Omit<JobState, "queued"> {
  spec: JobSpec;
  pending: Set<string>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Capture errors → plain language. */
export function friendlyError(msg: string | undefined): string | undefined {
  if (!msg) return undefined;
  const http = /^HTTP (\d+)/.exec(msg);
  if (http) {
    const names: Record<string, string> = { "401": "Needs a login", "403": "Access denied", "404": "Not found", "410": "Gone", "429": "Too many requests", "500": "Server error", "502": "Bad gateway", "503": "Site unavailable", "504": "Gateway timeout" };
    return `${http[1]} ${names[http[1]] ?? "Error"}`;
  }
  if (/HTTP no response/.test(msg)) return "The page didn't respond";
  const t = /Timeout (\d+)ms/i.exec(msg);
  if (t) return `Timed out after ${Math.round(Number(t[1]) / 1000)} s`;
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return "The site's address couldn't be found";
  if (/ERR_CONNECTION_REFUSED/.test(msg)) return "The site refused the connection";
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(msg)) return "No internet connection";
  if (/ERR_CERT/.test(msg)) return "The site's security certificate isn't valid";
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

export class Jobs {
  private queue: JobSpec[] = [];
  private current?: Running;
  private running = false;
  private resultN = 0;
  lastResult: LastResult | null = null;

  constructor(private readonly host: JobHost) {}

  private same(a: JobSpec, b: JobSpec): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "group" && b.kind === "group") return a.groupId === b.groupId;
    if (a.kind === "pages" && b.kind === "pages") return a.urls.length === b.urls.length && a.urls.every((u, i) => u === b.urls[i]);
    return true;
  }

  enqueue(spec: JobSpec): void {
    if (spec.kind === "pages" && spec.urls.length === 0) return;
    if (this.queue.some((q) => this.same(q, spec))) return;
    this.queue.push(spec);
    this.host.changed();
    void this.pump();
  }

  /** Waits until the queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 50));
  }

  state(): JobState | null {
    const c = this.current;
    if (!c) return this.queue.length ? { label: "Waiting to scan", phase: "capturing", done: 0, total: 0, queued: this.queue.length } : null;
    return { label: c.label, ...(c.groupId ? { groupId: c.groupId } : {}), phase: c.phase, done: c.done, total: c.total, queued: this.queue.length };
  }

  groupJob(id: string): { phase: "queued" | "sitemap" | "capturing"; done: number; total: number } | null {
    const c = this.current;
    if (c && (c.groupId === id || (c.spec.kind === "all" && this.host.groups.find(id)?.active))) return { phase: c.phase, done: c.done, total: c.total };
    if (this.queue.some((q) => (q.kind === "group" && q.groupId === id) || (q.kind === "all" && this.host.groups.find(id)?.active))) return { phase: "queued", done: 0, total: 0 };
    return null;
  }

  isCapturing(url: string): boolean {
    return !!this.current?.pending.has(url);
  }

  private finish(message: string, ok: boolean, groupId?: string): void {
    this.lastResult = { id: ++this.resultN, ...(groupId ? { groupId } : {}), message, ok };
    this.host.log(message);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let spec = this.queue.shift(); spec; spec = this.queue.shift()) {
        try {
          await this.run(spec);
        } catch (err: any) {
          this.finish(`Scan failed: ${friendlyError(String(err?.message ?? err).split("\n")[0])}`, false, spec.kind === "group" ? spec.groupId : undefined);
        } finally {
          this.current = undefined;
          this.host.changed();
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async run(spec: JobSpec): Promise<void> {
    const { groups } = this.host;
    const settings = this.host.settings();
    if (!isConfigured(settings)) {
      this.finish("Set the site's address first, then scan.", false);
      return;
    }
    const notes: string[] = [];
    let label: string;
    let done: string;
    let targets: string[];
    let scanned: string[] = [];
    let groupId: string | undefined;

    const sitemap = async (id: string) => {
      const g = groups.find(id);
      if (!g || g.source.type !== "sitemap") return;
      this.current!.phase = "sitemap";
      this.host.changed();
      const res = await readSitemap(g.source.url, settings, g.source.filter);
      const { added, removed } = groups.setSitemapPages(id, res.urls);
      if (added.length || removed.length) this.host.groupsChanged();
      if (added.length || removed.length) notes.push(`${spec.kind === "all" ? `${g.name} sitemap` : "Sitemap"}: ${added.length} new, ${removed.length} removed.`);
    };

    if (spec.kind === "group") {
      const g = groups.find(spec.groupId);
      if (!g) return; // deleted while waiting
      groupId = g.id;
      label = `Scanning ${g.name}`;
      done = `${g.name} rescanned`;
      this.current = { spec, label, groupId, phase: "capturing", done: 0, total: 0, pending: new Set() };
      try {
        await sitemap(g.id);
      } catch (err: any) {
        this.finish(`${g.name}: couldn't read the sitemap (${err?.message ?? err}).`, false, g.id);
        return;
      }
      targets = groups.find(g.id)?.urls ?? [];
      scanned = [g.id];
    } else if (spec.kind === "all") {
      label = "Scanning all active groups";
      done = "All active groups rescanned";
      this.current = { spec, label, phase: "capturing", done: 0, total: 0, pending: new Set() };
      for (const g of groups.all()) {
        if (!g.active) continue;
        try {
          await sitemap(g.id);
        } catch (err: any) {
          notes.push(`${g.name}: couldn't read the sitemap (${err?.message ?? err}).`);
        }
        scanned.push(g.id);
      }
      targets = [...groups.activeUrls()];
    } else {
      label = spec.label ?? `Scanning ${plural(spec.urls.length, "page")}`;
      done = spec.urls.length === 1 ? `${spec.urls[0]} rescanned` : `${plural(spec.urls.length, "page")} rescanned`;
      this.current = { spec, label, phase: "capturing", done: 0, total: 0, pending: new Set() };
      targets = [...new Set(spec.urls)];
    }

    if (targets.length === 0) {
      this.finish(`${label.replace(/^Scanning /, "")}: no pages to scan.`, true, groupId);
      return;
    }

    const store = this.host.store;
    const key = siteKey(settings);
    const forceFull = spec.kind === "all" || store.getMeta("indexed_site") !== key || !store.currentRevision();
    const all = new Set([...groups.activeUrls(), ...targets]);
    const cfg = buildConfig(settings, this.host.dataDir, [...all]);
    const c = this.current!;
    c.phase = "capturing";
    c.pending = new Set(forceFull ? all : targets);
    c.total = c.pending.size;
    c.done = 0;
    this.host.changed();
    const res = await new Capturer(cfg, store).run({
      urls: forceFull ? undefined : targets,
      keep: this.host.keepRevisions(),
      onProgress: (p) => {
        c.done = p.done;
        c.total = p.total;
        c.pending.delete(p.url);
        this.host.progress(p);
        this.host.changed();
      },
    });
    store.setMeta("indexed_site", key);
    const at = new Date().toISOString();
    for (const id of scanned) groups.scanned(id, at);
    await this.host.published(res);
    const failed = res.failed ? `, ${res.failed} failed` : "";
    this.finish(`${done}: ${plural(res.captured, "page")}${failed}.${notes.length ? ` ${notes.join(" ")}` : ""}`, res.failed === 0, groupId);
  }
}
