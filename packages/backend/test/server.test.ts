import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "../src/server/http.js";
import { normalizeSheetName } from "../src/daemon/sheetMatch.js";
import { wildcard } from "../src/server/sitemap.js";
import { Links } from "../src/server/links.js";
import { pagePath, validateSettings } from "../src/server/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSite = path.resolve(here, "../../../fixtures/site");

class RpcClient {
  private buf = "";
  private id = 0;
  private readonly waiting = new Map<number, (m: any) => void>();
  readonly notes: Array<{ method: string; params: any }> = [];

  private constructor(private readonly socket: Socket) {}

  static async connect(port: number): Promise<RpcClient> {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    socket.write(`GET /rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: cbr-rpc\r\n\r\n`);
    const rest = await new Promise<string>((resolve, reject) => {
      let head = "";
      const onData = (c: Buffer) => {
        head += c.toString("utf8");
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        if (!head.startsWith("HTTP/1.1 101")) reject(new Error(head));
        else resolve(head.slice(end + 4));
      };
      socket.on("data", onData);
    });
    const c = new RpcClient(socket);
    socket.on("data", (d: Buffer) => c.feed(d.toString("utf8")));
    if (rest) c.feed(rest);
    return c;
  }

  private feed(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && this.waiting.has(m.id)) {
        this.waiting.get(m.id)!(m);
        this.waiting.delete(m.id);
      } else if (m.method) this.notes.push({ method: m.method, params: m.params });
    }
  }

  async call(method: string, params?: unknown): Promise<any> {
    const id = ++this.id;
    const res = await new Promise<any>((r) => {
      this.waiting.set(id, r);
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.result;
  }

  close(): void {
    this.socket.destroy();
  }
}

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("helpers", () => {
  it("matches CSS file names without hashes, versions or .min", () => {
    expect(normalizeSheetName("/assets/main.3f9a2c1b.css?v=2")).toBe("main.css");
    expect(normalizeSheetName("https://cdn.x.com/css/site-v12.min.css")).toBe("site.css");
    expect(normalizeSheetName("styles/app.bundle.css")).toBe("app.css");
    expect(normalizeSheetName("C:\\proj\\theme.css")).toBe("theme.css");
  });

  it("filters sitemap paths with * wildcards", () => {
    const m = wildcard("/blog/*");
    expect(m("/blog/a")).toBe(true);
    expect(m("/BLOG/a/b")).toBe(true);
    expect(m("/shop/blog/a")).toBe(false);
    expect(wildcard(undefined)("/x")).toBe(true);
  });

  it("turns page addresses into site paths", () => {
    const s = { siteUrl: "https://www.example.com", siteFolder: "", devices: ["desktop" as const] };
    expect(pagePath("https://www.example.com/a/b?x=1#top", s)).toBe("/a/b?x=1");
    expect(pagePath("blog/a.html", s)).toBe("/blog/a.html");
    expect(pagePath("mailto:a@b.c", s)).toBeUndefined();
  });

  it("keeps each project's linked groups across restarts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-links-"));
    try {
      new Links(dir).set("/work/site/", ["a", "b", "a"]);
      const again = new Links(dir);
      expect(again.get("/work/site")).toEqual(["a", "b"]);
      expect(again.get("/work/other")).toEqual([]);
      again.set("/work/site", []);
      expect(new Links(dir).get("/work/site")).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates site settings in plain language", () => {
    expect(validateSettings({ siteFolder: "www.example.com/x", devices: ["desktop"] }).siteUrl).toBe("https://www.example.com");
    expect(() => validateSettings({ siteUrl: "https://x.com", devices: [] })).toThrow(/at least one device/);
    expect(() => validateSettings({ siteFolder: "relative/dir", devices: ["mobile"] })).toThrow(/full path/);
  });
});

