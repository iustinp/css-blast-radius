// The local server: several sites, each scanned on its own. Serves the setup
// page, the diff viewer, a REST API with live updates (Server-Sent Events) and
// the editor connection (JSON-RPC over an upgraded HTTP request) on one port.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { TABS } from "../daemon/diffBase.js";
import type { SharedResources } from "../daemon/session.js";
import { Store } from "../index/store.js";
import { L1Pool } from "../l1/pool.js";
import { Renderer } from "../l2/render.js";
import { serveRpc, type RpcPeer } from "../rpc/connection.js";
import { EDITS, need, SERIAL, SESSION_NOTIFICATIONS, sessionMethod } from "../rpc/methods.js";
import { ERR, PROTOCOL_MAJOR, PROTOCOL_MINOR, RpcError, SCHEMA_VERSION, SERVICE_VERSION, type GroupInfo, type InitializeResult, type WatchStatus } from "../rpc/protocol.js";
import { friendlyError } from "./jobs.js";
import { Project } from "./project.js";
import { buildConfig, DEFAULT_SETTINGS, UserError, validateSettings } from "./settings.js";
import { folderBytes, newSiteId, Site, storedSites, type SiteProject } from "./site.js";

export const DEFAULT_PORT = 4317;

export interface ServeOptions {
  dataDir: string;
  port?: number;
  host?: string;
  l1Workers?: number;
  /** How long a project's session lives after its last editor disconnects. */
  idleMs?: number;
  /** Check the sites for changes on a timer (default true; false: only when asked). */
  watch?: boolean;
  log?: (msg: string) => void;
}

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
  /** Sites in the order they were added. */
  readonly sites = new Map<string, Site>();
  readonly pool: L1Pool;
  readonly projects = new Map<string, Project>();
  url = "";
  private readonly sitesDir: string;
  private readonly blobDir: string;
  private blankRes?: SharedResources;
  private readonly creating = new Map<string, Promise<Project>>();
  private readonly sse = new Set<ServerResponse>();
  private readonly peers = new Set<RpcPeer>();
  /** The project each editor connection is attached to. */
  private readonly peerProject = new Map<RpcPeer, Project>();
  private version = 0;
  private stateTimer?: NodeJS.Timeout;
  private progressAt = 0;
  private disk = { at: 0, bytes: 0 };
  private readonly started = Date.now();
  private readonly log: (msg: string) => void;

  constructor(readonly opts: ServeOptions) {
    this.log = opts.log ?? (() => {});
    mkdirSync(opts.dataDir, { recursive: true });
    this.sitesDir = join(opts.dataDir, "sites");
    this.blobDir = join(opts.dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.pool = new L1Pool({ blobDir: this.blobDir, workers: opts.l1Workers });
    this.siteHost.pool = this.pool;
    this.siteHost.blobDir = this.blobDir;
    for (const id of storedSites(this.sitesDir)) this.openSite(id);
  }

  // ---------------------------------------------------------------- sites

  private openSite(id: string, settings?: Site["settings"]): Site {
    const site = new Site(id, join(this.sitesDir, id), this.siteHost, { watch: this.opts.watch, settings });
    this.sites.set(id, site);
    return site;
  }

  private readonly siteHost = {
    pool: undefined as unknown as L1Pool,
    blobDir: "",
    projects: (site: Site): SiteProject[] =>
      [...this.projects.values()].flatMap((p) => {
        const session = p.sessionOn(site.id);
        return session ? [{ name: p.name, root: p.root, linked: p.linked, session }] : [];
      }),
    projectRoots: () => [...this.projects.values()].reverse().map((p) => p.root),
    groupsChanged: () => this.groupsChanged(),
    progress: (site: Site, p: { done: number; total: number; url: string; ok: boolean }) => this.progress(site, p),
    watchChanged: (site: Site, status: WatchStatus) => {
      for (const peer of this.peers) {
        const pr = this.peerProject.get(peer);
        if (pr && this.watchSite(pr) === site) peer.notify("scan/watch", status);
      }
    },
    changed: () => this.changed(),
    log: (m: string) => this.log(m),
    state: () => this.state(),
  };

  site(id: string): Site {
    const s = this.sites.get(id);
    if (!s) throw new UserError("That site doesn't exist any more.", 404);
    return s;
  }

  /** The site a group id belongs to. */
  private groupSite(id: string): Site | undefined {
    for (const s of this.sites.values()) if (s.groups.find(id)) return s;
    return undefined;
  }

  private blank(): SharedResources {
    if (this.blankRes) return this.blankRes;
    const dir = join(this.opts.dataDir, "blank");
    const cfg = buildConfig(DEFAULT_SETTINGS, dir);
    const store = new Store(dir, this.blobDir);
    let renderer: Renderer | undefined;
    return (this.blankRes = { cfg, store, pool: this.pool, renderer: () => (renderer ??= new Renderer(cfg, store)), index: () => undefined });
  }

  private readonly projectHost = {
    sitesFor: (linked: string[]) => [...this.sites.values()].filter((s) => linked.some((id) => s.groups.find(id))),
    fallback: () => this.sites.values().next().value as Site | undefined,
    blank: () => this.blank(),
  };

  /** The site whose auto-rescan the editor shows: the project's first linked site. */
  private watchSite(p: Project): Site | undefined {
    return this.projectHost.sitesFor(p.linked)[0] ?? this.projectHost.fallback();
  }

  private async addSite(body: any): Promise<{ id: string; state: unknown }> {
    const settings = validateSettings(body);
    const id = newSiteId();
    this.openSite(id, settings);
    await this.relinkAll();
    this.changed();
    return { id, state: this.state() };
  }

  private async removeSite(id: string): Promise<void> {
    const site = this.site(id);
    this.sites.delete(id);
    const gone = new Set(site.groups.all().map((g) => g.id));
    for (const p of this.projects.values()) p.linked = p.linked.filter((g) => !gone.has(g));
    await this.relinkAll();
    await site.close(true);
    this.groupsChanged();
  }

  /** Sites came or went: every project's sessions follow (in its document order). */
  private async relinkAll(): Promise<void> {
    await Promise.all(
      [...this.projects.values()].map((p) => {
        const run = () => p.relink(p.linked);
        return (p.serial = p.serial.then(run, run));
      }),
    );
  }

  groupInfos(): GroupInfo[] {
    return [...this.sites.values()].flatMap((s) => s.groupInfos());
  }

  /** Group membership or names changed (the sites updated their sessions' counts). */
  private groupsChanged(): void {
    const groups = this.groupInfos();
    for (const peer of this.peers) peer.notify("groups/changed", { groups });
    this.changed();
  }

  private diskBytes(): number {
    if (Date.now() - this.disk.at < 30_000) return this.disk.bytes;
    this.disk = { at: Date.now(), bytes: folderBytes(this.opts.dataDir) };
    return this.disk.bytes;
  }

  state() {
    return {
      version: this.version,
      server: { version: SERVICE_VERSION, url: this.url, dataDir: this.opts.dataDir, diskBytes: this.diskBytes() },
      sites: [...this.sites.values()].map((s) => s.state()),
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
    const key = `${p.editRevision}:${p.selectionRevision}`;
    if (key === p.sentEdit) return;
    const selection = p.sentEdit.startsWith(`${p.editRevision}:`);
    p.sentEdit = key;
    this.broadcast("edit", { s: p.id, editRevision: p.editRevision, ...(selection ? { selection: true } : {}) });
  }

  private progress(site: Site, p: { done: number; total: number; url: string; ok: boolean }): void {
    const now = Date.now();
    if (now - this.progressAt < 250 && p.done !== p.total && p.ok) return;
    this.progressAt = now;
    for (const peer of this.peers) {
      const pr = this.peerProject.get(peer);
      if (!pr || pr.sessionOn(site.id)) peer.notify("index/captureProgress", p);
    }
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
        const p = new Project(id, root, basename(root), this.projectHost);
        await p.relink([]);
        p.sentEdit = `${p.editRevision}:${p.selectionRevision}`;
        for (const [event, method] of SESSION_NOTIFICATIONS) p.on(event, (x) => p.peers.forEach((c) => c.notify(method, x)));
        p.on("publish", () => this.edited(p));
        p.on("externalChange", () => this.edited(p));
        p.on("selection", () => this.edited(p));
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

  private detach(p: Project, peer: RpcPeer): void {
    p.peers.delete(peer);
    if (p.peers.size > 0 || p.idle) return;
    // No editor left to show which edits are picked: the diff viewer shows them all.
    p.setSelection(undefined);
    p.idle = setTimeout(() => {
      if (p.peers.size > 0) return;
      this.projects.delete(p.id);
      void p.dispose();
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
            if (![...next.peers].some((x) => x !== peer)) {
              // The only window: it reopens its own files next, so files earlier windows left open are closed.
              const run = () => next.closeAll();
              await (next.serial = next.serial.then(run, run));
            }
            if (peer.closed) throw new RpcError(ERR.invalidRequest, "connection closed");
            project.peers.add(peer);
            this.peerProject.set(peer, project);
            const linked = Array.isArray(p.groups) ? [...new Set((p.groups as unknown[]).map(String))] : project.linked;
            const pr = project;
            const run = () => pr.relink(linked);
            await (pr.serial = pr.serial.then(run, run));
            this.changed();
            const site = this.watchSite(pr);
            const r: InitializeResult = {
              protocolMajor: PROTOCOL_MAJOR,
              protocolMinor: PROTOCOL_MINOR,
              serviceVersion: SERVICE_VERSION,
              schemaVersion: SCHEMA_VERSION,
              mode: "local",
              repository: { workspaceRoot: root, ...(site ? { siteRoot: site.shared.cfg.siteRoot, baseUrl: site.shared.cfg.baseUrl } : {}) },
              capabilities: { levels: [0, 1, 2, 3], capture: true, tabs: TABS },
              status: pr.status(),
              sessionId: pr.id,
              serverUrl: this.url,
              groups: this.groupInfos(),
              ...(site ? { watch: site.watcher.status } : {}),
            };
            for (const s of this.sites.values()) s.watcher.projectsChanged();
            return r;
          }
          case "server/health":
            return { health: project?.status().health ?? "READY", uptimeMs: Date.now() - this.started, pid: process.pid };
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
            const total = await pr.relink([...new Set(ids.map(String))]);
            const site = this.watchSite(pr);
            if (site) peer.notify("scan/watch", site.watcher.status);
            this.changed();
            return total;
          }
          case "index/capture": {
            const sites = this.projectHost.sitesFor(pr.linked);
            if (!sites.length) throw new RpcError(ERR.invalidRequest, `link page groups first, or set up a site: ${this.url}`);
            const urls = Array.isArray(p?.urls) && p.urls.length ? (p.urls as unknown[]) : undefined;
            const site = typeof p?.site === "string" ? this.sites.get(p.site) : undefined;
            for (const s of site ? [site] : sites) {
              // A full address goes to its own site only.
              const mine = urls?.filter((u) => !/^https?:\/\//i.test(String(u)) || s.owns(String(u)));
              if (urls && !mine?.length) continue;
              s.capture(pr.linked, mine);
            }
            return { started: true };
          }
        }
        const handled = sessionMethod(pr, method, p);
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
        this.peerProject.delete(x);
        if (project) this.detach(project, x);
      },
    });
    this.peers.add(peer);
  }

  // ----------------------------------------------------------------- REST

  async api(method: string, path: string, query: URLSearchParams, body: any): Promise<unknown> {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    if (parts[1] === "sites") {
      if (parts.length === 2) {
        if (method === "GET") return this.state().sites;
        if (method === "POST") return this.addSite(body);
      } else if (parts.length === 3 && method === "DELETE") {
        await this.removeSite(parts[2]);
        return { ok: true };
      } else {
        return this.site(parts[2]).api(method, parts.slice(3), query, body);
      }
      throw new UserError("Not found.", 404);
    }
    switch (`${method} /${parts.slice(1).join("/")}`) {
      case "GET /state":
        return this.state();
      case "GET /diff": {
        const p = this.projects.get(query.get("s") ?? "");
        if (!p) throw new UserError("This VS Code window isn't connected any more. Open the page again from VS Code.", 404);
        const siteId = query.get("site") || undefined;
        const site = siteId ? this.site(siteId) : this.projectHost.sitesFor(p.linked)[0];
        if (!site) throw new UserError("Link page groups to this project first.", 409);
        const url = site.paths([query.get("url") ?? ""])[0];
        if (!url) throw new UserError("Which page?");
        if (!site.index()) throw new UserError("No pages have been scanned yet.", 409);
        const row = site.pageRow(url);
        if (!row || row.status === "removed") throw new UserError(`${url} hasn't been scanned yet. Add it to a group and scan it first.`, 404);
        if (row.status === "failed") throw new UserError(`${url} couldn't be scanned (${friendlyError(row.error) ?? "unknown error"}). Rescan it from the setup page.`, 409);
        if (!p.sessionOn(site.id)) throw new UserError(`This project isn't linked to a group of ${site.name}.`, 409);
        const device = query.get("device") || undefined;
        return p.pageDiff({ url, device, live: query.get("live") === "1", site: site.id });
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
    clearTimeout(this.stateTimer);
    for (const res of this.sse) res.end();
    for (const peer of this.peers) peer.close();
    for (const p of this.projects.values()) {
      clearTimeout(p.idle);
      await p.dispose();
    }
    this.projects.clear();
    for (const s of this.sites.values()) await s.close();
    if (this.blankRes) {
      await this.blankRes.renderer().close();
      this.blankRes.store.close();
    }
    await this.pool.close();
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
