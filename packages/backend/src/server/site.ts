// One site of the server: its settings, page groups, scan index, scan queue
// and auto-rescan watcher, stored in <data>/sites/<id>/. Page files live in
// the server's shared blob folder (content-addressed, never deleted).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CaptureProgress, CaptureResult } from "../capture/capture.js";
import type { CbrConfig } from "../config.js";
import type { ScopeGroup, Session, SharedResources } from "../daemon/session.js";
import { SiteIndex } from "../index/siteIndex.js";
import { Store, type PageRow } from "../index/store.js";
import type { L1Pool } from "../l1/pool.js";
import { Renderer } from "../l2/render.js";
import type { GroupInfo, WatchStatus } from "../rpc/protocol.js";
import { Groups, type Group } from "./groups.js";
import { friendlyError, Jobs } from "./jobs.js";
import { buildConfig, isConfigured, loadSettings, pagePath, saveSettings, siteKey, UserError, validateSettings, watchSettings, type SiteSettings } from "./settings.js";
import { readSitemap } from "./sitemap.js";
import { Watcher } from "./watch.js";

export type PageStatus = "ok" | "failed" | "new" | "capturing" | "excluded";

/** A project as a site sees it: its linked groups (from any site) and its session on this site. */
export interface SiteProject {
  name: string;
  root: string;
  linked: string[];
  session: Session;
}

export interface SiteHost {
  pool: L1Pool;
  blobDir: string;
  /** Projects with a session on this site, most recently opened last. */
  projects(site: Site): SiteProject[];
  /** Every project's folder, most recently opened first (the watcher looks for the site's repository). */
  projectRoots(): string[];
  /** The site's groups changed: editors get the new list. */
  groupsChanged(site: Site): void;
  progress(site: Site, p: CaptureProgress): void;
  watchChanged(site: Site, status: WatchStatus): void;
  /** Something visible changed (state broadcast). */
  changed(): void;
  log(msg: string): void;
  /** The full state, returned by routes that change it. */
  state(): unknown;
}

export function newSiteId(): string {
  return randomBytes(4).toString("hex");
}

/** The site's label: its host name, or its folder's name. */
export function siteName(s: SiteSettings): string {
  if (s.siteUrl) {
    try {
      return new URL(s.siteUrl).hostname.replace(/^www\./, "");
    } catch {
      return s.siteUrl;
    }
  }
  return s.siteFolder ? basename(s.siteFolder) : "New site";
}

export class Site {
  settings: SiteSettings;
  readonly groups: Groups;
  readonly store: Store;
  readonly jobs: Jobs;
  readonly watcher: Watcher;
  readonly shared: SharedResources;
  private cfg: CbrConfig;
  private renderer?: Renderer;
  private loaded?: { rev: number; index?: SiteIndex };
  private disk = { at: 0, bytes: 0 };
  private readonly purge: NodeJS.Timeout;

  constructor(
    readonly id: string,
    readonly dir: string,
    private readonly host: SiteHost,
    opts: { watch?: boolean; settings?: SiteSettings } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    if (opts.settings) saveSettings(dir, opts.settings);
    this.settings = opts.settings ?? loadSettings(dir);
    this.groups = new Groups(dir);
    this.store = new Store(dir, host.blobDir);
    this.cfg = buildConfig(this.settings, dir);
    this.shared = {
      cfg: this.cfg,
      store: this.store,
      pool: host.pool,
      renderer: () => (this.renderer ??= new Renderer(this.cfg, this.store)),
      index: () => this.index(),
    };
    this.jobs = new Jobs({
      dataDir: dir,
      store: this.store,
      groups: this.groups,
      settings: () => this.settings,
      keepRevisions: () => host.projects(this).map((p) => p.session.index?.revision.id).filter((r): r is number => r !== undefined),
      published: (res) => this.published(res),
      groupsChanged: () => this.groupsChanged(),
      progress: (p) => host.progress(this, p),
      changed: () => host.changed(),
      log: (m) => host.log(`[${this.name}] ${m}`),
    });
    this.watcher = new Watcher({
      store: this.store,
      pool: host.pool,
      jobs: this.jobs,
      index: () => this.index(),
      settings: () => this.settings,
      config: () => this.cfg,
      projectRoots: () => {
        // Projects linked to this site first: the site's repository is most likely among them.
        const mine = host.projects(this).map((p) => p.root).reverse();
        return [...new Set([...mine, ...host.projectRoots()])];
      },
      activeUrls: () => this.groups.activeUrls(),
      groups: () => this.groups.all(),
      addPages: (id, urls) => {
        this.groups.addPages(id, urls);
        this.groupsChanged();
      },
      changed: (status) => {
        host.watchChanged(this, status);
        host.changed();
      },
      log: (m) => host.log(`[${this.name}] ${m}`),
    });
    if (opts.watch !== false) this.watcher.start();
    this.purge = setInterval(() => {
      if (this.groups.purge()) host.changed();
    }, 30_000);
    this.purge.unref();
  }

