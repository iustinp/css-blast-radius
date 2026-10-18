// The local server: one per site. Serves the setup page, the diff viewer, a
// REST API with live updates (Server-Sent Events) and the editor connection
// (JSON-RPC over an upgraded HTTP request) on one port.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { CaptureResult } from "../capture/capture.js";
import type { CbrConfig } from "../config.js";
import { DIFF_BASES } from "../daemon/diffBase.js";
import { Session, type ScopeGroup, type SharedResources } from "../daemon/session.js";
import { SiteIndex } from "../index/siteIndex.js";
import { Store, type PageRow } from "../index/store.js";
import { L1Pool } from "../l1/pool.js";
import { Renderer } from "../l2/render.js";
import { serveRpc, type RpcPeer } from "../rpc/connection.js";
import { EDITS, need, SERIAL, SESSION_NOTIFICATIONS, sessionMethod } from "../rpc/methods.js";
import { ERR, PROTOCOL_MAJOR, PROTOCOL_MINOR, RpcError, SCHEMA_VERSION, SERVICE_VERSION, type GroupInfo, type InitializeResult } from "../rpc/protocol.js";
import { Groups, type Group } from "./groups.js";
import { friendlyError, Jobs } from "./jobs.js";
import { buildConfig, isConfigured, loadSettings, pagePath, saveSettings, siteKey, UserError, validateSettings, watchSettings, type SiteSettings } from "./settings.js";
import { readSitemap } from "./sitemap.js";
import { Watcher } from "./watch.js";

export const DEFAULT_PORT = 4317;

export interface ServeOptions {
  dataDir: string;
  port?: number;
  host?: string;
  l1Workers?: number;
  /** How long a project's session lives after its last editor disconnects. */
  idleMs?: number;
  /** Check the site for changes on a timer (default true; false: only when asked). */
  watch?: boolean;
  log?: (msg: string) => void;
}

interface Project {
  id: string;
  root: string;
  name: string;
  session: Session;
  peers: Set<RpcPeer>;
  /** Linked group ids: each editor keeps its own choice and sends it on initialize. */
  linked: string[];
  serial: Promise<unknown>;
  /** editRevision:selectionRevision last announced to diff viewers. */
  sentEdit: string;
  idle?: NodeJS.Timeout;
  /** "This session" has a start (the session's creation or a restart for a new window). */
  begun: boolean;
  /** Editor windows attached since "This session" started: their reconnects keep it. */
  windows: Set<string>;
  /** Restarted for this window, which hasn't attached since (its initialize timed out): its retry gets the news. */
  unacked?: string;
}

type PageStatus = "ok" | "failed" | "new" | "capturing" | "excluded";

const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
const MAX_BODY = 32 * 1024 * 1024;

export function projectId(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12);
}

class HttpError extends UserError {}

export class App {
  settings: SiteSettings;
  readonly groups: Groups;
  readonly store: Store;
  readonly pool: L1Pool;
  readonly jobs: Jobs;
  readonly watcher: Watcher;
  readonly shared: SharedResources;
  readonly projects = new Map<string, Project>();
  url = "";
  private cfg: CbrConfig;
  private renderer?: Renderer;
  private loaded?: { rev: number; index?: SiteIndex };
  private readonly creating = new Map<string, Promise<Project>>();
  private readonly sse = new Set<ServerResponse>();
  private readonly peers = new Set<RpcPeer>();
  private version = 0;
  private stateTimer?: NodeJS.Timeout;
  private progressAt = 0;
  private disk = { at: 0, bytes: 0 };
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly started = Date.now();
  private readonly log: (msg: string) => void;

