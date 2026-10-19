// The watcher keeps the scan equal to the site: a local git remote stands for
// the site's repository, a local server for the deployed site (its files are
// "deployed" by copying them from a clone), with a query index and a nav
// fragment like an Edge Delivery site.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/server/http.js";
import { indexPath } from "../src/server/watch.js";

const PAGES = ["/index.html", "/about.html", "/cards.html"];
const LIB = "/library.html";

const page = (title: string, body: string, nav: boolean, cards = false) => `<!doctype html>
<html><head><title>${title}</title>
<link rel="stylesheet" href="/styles/styles.css">
${cards ? `<link rel="stylesheet" href="/blocks/cards/cards.css"><script src="/blocks/cards/cards.js"></script>` : ""}
<script type="module" src="/scripts/scripts.js"></script>
</head><body${nav ? ` data-nav="1"` : ""}><header></header><main>${body}</main></body></html>`;

const FILES: Record<string, string> = {
  "head.html": `<meta name="viewport" content="width=device-width, initial-scale=1">\n`,
  "styles/styles.css": `body { margin: 0; font-family: sans-serif; }\n.hero { color: red; }\nmain p { line-height: 1.5; }\n`,
  "scripts/scripts.js": `if (document.body && document.body.dataset.nav) fetch("/nav.plain.html").then((r) => r.text()).then((t) => { document.querySelector("header").innerHTML = t; });\n`,
  "blocks/cards/cards.css": `.cards { display: grid; gap: 8px; }\n.card { padding: 4px; }\n`,
  "blocks/cards/cards.js": `document.addEventListener("DOMContentLoaded", () => {});\n`,
  "tools/library/library.css": `.library { color: gray; }\n`,
};
const SITE_ONLY: Record<string, string> = {
  "index.html": page("Home", `<h1 class="hero">Hello</h1><p>Welcome</p>`, true),
  "about.html": page("About", `<h1>About us</h1><p>Text</p>`, false),
  "cards.html": page("Cards", `<div class="cards"><div class="card">A</div><div class="card">B</div></div>`, true, true),
  "nav.plain.html": `<nav><a href="/">Home</a> <a href="/about">About</a></nav>`,
  // The only page that loads library.css.
  "library.html": `<!doctype html><html><head><title>Library</title><link rel="stylesheet" href="/tools/library/library.css"></head><body><main><div class="library">Lib</div></main></body></html>`,
};