  get name(): string {
    return siteName(this.settings);
  }

  // ---------------------------------------------------------------- index

  /** The current index, loaded once and shared by every project. */
  index(): SiteIndex | undefined {
    const rev = this.store.currentRevision();
    if (!rev) return undefined;
    if (this.loaded?.rev !== rev.id) this.loaded = { rev: rev.id, index: SiteIndex.load(this.store, rev.id) };
    return this.loaded.index;
  }

  pageRow(url: string): PageRow | undefined {
    const idx = this.index();
    const id = idx?.byUrl.get(url);
    return id === undefined ? undefined : idx!.pages[id];
  }

  private pageStatus(url: string): { status: PageStatus; row?: PageRow } {
    if (this.jobs.isCapturing(url)) return { status: "capturing", row: this.pageRow(url) };
    const row = this.pageRow(url);
    if (!row || row.status === "removed") return { status: "new" };
    return { status: row.status, row };
  }

  private async published(res: CaptureResult): Promise<void> {
    this.index();
    for (const p of this.host.projects(this)) {
      p.session.setScope(this.scopeFor(p.linked));
      await p.session.indexChanged(res);
    }
    this.host.changed();
  }

  // --------------------------------------------------------------- groups

  /** The linked groups (ids from any site) that belong to this site. */
  scopeFor(linked: string[]): ScopeGroup[] {
    return linked.map((id) => this.groups.find(id)).filter((g): g is Group => !!g).map((g) => ({ id: g.id, name: g.name, active: g.active, urls: g.urls }));
  }

  groupInfos(): GroupInfo[] {
    return this.groups.all().map((g) => ({ id: g.id, name: g.name, active: g.active, pages: g.urls.length, site: this.id, siteName: this.name }));
  }

  /** Group membership or names changed: update every project's counts. */
  private groupsChanged(): void {
    for (const p of this.host.projects(this)) p.session.setScope(this.scopeFor(p.linked));
    this.host.groupsChanged(this);
    this.host.changed();
  }

  private summary(g: Group, members?: Map<string, string[]>) {
    let ok = 0;
    let failed = 0;
    let fresh = 0;
    let capturing = 0;
    let shared = 0;
    for (const u of g.urls) {
      const s = this.pageStatus(u).status;
      if (s === "ok") ok++;
      else if (s === "failed") failed++;
      else if (s === "capturing") capturing++;
      else fresh++;
      if ((members?.get(u)?.length ?? 1) > 1) shared++;
    }
    return {
      id: g.id,
      name: g.name,
      active: g.active,
      source: g.source,
      pages: g.urls.length,
      sharedPages: shared,
      ok,
      failed,
      fresh,
      capturing,
      excluded: g.excluded.length,
      scannedAt: g.scannedAt,
      job: this.jobs.groupJob(g.id),
    };
  }