  constructor(readonly opts: ServeOptions) {
    this.log = opts.log ?? (() => {});
    mkdirSync(opts.dataDir, { recursive: true });
    this.settings = loadSettings(opts.dataDir);
    this.groups = new Groups(opts.dataDir);
    this.store = new Store(opts.dataDir);
    this.pool = new L1Pool({ blobDir: this.store.blobDir, workers: opts.l1Workers });
    this.cfg = buildConfig(this.settings, opts.dataDir);
    this.shared = {
      cfg: this.cfg,
      store: this.store,
      pool: this.pool,
      renderer: () => (this.renderer ??= new Renderer(this.cfg, this.store)),
      index: () => this.index(),
    };
    this.jobs = new Jobs({
      dataDir: opts.dataDir,
      store: this.store,
      groups: this.groups,
      settings: () => this.settings,
      keepRevisions: () => [...this.projects.values()].map((p) => p.session.index?.revision.id).filter((r): r is number => r !== undefined),
      published: (res) => this.published(res),
      groupsChanged: () => this.groupsChanged(),
      progress: (p) => this.progress(p),
      changed: () => this.changed(),
      log: this.log,
    });
    this.watcher = new Watcher({
      store: this.store,
      pool: this.pool,
      jobs: this.jobs,
      index: () => this.index(),
      settings: () => this.settings,
      config: () => this.cfg,
      projectRoots: () => [...this.projects.values()].reverse().map((p) => p.root),
      activeUrls: () => this.groups.activeUrls(),
      changed: (status) => {
        for (const peer of this.peers) peer.notify("scan/watch", status);
        this.changed();
      },
      log: this.log,
    });
    if (opts.watch !== false) this.watcher.start();
    const purge = setInterval(() => {
      if (this.groups.purge()) this.changed();
    }, 30_000);
    purge.unref();
    this.timers.push(purge);
  }

  // ---------------------------------------------------------------- index

  /** The current index, loaded once and shared by every project. */
  index(): SiteIndex | undefined {
    const rev = this.store.currentRevision();
    if (!rev) return undefined;
    if (this.loaded?.rev !== rev.id) this.loaded = { rev: rev.id, index: SiteIndex.load(this.store, rev.id) };
    return this.loaded.index;
  }

  private pageRow(url: string): PageRow | undefined {
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
    for (const p of this.projects.values()) {
      p.session.setScope(this.scopeFor(p.linked));
      await p.session.indexChanged(res);
    }
    this.changed();
  }

  // --------------------------------------------------------------- groups

  private scopeFor(linked: string[]): ScopeGroup[] {
    return linked.map((id) => this.groups.find(id)).filter((g): g is Group => !!g).map((g) => ({ id: g.id, name: g.name, active: g.active, urls: g.urls }));
  }

  groupInfos(): GroupInfo[] {
    return this.groups.all().map((g) => ({ id: g.id, name: g.name, active: g.active, pages: g.urls.length }));
  }

  /** Group membership or names changed: update every project's counts. */
  private groupsChanged(): void {
    for (const p of this.projects.values()) p.session.setScope(this.scopeFor(p.linked));
    const groups = this.groupInfos();
    for (const peer of this.peers) peer.notify("groups/changed", { groups });
    this.changed();
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
    let bytes = 0;
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
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
    walk(this.opts.dataDir);
    this.disk = { at: Date.now(), bytes };
    return bytes;
  }

  state() {
    const members = this.membership();
    const all = this.groups.all();
    const active = this.groups.activeUrls();
    const paused = new Set<string>();
    for (const g of all) if (!g.active) for (const u of g.urls) if (!active.has(u)) paused.add(u);
    const idx = this.index();
    const matches = new Map<string, Array<{ project: string; file: string }>>();
    for (const p of this.projects.values()) {
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
      version: this.version,
      server: { version: SERVICE_VERSION, url: this.url, dataDir: this.opts.dataDir },
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
      projects: [...this.projects.values()].map((p) => ({ id: p.id, root: p.root, name: p.name, groups: p.linked })),
    };
  }

  // ------------------------------------------------------------------ SSE