describe("local server", () => {
  let tmp: string;
  let site: string;
  let proj: string;
  let srv: RunningServer;
  let rpc: RpcClient;
  let allId: string;
  let homeId: string;
  let sessionId: string;

  const api = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${srv.url}${p}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbr-srv-")));
    site = path.join(tmp, "site");
    fs.cpSync(fixtureSite, site, { recursive: true });
    fs.writeFileSync(
      path.join(site, "sitemap.xml"),
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["index.html", "about.html", "contact.html"]
        .map((p) => `<url><loc>https://example.com/${p}</loc></url>`)
        .join("")}</urlset>`,
    );
    proj = path.join(tmp, "proj");
    fs.mkdirSync(path.join(proj, "styles"), { recursive: true });
    fs.copyFileSync(path.join(site, "css/main.css"), path.join(proj, "styles/main.css"));
    srv = await startServer({ dataDir: path.join(tmp, "data"), port: 0, l1Workers: 0, idleMs: 60_000 });
  });

  afterAll(async () => {
    rpc?.close();
    await srv?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("serves the setup page and starts unconfigured", async () => {
    const page = await fetch(`${srv.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    const { json } = await api("GET", "/api/state");
    expect(json.configured).toBe(false);
    expect(json.groups).toEqual([]);
    expect((await fetch(`${srv.url}/ui/../package.json`)).status).toBe(404);
  });

  it("rejects requests from other sites and non-JSON writes", async () => {
    expect((await api("PUT", "/api/site", { siteFolder: site, devices: ["desktop"] }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await api("GET", "/api/diff?s=x&url=/index.html", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await api("GET", "/api/state", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await api("GET", "/api/state", undefined, { "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    const plain = await fetch(`${srv.url}/api/rescan-all`, { method: "POST", body: "x", headers: { "Content-Type": "text/plain" } });
    expect(plain.status).toBe(415);
    const port = new URL(srv.url).port;
    const rebound = await new Promise<string>((resolve) => {
      const s = net.connect(Number(port), "127.0.0.1", () => s.write(`GET /api/state HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`));
      let out = "";
      s.on("data", (d) => (out += d));
      s.on("end", () => resolve(out));
    });
    expect(rebound).toMatch(/^HTTP\/1.1 403/);
  });

  it("saves site settings, with plain-language errors", async () => {
    const bad = await api("PUT", "/api/site", { siteFolder: path.join(tmp, "nope"), devices: ["desktop"] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/doesn't exist/);
    const ok = await api("PUT", "/api/site", { siteFolder: site, devices: ["desktop"] });
    expect(ok.status).toBe(200);
    expect(ok.json.state.configured).toBe(true);
    expect(ok.json.needsRescan).toBe(false);
  });

  it("previews a sitemap and creates a scanned group from it", async () => {
    const prev = await api("POST", "/api/sitemap/preview", { url: "sitemap.xml", filter: "/*about*" });
    expect(prev.json).toMatchObject({ total: 3, urls: ["/about.html"] });
    const g = await api("POST", "/api/groups", { name: "All pages", source: { type: "sitemap", url: "sitemap.xml" }, scan: true });
    expect(g.status).toBe(200);
    expect(g.json.pages).toBe(3);
    allId = g.json.id;
    await srv.app.jobs.idle();
    const { json } = await api("GET", "/api/state");
    expect(json.groups[0]).toMatchObject({ name: "All pages", ok: 3, failed: 0, fresh: 0 });
    expect(json.groups[0].scannedAt).toBeTruthy();
    expect(json.lastResult.message).toMatch(/All pages rescanned: 3 pages/);
    expect(json.totals.pages).toBe(3);
    expect(json.stylesheets.find((s: any) => s.url === "/css/main.css")?.pages).toBe(3);
  });

  it("adds a pasted group and shows shared pages", async () => {
    const dup = await api("POST", "/api/groups", { name: "all PAGES", source: { type: "paste" }, urls: ["/index.html"], scan: false });
    expect(dup.status).toBe(400);
    const g = await api("POST", "/api/groups", { name: "Home", source: { type: "paste" }, urls: ["index.html", "file:///nope", "/about.html"], scan: false });
    expect(g.json).toMatchObject({ pages: 2, sharedPages: 2, ok: 2 });
    homeId = g.json.id;
    const pages = await api("GET", `/api/groups/${homeId}/pages?status=all`);
    expect(pages.json.counts).toMatchObject({ all: 2, ok: 2 });
    expect(pages.json.pages[0].alsoIn).toEqual(["All pages"]);
  });

  it("connects an editor, scopes counts to linked groups and follows group changes", async () => {
    rpc = await RpcClient.connect(Number(new URL(srv.url).port));
    const init = await rpc.call("initialize", { workspaceRoot: proj });
    sessionId = init.sessionId;
    expect(init.serverUrl).toBe(srv.url);
    expect(init.groups.map((g: any) => g.name).sort()).toEqual(["All pages", "Home"]);
    expect(init.status.scope).toMatchObject({ linked: false, pages: 0 });

    const file = path.join(proj, "styles/main.css");
    const text = fs.readFileSync(file, "utf8").replace("color: blue;", "color: red;");
    const opened = await rpc.call("document/open", { path: file, text, version: 1 });
    expect(opened.answer.total.exact).toBe(0);
    expect(opened.answer.totalReasons).toContain("no-linked-groups");

    let total = await rpc.call("session/setGroups", { groups: [allId] });
    expect(total.total.exact).toBe(2); // .btn is on the home and about pages
    total = await rpc.call("session/setGroups", { groups: [homeId] });
    expect(total.total.exact).toBe(2);
    // Kept by the server, not in the project.
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "data", "links.json"), "utf8")).projects).toEqual({ [proj]: [homeId] });
    expect(fs.existsSync(path.join(proj, ".vscode"))).toBe(false);

    await api("PATCH", `/api/groups/${homeId}`, { active: false });
    await until(() => rpc.notes.some((n) => n.method === "groups/changed"));
    const paused = await rpc.call("analysis/queryImpacts", { scope: "session" });
    expect(paused.total.exact).toBe(0);
    await api("PATCH", `/api/groups/${homeId}`, { active: true });
    const back = await rpc.call("analysis/queryImpacts", { scope: "session" });
    expect(back.total.exact).toBe(2);

    const pages = await rpc.call("analysis/getPages", { path: file });
    expect(pages.pages.map((i: any) => i.url).sort()).toEqual(["/about.html", "/index.html"]);
    expect(pages.pages[0].groups).toEqual(["Home"]);

    const { json } = await api("GET", "/api/state");
    expect(json.projects).toEqual([{ id: sessionId, root: proj, name: "proj", groups: [homeId] }]);
    expect(json.stylesheets.find((s: any) => s.url === "/css/main.css").matches).toEqual([{ project: "proj", file: "styles/main.css" }]);
  });

  it("renders the before/after diff of a page", async () => {
    // On the home page .btn-primary overrides the color: nothing visible changes there.
    const home = await api("GET", `/api/diff?s=${sessionId}&url=${encodeURIComponent("/index.html")}`);
    expect(home.json.status).toBe("unchanged");
    const d = await api("GET", `/api/diff?s=${sessionId}&url=${encodeURIComponent("/about.html")}`);
    expect(d.status).toBe(200);
    expect(d.json.status).toBe("changed");
    expect(d.json.edits).toHaveLength(1);
    expect(d.json.before).toMatch(/^data:image\/jpeg;base64,/);
    expect(d.json.after).toMatch(/^data:image\/jpeg;base64,/);
    expect(d.json.width).toBeGreaterThan(0);
    expect(d.json.zones.length).toBeGreaterThan(0);
    expect(d.json.zones[0].props).toContainEqual({ prop: "color", before: expect.any(String), after: expect.any(String) });
    expect(d.json.anchors.length % 8).toBe(0);
    expect(d.json.anchorLeaves).toBeGreaterThan(0);
    const gone = await api("GET", `/api/diff?s=nope&url=/index.html`);
    expect(gone.status).toBe(404);
    const fresh = await api("GET", `/api/diff?s=${sessionId}&url=/never.html`);
    expect(fresh.json.error).toMatch(/hasn't been scanned/);
  }, 30_000);

  it("streams state and edit events", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${srv.url}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = "";
    const read = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    };
    await read(/event: state\ndata: \{/);
    const file = path.join(proj, "styles/main.css");
    await rpc.call("document/change", { path: file, version: 2, changes: [{ text: fs.readFileSync(file, "utf8").replace("color: blue;", "color: green;") }] });
    await read(/event: edit\ndata: \{"s":"/);
    expect(text).toContain(`"s":"${sessionId}"`);
    ctrl.abort();
  });

  it("excludes sitemap pages so they stay out after a rescan, and undoes it", async () => {
    const r = await api("POST", `/api/groups/${allId}/remove`, { url: "/contact.html" });
    expect(r.json).toEqual({ excluded: true });
    await api("POST", `/api/groups/${allId}/rescan`, {});
    await srv.app.jobs.idle();
    let pages = await api("GET", `/api/groups/${allId}/pages?status=excluded`);
    expect(pages.json.pages.map((p: any) => p.url)).toEqual(["/contact.html"]);
    expect(pages.json.counts.all).toBe(2);
    await api("POST", `/api/groups/${allId}/include`, { url: "/contact.html" });
    pages = await api("GET", `/api/groups/${allId}/pages`);
    expect(pages.json.counts).toMatchObject({ all: 3, excluded: 0 });
  }, 30_000);

  it("deletes a group with undo", async () => {
    expect((await api("DELETE", `/api/groups/${homeId}`)).json).toEqual({ ok: true });
    let { json } = await api("GET", "/api/state");
    expect(json.groups.map((g: any) => g.name)).toEqual(["All pages"]);
    const back = await api("POST", `/api/groups/${homeId}/restore`, {});
    expect(back.json.name).toBe("Home");
    ({ json } = await api("GET", "/api/state"));
    expect(json.groups).toHaveLength(2);
  });

  it("reports CSS changed outside the editor", async () => {
    const other = path.join(proj, "styles/main.css");
    await rpc.call("document/close", { path: other });
    rpc.notes.length = 0;
    fs.writeFileSync(other, fs.readFileSync(path.join(site, "css/main.css"), "utf8").replace("font-weight: bold;", "font-weight: 300;"));
    const note = await until(() => rpc.notes.find((n) => n.method === "analysis/externalChange"));
    expect(note.params.files).toContain(other);
  }, 15_000);

  it('starts "This session" for each new window, not for a reconnect or a second window', async () => {
    const proj2 = path.join(tmp, "proj2");
    fs.mkdirSync(path.join(proj2, "styles"), { recursive: true });
    const file = path.join(proj2, "styles/main.css");
    const original = fs.readFileSync(path.join(site, "css/main.css"), "utf8");
    fs.writeFileSync(file, original);
    const port = Number(new URL(srv.url).port);
    // Until the server has seen every window close (not a fixed wait: slow under a full test run).
    const settle = () => until(() => [...srv.app.projects.values()].every((p) => p.root !== proj2 || p.peers.size === 0));
    const session = (c: RpcClient) => c.call("analysis/queryImpacts", { scope: "session" });

    const a = await RpcClient.connect(port);
    const first = await a.call("initialize", { workspaceRoot: proj2, windowId: "a" });
    expect(first.sessionStarted).toBe(true);
    expect(first.status.scope.linked).toBe(false);
    await a.call("session/setGroups", { groups: [allId] });
    expect(first.status.git).toBe(false);
    await a.call("session/setDiffBase", { base: "session" });
    const edited = original.replace("color: blue;", "color: red;");
    fs.writeFileSync(file, edited);
    await until(async () => (await session(a)).total.exact === 2);

    const b = await RpcClient.connect(port);
    expect((await b.call("initialize", { workspaceRoot: proj2, windowId: "b" })).sessionStarted).toBe(false);
    expect((await session(b)).total.exact).toBe(2);
    a.close();
    b.close();
    await settle();
    // The window that joined reconnects (sleep, server hiccup): still the same session.
    const b2 = await RpcClient.connect(port);
    expect((await b2.call("initialize", { workspaceRoot: proj2, windowId: "b" })).sessionStarted).toBe(false);
    expect((await session(b2)).total.exact).toBe(2);
    b2.close();
    await settle();

    // A new window once the others closed (or a reload): the CSS as it is now is the start.
    const c = await RpcClient.connect(port);
    const third = await c.call("initialize", { workspaceRoot: proj2, windowId: "c" });
    expect(third.sessionStarted).toBe(true);
    expect(third.status.scope).toMatchObject({ linked: true, groups: [{ id: allId }] });
    expect(third.status.diffBase).toBe("session");
    expect((await session(c)).total.exact).toBe(0);
    // A file the window restores with unsaved typing: that typing was before this session.
    const typed = edited.replace("padding: 8px 16px;", "padding: 0;");
    const opened = await c.call("document/open", { path: file, text: typed, version: 1, atStart: true });
    expect(opened.session.total.exact).toBe(0);
    c.close();
    await settle();

    const again = await RpcClient.connect(port);
    expect((await again.call("initialize", { workspaceRoot: proj2, windowId: "c" })).sessionStarted).toBe(false);
    again.close();
  }, 20_000);

  it("asks for a rescan when the site changes", async () => {
    const r = await api("PUT", "/api/site", { siteFolder: site, devices: ["desktop", "mobile"] });
    expect(r.json.needsRescan).toBe(true);
  });
});