  private membership(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const g of this.groups.all()) {
      for (const u of g.urls) {
        const list = m.get(u);
        if (list) list.push(g.name);
        else m.set(u, [g.name]);
      }
    }
    return m;
  }

  private diskBytes(): number {
    if (Date.now() - this.disk.at < 30_000) return this.disk.bytes;
    this.disk = { at: Date.now(), bytes: folderBytes(this.dir) };
    return this.disk.bytes;
  }

  state() {
    const members = this.membership();
    const all = this.groups.all();
    const active = this.groups.activeUrls();
    const paused = new Set<string>();
    for (const g of all) if (!g.active) for (const u of g.urls) if (!active.has(u)) paused.add(u);
    const idx = this.index();
    const matches = new Map<string, Array<{ project: string; file: string }>>();
    for (const p of this.host.projects(this)) {
      for (const [key, files] of p.session.sheetFiles()) {
        let list = matches.get(key);
        if (!list) matches.set(key, (list = []));
        for (const f of files) list.push({ project: p.name, file: relative(p.root, f).split(sep).join("/") });
      }
    }
    const stylesheets = idx
      ? [...idx.sheets]
          .filter(([key]) => !key.startsWith("inline:"))
          .map(([url, s]) => ({ url, pages: s.pages.count(), sameSite: url.startsWith("/"), matches: matches.get(url) ?? [] }))
          .sort((a, b) => b.pages - a.pages || a.url.localeCompare(b.url))
      : [];
    return {
      id: this.id,
      name: this.name,
      site: this.settings,
      configured: isConfigured(this.settings),
      groups: all.map((g) => this.summary(g, members)),
      totals: {
        pages: active.size,
        activeGroups: all.filter((g) => g.active).length,
        pausedGroups: all.filter((g) => !g.active).length,
        pausedPages: paused.size,
        diskBytes: this.diskBytes(),
      },
      job: this.jobs.state(),
      lastResult: this.jobs.lastResult,
      watch: this.watcher.status,
      stylesheets,
    };
  }

  // ------------------------------------------------------------- settings

  /** Page addresses from the user → site paths (other sites' addresses are skipped). */
  paths(input: unknown[]): string[] {
    const host = this.settings.siteUrl ? new URL(this.settings.siteUrl).hostname.replace(/^www\./, "") : undefined;
    const out = new Set<string>();
    for (const raw of input) {
      const t = String(raw ?? "").trim();
      if (!t) continue;
      if (host && /^https?:\/\//i.test(t)) {
        try {
          if (new URL(t).hostname.replace(/^www\./, "") !== host) continue;
        } catch {
          continue;
        }
      }
      const p = pagePath(t, this.settings);
      if (p) out.add(p);
    }
    return [...out];
  }

  /** The address belongs to this site (a full address on its host). */
  owns(address: string): boolean {
    return !!this.settings.siteUrl && /^https?:\/\//i.test(address) && this.paths([address]).length > 0;
  }

  private requireSite(): void {
    if (!isConfigured(this.settings)) throw new UserError("Set the site's address first.");
  }

  private reconfigure(next: SiteSettings): void {
    this.settings = next;
    saveSettings(this.dir, next);
    this.cfg = buildConfig(next, this.dir);
    this.shared.cfg = this.cfg;
    const old = this.renderer;
    this.renderer = undefined;
    void old?.close();
    for (const p of this.host.projects(this)) p.session.reconfigure(this.cfg);
  }

  /** Scans the active linked groups of this site, or the given pages. */
  capture(linked: string[], urls?: unknown[]): void {
    this.requireSite();
    if (urls?.length) this.jobs.enqueue({ kind: "pages", urls: this.paths(urls) });
    else for (const g of this.scopeFor(linked)) if (g.active) this.jobs.enqueue({ kind: "group", groupId: g.id });
  }

  // ----------------------------------------------------------------- REST

  /** `rest`: the route after /api/sites/<id> (e.g. ["groups", "<gid>", "pages"]). */
  async api(method: string, rest: string[], query: URLSearchParams, body: any): Promise<unknown> {
    const route = `${method} /${rest.map((s, i) => (rest[0] === "groups" && i === 1 ? ":id" : s)).join("/")}`;
    const id = rest[1];
    switch (route) {
      case "PUT /": {
        const next = validateSettings(body);
        if (this.settings.watch) next.watch = this.settings.watch;
        const otherSite = next.siteUrl !== this.settings.siteUrl || next.siteFolder !== this.settings.siteFolder;
        // The setup page has no field for blocked requests: keep the site's ones from settings.json.
        if (next.block === undefined && !otherSite && this.settings.block) next.block = this.settings.block;
        const moved = siteKey(next) !== siteKey(this.settings);
        this.reconfigure(next);
        this.watcher.reset(otherSite);
        this.host.changed();
        return { state: this.host.state(), needsRescan: moved && this.groups.all().length > 0 && !!this.store.currentRevision() };
      }
      case "PUT /watch": {
        const w = watchSettings(this.settings);
        if (body?.enabled !== undefined) w.enabled = body.enabled === true;
        if (body?.newPages !== undefined) w.newPages = body.newPages === true;
        if (body?.intervalSec !== undefined) {
          const n = Number(body.intervalSec);
          if (!Number.isFinite(n)) throw new UserError("The check interval must be a number of seconds.");
          w.intervalSec = n;
        }
        if (body?.repo !== undefined) {
          const repo = String(body.repo ?? "").trim();
          if (repo && (!isAbsolute(repo) || !existsSync(repo) || !statSync(repo).isDirectory())) throw new UserError(`Enter the repository folder's full path (${repo} isn't a folder).`);
          if (repo) w.repo = resolve(repo);
          else delete w.repo;
        }
        this.settings = { ...this.settings, watch: watchSettings({ ...this.settings, watch: w }) };
        saveSettings(this.dir, this.settings);
        this.watcher.reset(false);
        this.host.changed();
        return this.host.state();
      }
      case "POST /watch/check":
        await this.watcher.check();
        return this.host.state();
      case "POST /sitemap/preview": {
        const res = await readSitemap(String(body?.url ?? ""), this.settings, body?.filter ? String(body.filter) : undefined);
        return { total: res.total, urls: res.urls, otherSite: res.otherSite };
      }
      case "POST /groups": {
        this.requireSite();
        let urls: string[];
        if (body?.source?.type === "sitemap") {
          const filter = body.source.filter ? String(body.source.filter) : undefined;
          const res = await readSitemap(String(body.source.url ?? ""), this.settings, filter);
          if (res.total === 0) throw new UserError(res.otherSite ? `The sitemap only lists pages of another site (not ${this.settings.siteUrl}).` : "The sitemap doesn't list any pages.");
          if (res.urls.length === 0) throw new UserError(`None of the sitemap's ${res.total} pages match “${filter}”.`);
          urls = res.urls;
        } else {
          urls = this.paths(Array.isArray(body?.urls) ? body.urls : []);
          if (urls.length === 0) throw new UserError(this.settings.siteUrl ? `Add at least one page address on ${this.settings.siteUrl}.` : "Add at least one page address.");
        }
        const g = this.groups.create(body?.name, body?.source, urls);
        if (body?.scan) this.jobs.enqueue({ kind: "group", groupId: g.id });
        this.groupsChanged();
        return this.summary(g, this.membership());
      }
      case "PATCH /groups/:id": {
        const before = this.groups.get(id).active;
        const g = this.groups.update(id, body ?? {});
        if (!before && g.active && g.scannedAt) {
          const fresh = g.urls.filter((u) => this.pageStatus(u).status === "new");
          if (fresh.length) this.jobs.enqueue({ kind: "pages", urls: fresh, label: `Scanning ${g.name}` });
        }
        this.groupsChanged();
        return this.summary(g, this.membership());
      }
      case "DELETE /groups/:id":
        this.groups.remove(id);
        this.groupsChanged();
        return { ok: true };
      case "POST /groups/:id/restore": {
        const g = this.groups.restore(id);
        this.groupsChanged();
        return this.summary(g, this.membership());
      }
      case "GET /groups/:id/pages": {
        const g = this.groups.get(id);
        const members = this.membership();
        const want = query.get("status") || "all";
        const q = (query.get("q") ?? "").trim().toLowerCase();
        const offset = Math.max(0, Number(query.get("offset")) || 0);
        const limit = Math.min(500, Math.max(1, Number(query.get("limit")) || 50));
        const counts = { all: g.urls.length, ok: 0, failed: 0, new: 0, excluded: g.excluded.length };
        const rows: Array<{ url: string; status: PageStatus; row?: PageRow }> = [];
        for (const url of g.urls) {
          const s = this.pageStatus(url);
          if (s.status === "ok") counts.ok++;
          else if (s.status === "failed") counts.failed++;
          else if (s.status === "new") counts.new++;
          rows.push({ url, ...s });
        }
        for (const url of g.excluded) rows.push({ url, status: "excluded" });
        const hits = rows.filter((r) => (want === "all" ? r.status !== "excluded" : r.status === want) && (!q || r.url.toLowerCase().includes(q)));
        return {
          counts,
          total: hits.length,
          pages: hits.slice(offset, offset + limit).map((r) => ({
            url: r.url,
            status: r.status,
            ...(r.status === "failed" && r.row?.error ? { reason: friendlyError(r.row.error) } : {}),
            scannedAt: r.status === "excluded" ? null : (r.row?.capturedAt ?? null),
            alsoIn: (members.get(r.url) ?? []).filter((n) => n !== g.name),
          })),
        };
      }
      case "POST /groups/:id/pages": {
        const g = this.groups.get(id);
        const urls = this.paths(Array.isArray(body?.urls) ? body.urls : []);
        if (urls.length === 0) throw new UserError("Add at least one page address.");
        const res = this.groups.addPages(g.id, urls);
        if (body?.scan) {
          const fresh = urls.filter((u) => this.pageStatus(u).status === "new");
          this.jobs.enqueue({ kind: "pages", urls: fresh, label: `Scanning new pages in ${g.name}` });
        }
        this.groupsChanged();
        return res;
      }
      case "POST /groups/:id/remove": {
        const url = this.paths([body?.url])[0];
        if (!url) throw new UserError("Which page?");
        const res = this.groups.removePage(id, url);
        this.groupsChanged();
        return res;
      }
      case "POST /groups/:id/include": {
        const url = this.paths([body?.url])[0];
        if (!url) throw new UserError("Which page?");
        this.groups.include(id, url);
        this.groupsChanged();
        return { ok: true };
      }
      case "POST /groups/:id/rescan":
        this.requireSite();
        this.groups.get(id);
        this.jobs.enqueue({ kind: "group", groupId: id });
        return { queued: true };
      case "POST /rescan": {
        this.requireSite();
        const urls = this.paths(Array.isArray(body?.urls) ? body.urls : []);
        if (urls.length === 0) throw new UserError("Which pages?");
        this.jobs.enqueue({ kind: "pages", urls });
        return { queued: true };
      }
      case "POST /rescan-all":
        this.requireSite();
        this.jobs.enqueue({ kind: "all" });
        return { queued: true };
      default:
        throw new UserError("Not found.", 404);
    }
  }

  // ------------------------------------------------------------ lifecycle

  /** Stops the site; `remove`: also deletes its folder. */
  async close(remove = false): Promise<void> {
    clearInterval(this.purge);
    this.watcher.stop();
    if (remove) await this.jobs.stop();
    await this.renderer?.close();
    this.store.close();
    if (remove) rmSync(this.dir, { recursive: true, force: true });
  }
}

export function folderBytes(dir: string): number {
  let bytes = 0;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          bytes += statSync(p).size;
        } catch {
          /* removed meanwhile */
        }
      }
    }
  };
  walk(dir);
  return bytes;
}

/** The ids of the sites stored in <data>/sites. */
export function storedSites(sitesDir: string): string[] {
  try {
    return readdirSync(sitesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f]{8}$/.test(e.name) && existsSync(join(sitesDir, e.name, "settings.json")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