  /** Something visible changed: send the state (at most ~4 times a second). */
  changed(): void {
    this.version++;
    if (this.stateTimer || this.sse.size === 0) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.broadcast("state", this.state());
    }, 200);
  }

  private broadcast(event: string, data: unknown): void {
    if (this.sse.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sse) res.write(msg);
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`retry: 2000\n\nevent: state\ndata: ${JSON.stringify(this.state())}\n\n`);
    this.sse.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      this.sse.delete(res);
    });
  }

  /** The project's CSS edits or the selected edits changed: open diff viewers refresh. */
  private edited(p: Project): void {
    const key = `${p.session.editRevision}:${p.session.selectionRevision}`;
    if (key === p.sentEdit) return;
    const selection = p.sentEdit.startsWith(`${p.session.editRevision}:`);
    p.sentEdit = key;
    this.broadcast("edit", { s: p.id, editRevision: p.session.editRevision, ...(selection ? { selection: true } : {}) });
  }

  private progress(p: { done: number; total: number; url: string; ok: boolean }): void {
    const now = Date.now();
    if (now - this.progressAt < 250 && p.done !== p.total && p.ok) return;
    this.progressAt = now;
    for (const peer of this.peers) peer.notify("index/captureProgress", p);
  }

  // ------------------------------------------------------------- projects

  private async project(root: string): Promise<Project> {
    const id = projectId(root);
    const have = this.projects.get(id);
    if (have) {
      clearTimeout(have.idle);
      have.idle = undefined;
      return have;
    }
    let pending = this.creating.get(id);
    if (!pending) {
      pending = (async () => {
        if (!existsSync(root) || !statSync(root).isDirectory()) throw new RpcError(ERR.invalidParams, `folder not found: ${root}`);
        const session = await Session.create({ workspaceRoot: root, shared: this.shared, diffBase: "production", scope: [] });
        const p: Project = { id, root, name: basename(root), session, peers: new Set(), linked: [], serial: Promise.resolve(), sentEdit: `${session.editRevision}:${session.selectionRevision}`, begun: false, windows: new Set() };
        for (const [event, method] of SESSION_NOTIFICATIONS) session.on(event, (x) => p.peers.forEach((c) => c.notify(method, x)));
        session.on("publish", () => this.edited(p));
        session.on("externalChange", () => this.edited(p));
        session.on("selection", () => this.edited(p));
        this.projects.set(id, p);
        this.changed();
        return p;
      })().finally(() => this.creating.delete(id));
      this.creating.set(id, pending);
    }
    const p = await pending;
    clearTimeout(p.idle);
    p.idle = undefined;
    return p;
  }

  /**
   * "This session" starts when the session is created, and again when a new
   * editor window (or a reload) is the only one attached; a window that
   * reconnects, or joins another open window, keeps the running session.
   */
  private async startSession(p: Project, peer: RpcPeer, windowId: string | undefined): Promise<boolean> {
    const others = [...p.peers].some((x) => x !== peer);
    if (!p.begun) {
      p.begun = true;
      if (windowId) p.windows.add(windowId);
      return true;
    }
    if (!windowId) return false;
    if (p.unacked === windowId && !others) return true;
    if (others || p.windows.has(windowId)) {
      p.windows.add(windowId);
      return false;
    }
    p.unacked = windowId;
    const run = () => p.session.restartSession();
    try {
      await (p.serial = p.serial.then(run, run));
    } catch (err) {
      p.unacked = undefined;
      throw err;
    }
    p.windows = new Set([windowId]);
    return true;
  }

  private detach(p: Project, peer: RpcPeer): void {
    p.peers.delete(peer);
    if (p.peers.size > 0 || p.idle) return;
    // No editor left to show which edits are picked: the diff viewer shows them all.
    p.session.setSelection(undefined);
    p.idle = setTimeout(() => {
      if (p.peers.size > 0) return;
      this.projects.delete(p.id);
      void p.session.dispose();
      this.changed();
    }, this.opts.idleMs ?? 10 * 60_000);
    p.idle.unref();
  }

  // ------------------------------------------------------------------ RPC

  private rpcConnection(socket: Duplex, head: Buffer): void {
    let project: Project | undefined;
    const peer = serveRpc(socket, {
      head,
      log: this.log,
      dispatch: async (method, p) => {
        switch (method) {
          case "initialize": {
            const root = resolve(String(need(p, "workspaceRoot")));
            const next = await this.project(root);
            if (project && project !== next) this.detach(project, peer);
            project = next;
            const windowId = typeof p.windowId === "string" ? p.windowId : undefined;
            const started = await this.startSession(next, peer, windowId);
            // Hung up while "This session" restarted: don't keep a dead peer (its retry is told it started).
            if (peer.closed) throw new RpcError(ERR.invalidRequest, "connection closed");
            project.peers.add(peer);
            if (windowId && project.unacked === windowId) project.unacked = undefined;
            if (Array.isArray(p.groups)) project.linked = [...new Set((p.groups as unknown[]).map(String))];
            project.session.setScope(this.scopeFor(project.linked));
            this.changed();
            const r: InitializeResult = {
              protocolMajor: PROTOCOL_MAJOR,
              protocolMinor: PROTOCOL_MINOR,
              serviceVersion: SERVICE_VERSION,
              schemaVersion: SCHEMA_VERSION,
              mode: "local",
              repository: { workspaceRoot: root, siteRoot: this.cfg.siteRoot, baseUrl: this.cfg.baseUrl },
              capabilities: { levels: [0, 1, 2, 3], capture: true, diffBases: DIFF_BASES },
              status: project.session.status(),
              sessionId: project.id,
              sessionStarted: started,
              serverUrl: this.url,
              groups: this.groupInfos(),
              watch: this.watcher.status,
            };
            this.watcher.projectsChanged();
            return r;
          }
          case "server/health":
            return { health: project?.session.status().health ?? "READY", uptimeMs: Date.now() - this.started, pid: process.pid };
          case "groups/list":
            return this.groupInfos();
          case "server/shutdown":
            return { ok: true }; // shared by every project: stopped from the command line only
        }
        if (!project) throw new RpcError(ERR.invalidRequest, "call initialize first");
        const pr = project;
        switch (method) {
          case "session/setGroups": {
            const ids = need(p, "groups");
            if (!Array.isArray(ids)) throw new RpcError(ERR.invalidParams, "groups must be a list of group ids");
            pr.linked = [...new Set(ids.map(String))];
            const total = pr.session.setScope(this.scopeFor(pr.linked));
            this.changed();
            return total;
          }
          case "index/capture": {
            if (!isConfigured(this.settings)) throw new RpcError(ERR.invalidRequest, `set up the site first: ${this.url}`);
            if (Array.isArray(p?.urls) && p.urls.length) this.jobs.enqueue({ kind: "pages", urls: this.paths(p.urls) });
            else for (const g of this.scopeFor(pr.linked)) if (g.active) this.jobs.enqueue({ kind: "group", groupId: g.id });
            return { started: true };
          }
        }
        const handled = sessionMethod(pr.session, method, p);
        if (!handled) throw new RpcError(ERR.methodNotFound, `unknown method: ${method}`);
        const result = await handled;
        if (EDITS.has(method)) this.edited(pr);
        return result;
      },
      serialize: (method, run) => {
        if (!project || !SERIAL.has(method)) return run();
        const pr = project;
        return (pr.serial = pr.serial.then(run, run));
      },
      onClose: (x) => {
        this.peers.delete(x);
        if (project) this.detach(project, x);
      },
    });
    this.peers.add(peer);
  }

  // ----------------------------------------------------------------- REST

  /** Page addresses from the user → site paths (other sites' addresses are skipped). */
  private paths(input: unknown[]): string[] {
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

  private requireSite(): void {
    if (!isConfigured(this.settings)) throw new UserError("Set the site's address first.");
  }

  private reconfigure(next: SiteSettings): void {
    this.settings = next;
    saveSettings(this.opts.dataDir, next);
    this.cfg = buildConfig(next, this.opts.dataDir);
    this.shared.cfg = this.cfg;
    const old = this.renderer;
    this.renderer = undefined;
    void old?.close();
    for (const p of this.projects.values()) p.session.reconfigure(this.cfg);
  }

  async api(method: string, path: string, query: URLSearchParams, body: any): Promise<unknown> {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    const route = `${method} /${parts.slice(1).map((s, i) => (parts[1] === "groups" && i === 1 ? ":id" : s)).join("/")}`;
    const id = parts[2];
    switch (route) {
      case "GET /state":
        return this.state();
      case "PUT /site": {
        const next = validateSettings(body);
        if (this.settings.watch) next.watch = this.settings.watch;
        const moved = siteKey(next) !== siteKey(this.settings);
        const otherSite = next.siteUrl !== this.settings.siteUrl || next.siteFolder !== this.settings.siteFolder;
        this.reconfigure(next);
        this.watcher.reset(otherSite);
        this.changed();
        return { state: this.state(), needsRescan: moved && this.groups.all().length > 0 && !!this.store.currentRevision() };
      }
      case "PUT /watch": {
        const w = watchSettings(this.settings);
        if (body?.enabled !== undefined) w.enabled = body.enabled === true;
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
        saveSettings(this.opts.dataDir, this.settings);
        this.watcher.reset(false);
        this.changed();
        return this.state();
      }
      case "POST /watch/check":
        await this.watcher.check();
        return this.state();
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
      case "GET /diff": {
        const p = this.projects.get(query.get("s") ?? "");
        if (!p) throw new UserError("This VS Code window isn't connected any more. Open the page again from VS Code.", 404);
        const url = this.paths([query.get("url") ?? ""])[0];
        if (!url) throw new UserError("Which page?");
        if (!this.index()) throw new UserError("No pages have been scanned yet.", 409);
        const row = this.pageRow(url);
        if (!row || row.status === "removed") throw new UserError(`${url} hasn't been scanned yet. Add it to a group and scan it first.`, 404);
        if (row.status === "failed") throw new UserError(`${url} couldn't be scanned (${friendlyError(row.error) ?? "unknown error"}). Rescan it from the setup page.`, 409);
        const device = query.get("device") || undefined;
        return p.session.pageDiff({ url, device, live: query.get("live") === "1" });
      }
      default:
        throw new UserError("Not found.", 404);
    }
  }

  // ----------------------------------------------------------------- HTTP

  private allowedHost(req: IncomingMessage): boolean {
    const host = this.opts.host ?? "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return true; // exposed on purpose
    const h = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  }

  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return !origin;
    try {
      const o = new URL(origin);
      return o.port === String(this.port()) && ["127.0.0.1", "localhost", "[::1]"].includes(o.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Browser requests from another site, including plain GETs (an `<img>` pointing at
   * `/api/diff` would otherwise start Chromium). Non-browser clients send neither header.
   */
  private sameSite(req: IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") return false;
    return !req.headers.origin || this.sameOrigin(req);
  }

  private port(): number {
    return Number(new URL(this.url).port);
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(json);
  }

  private file(res: ServerResponse, name: string): void {
    const file = resolve(UI_DIR, name);
    if (!file.startsWith(resolve(UI_DIR) + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
  }

  private body(req: IncomingMessage): Promise<any> {
    return new Promise((ok, fail) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          fail(new HttpError("That's too much data at once (over 32 MB).", 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return ok({});
        try {
          ok(JSON.parse(text));
        } catch {
          fail(new HttpError("The request isn't valid JSON."));
        }
      });
      req.on("error", fail);
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const u = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!this.allowedHost(req)) throw new HttpError("Use http://127.0.0.1 or http://localhost to open this page.", 403);
      if (method === "GET" && u.pathname === "/") return this.file(res, "setup.html");
      if (method === "GET" && u.pathname === "/diff") return this.file(res, "diff.html");
      if (method === "GET" && u.pathname.startsWith("/ui/")) return this.file(res, decodeURIComponent(u.pathname.slice(4)));
      if (u.pathname.startsWith("/api/") && !this.sameSite(req)) throw new HttpError("Requests from other sites aren't allowed.", 403);
      if (method === "GET" && u.pathname === "/api/events") return this.events(req, res);
      if (!u.pathname.startsWith("/api/")) throw new HttpError("Not found.", 404);
      let body: any = {};
      if (method !== "GET" && method !== "HEAD") {
        if (!this.sameOrigin(req)) throw new HttpError("Requests from other sites aren't allowed.", 403);
        const ct = req.headers["content-type"] ?? "";
        if (method !== "DELETE" && !/^application\/json\b/i.test(ct)) throw new HttpError("Send JSON (Content-Type: application/json).", 415);
        if (method === "DELETE" && req.headers["content-length"] && req.headers["content-length"] !== "0" && !/^application\/json\b/i.test(ct)) {
          throw new HttpError("Send JSON (Content-Type: application/json).", 415);
        }
        body = await this.body(req);
      }
      this.send(res, 200, await this.api(method, u.pathname, u.searchParams, body));
    } catch (err: any) {
      if (err instanceof UserError) return this.send(res, err.status, { error: err.message });
      if (err instanceof RpcError) return this.send(res, err.code === ERR.invalidParams ? 400 : 409, { error: err.message });
      this.log(`${method} ${u.pathname} failed: ${err?.stack ?? err}`);
      this.send(res, 500, { error: `Something went wrong: ${String(err?.message ?? err).split("\n")[0]}` });
    }
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname !== "/rpc" || (req.headers.upgrade ?? "").toLowerCase() !== "cbr-rpc" || !this.allowedHost(req) || req.headers.origin) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: cbr-rpc\r\nConnection: Upgrade\r\n\r\n");
    this.rpcConnection(socket, head);
  }

  async close(): Promise<void> {
    this.watcher.stop();
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.stateTimer);
    for (const res of this.sse) res.end();
    for (const peer of this.peers) peer.close();
    for (const p of this.projects.values()) {
      clearTimeout(p.idle);
      await p.session.dispose();
    }
    this.projects.clear();
    await this.renderer?.close();
    await this.pool.close();
    this.store.close();
  }
}

export interface RunningServer {
  url: string;
  port: number;
  app: App;
  close(): Promise<void>;
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const app = new App(opts);
  const server = http.createServer((req, res) => void app.handle(req, res));
  server.on("upgrade", (req, socket, head) => app.upgrade(req, socket, head));
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      server.off("error", fail);
      ok();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? DEFAULT_PORT);
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  app.url = `http://${shown}:${port}`;
  return {
    url: app.url,
    port,
    app,
    async close() {
      const closed = new Promise<void>((r) => server.close(() => r()));
      await app.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