describe("watcher: keeps the scan up to date", () => {
  let tmp: string;
  let dev: string;
  let repo: string;
  let site: string;
  let srv: RunningServer;
  let siteServer: http.Server;
  let siteUrl: string;
  const logs: string[] = [];
  const edits = new Map<string, number>(); // query index: path → lastModified (seconds)
  let navModified = 0; // ms

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dev, rel)), { recursive: true });
    fs.writeFileSync(path.join(dev, rel), text);
  };
  const push = (msg: string) => {
    git(dev, "add", "-A");
    git(dev, "commit", "-q", "-m", msg);
    git(dev, "push", "-q", "origin", "main");
    return git(dev, "rev-parse", "HEAD");
  };
  const deploy = () => {
    for (const rel of Object.keys(FILES)) {
      fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true });
      fs.copyFileSync(path.join(dev, rel), path.join(site, rel));
    }
  };
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}/api${p}`, {
      method,
      headers: method !== "GET" ? { "Content-Type": "application/json" } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const captured = () => new Map(srv.app.index()!.pages.map((p) => [p.url, p.capturedAt]));
  /** One check, then the job it queued; returns the status and the pages rescanned. */
  const check = async () => {
    const before = captured();
    const st = await api("POST", "/watch/check");
    await srv.app.jobs.idle();
    const after = captured();
    const rescanned = PAGES.filter((u) => after.get(u) !== before.get(u));
    return { watch: st.watch, rescanned };
  };
  const sheetHash = (pageUrl: string, file: string) => {
    const row = srv.app.index()!.pages.find((p) => p.url === pageUrl)!;
    const v = row.assets[`${siteUrl}${file}`];
    return v?.slice(0, v.indexOf(" "));
  };
  const servedHash = async (file: string) => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(fs.readFileSync(path.join(site, file))).digest("hex");
  };

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbr-watch-")));
    const remote = path.join(tmp, "remote.git");
    dev = path.join(tmp, "dev");
    repo = path.join(tmp, "repo");
    site = path.join(tmp, "site");
    fs.mkdirSync(remote);
    git(remote, "init", "-q", "--bare", "--initial-branch=main");
    git(tmp, "clone", "-q", remote, dev);
    git(dev, "checkout", "-q", "-B", "main");
    for (const [rel, text] of Object.entries(FILES)) write(rel, text);
    push("site");
    git(tmp, "clone", "-q", remote, repo);

    fs.mkdirSync(site);
    for (const [rel, text] of Object.entries(SITE_ONLY)) fs.writeFileSync(path.join(site, rel), text);
    deploy();
    const old = Math.floor(Date.now() / 1000) - 3600;
    for (const p of ["/", "/about", "/cards", "/nav"]) edits.set(p, old);
    navModified = old * 1000;

    siteServer = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/query-index.json") {
        const data = [...edits].map(([p, lastModified]) => ({ path: p, lastModified: String(lastModified) }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ total: data.length, offset: 0, limit: data.length, data }));
        return;
      }
      const rel = u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname.slice(1));
      const file = path.join(site, rel);
      if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      const ext = path.extname(file);
      const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";
      const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store" };
      if (rel.endsWith(".plain.html")) headers["last-modified"] = new Date(navModified).toUTCString();
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : fs.readFileSync(file));
    });
    await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;

    srv = await startServer({ dataDir: path.join(tmp, "data"), port: 0, l1Workers: 0, watch: false, log: (m) => logs.push(m) });
    await api("PUT", "/site", { siteUrl, devices: ["desktop"] });
    await api("POST", "/groups", { name: "All pages", source: { type: "paste" }, urls: PAGES, scan: true });
    await srv.app.jobs.idle();
    expect(srv.app.index()!.pages.filter((p) => p.status === "ok").map((p) => p.url).sort()).toEqual([...PAGES].sort());
    srv.app.watcher.settleMs = 60_000;
  }, 120_000);

  afterAll(async () => {
    await srv?.close();
    await new Promise((r) => siteServer?.close(r));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("maps page addresses to query index paths", () => {
    expect(indexPath("/index.html")).toBe("/");
    expect(indexPath("/about.html?x=1")).toBe("/about");
    expect(indexPath("/blog/")).toBe("/blog");
    expect(indexPath("/nav.plain.html".slice(0, -".plain.html".length))).toBe("/nav");
  });

  it("records what each page loaded, nav fragment included", () => {
    const row = srv.app.index()!.pages.find((p) => p.url === "/cards.html")!;
    expect(Object.keys(row.loaded ?? {}).sort()).toEqual(["/blocks/cards/cards.css", "/blocks/cards/cards.js", "/nav.plain.html", "/scripts/scripts.js", "/styles/styles.css"]);
    const about = srv.app.index()!.pages.find((p) => p.url === "/about.html")!;
    expect(Object.keys(about.loaded ?? {})).not.toContain("/nav.plain.html");
  });

  it("finds the repository and reports a fresh scan as up to date", async () => {
    const head = git(dev, "rev-parse", "HEAD");
    await api("PUT", "/watch", { repo });
    srv.app.watcher.settleMs = 60_000;
    const { watch, rescanned } = await check();
    expect(watch.enabled).toBe(true);
    expect(watch.code).toMatchObject({ state: "up-to-date", repo, branch: "main", scanCommit: head, mainCommit: head, behind: 0 });
    expect(watch.content.state).toBe("up-to-date");
    expect(rescanned).toEqual([]);
    expect(srv.app.jobs.lastResult?.message ?? "").not.toMatch(/changed on the site/);
  });

  it("rescans only the pages that loaded a changed script", async () => {
    write("blocks/cards/cards.js", `document.addEventListener("DOMContentLoaded", () => { document.body.dataset.cards = "1"; });\n`);
    const sha = push("cards script");
    deploy();
    const { watch, rescanned } = await check();
    expect(watch.code).toMatchObject({ state: "updating", behind: 1, pages: 1, mainCommit: sha });
    expect(rescanned).toEqual(["/cards.html"]);
    const again = await check();
    expect(again.watch.code).toMatchObject({ state: "up-to-date", scanCommit: sha, behind: 0 });
    expect(again.rescanned).toEqual([]);
  }, 60_000);

  it("waits for the site to serve a stylesheet, then rescans only the pages it reaches", async () => {
    write("styles/styles.css", FILES["styles/styles.css"].replace(".hero { color: red; }", ".hero { color: blue; }"));
    const sha = push("hero color");
    const waiting = await check();
    expect(waiting.watch.code).toMatchObject({ state: "waiting", behind: 1, mainCommit: sha });
    expect(waiting.watch.code.message).toContain("/styles/styles.css");
    expect(waiting.rescanned).toEqual([]);

    deploy();
    const { watch, rescanned } = await check();
    expect(watch.code).toMatchObject({ state: "updating", pages: 1 });
    expect(rescanned).toEqual(["/index.html"]);
    // The other pages only record the stylesheet the site serves now.
    const now = await servedHash("styles/styles.css");
    for (const u of PAGES) expect(sheetHash(u, "/styles/styles.css")).toBe(now);

    const again = await check();
    expect(again.watch.code).toMatchObject({ state: "up-to-date", scanCommit: sha, behind: 0 });
    expect(again.rescanned).toEqual([]);
  }, 60_000);

  it("rescans a page edited on the site, once", async () => {
    edits.set("/about", Math.floor(Date.now() / 1000) + 1);
    const { watch, rescanned } = await check();
    expect(watch.content).toMatchObject({ state: "updating", pages: 1 });
    expect(rescanned).toEqual(["/about.html"]);
    const again = await check();
    expect(again.watch.content.state).toBe("up-to-date");
    expect(again.rescanned).toEqual([]);
  }, 60_000);

  it("rescans the pages that show an edited nav", async () => {
    fs.writeFileSync(path.join(site, "nav.plain.html"), `<nav><a href="/">Home</a> <a href="/cards">Cards</a></nav>`);
    navModified = Date.now() + 1000;
    const { watch, rescanned } = await check();
    expect(watch.content).toMatchObject({ state: "updating", pages: 2 });
    expect(rescanned.sort()).toEqual(["/cards.html", "/index.html"]);
    const again = await check();
    expect(again.rescanned).toEqual([]);
    expect(again.watch.code.state).toBe("up-to-date");
  }, 60_000);

  it("records the new stylesheet for a paused group's pages without rescanning them", async () => {
    const g = await api("POST", "/groups", { name: "Library", source: { type: "paste" }, urls: [LIB], scan: true });
    await srv.app.jobs.idle();
    await api("PATCH", `/groups/${g.id}`, { active: false });
    expect((await check()).watch.code.state).toBe("up-to-date");
    const at = () => srv.app.index()!.pages.find((p) => p.url === LIB)!.capturedAt;
    const was = at();
    write("tools/library/library.css", `.library { color: green; }\n`);
    const sha = push("library color");
    deploy();
    const { watch, rescanned } = await check();
    expect(watch.code.state).toBe("updating");
    expect(rescanned).toEqual([]);
    expect(at()).toBe(was);
    // The editor compares tools/library/library.css with this copy: it matches the deployed branch now.
    const now = await servedHash("tools/library/library.css");
    expect(sheetHash(LIB, "/tools/library/library.css")).toBe(now);
    expect(srv.app.index()!.sheets.get("/tools/library/library.css")?.hash).toBe(now);
    const again = await check();
    expect(again.watch.code).toMatchObject({ state: "up-to-date", scanCommit: sha, behind: 0 });
  }, 60_000);

  it("can be turned off", async () => {
    const st = await api("PUT", "/watch", { enabled: false });
    expect(st.watch.enabled).toBe(false);
    const { watch } = await check();
    expect(watch.code.state).toBe("off");
    expect(watch.content.state).toBe("off");
    await expect(api("PUT", "/watch", { intervalSec: "soon" })).rejects.toThrow(/400/);
  });
});
