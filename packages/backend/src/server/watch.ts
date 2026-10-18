// Keeps the scan equal to the live site without a CI/CD hook. Every minute the
// server asks git whether the branch the site is deployed from moved, and asks
// the site (/query-index.json) which pages authors edited. It then rescans just
// the pages a change reaches:
//  - a stylesheet change goes through the blast-radius engine; pages it doesn't
//    reach only get the new file recorded (no browser);
//  - any other file a page loaded (scripts, blocks, images, head.html) rescans
//    the pages that loaded it;
//  - an edited page, or a fragment it loaded (/nav, /footer…), rescans it.
// Code is only rescanned once the site serves the new files.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { CbrConfig } from "../config.js";
import { diffModels } from "../css/diff.js";
import { browserModel } from "../css/model.js";
import { blobId } from "../daemon/diffBase.js";
import { L0Engine, L1Cache } from "../engine/l0.js";
import type { PagePatch, SiteIndex } from "../index/siteIndex.js";
import type { PageRow, Store } from "../index/store.js";
import type { L1Pool } from "../l1/pool.js";
import type { WatchStatus } from "../rpc/protocol.js";
import { PageSet } from "../util/pageSet.js";
import type { Jobs } from "./jobs.js";
import { watchSettings, type SiteSettings } from "./settings.js";

const exec = promisify(execFile);

export interface WatchHost {
  store: Store;
  pool: L1Pool;
  jobs: Jobs;
  index(): SiteIndex | undefined;
  settings(): SiteSettings;
  config(): CbrConfig;
  /** Folders of the editor's projects, most recently opened first. */
  projectRoots(): string[];
  /** Pages of active groups (paused groups aren't kept up to date). */
  activeUrls(): Set<string>;
  /** The status changed. */
  changed(status: WatchStatus): void;
  log(msg: string): void;
}

interface Repo {
  top: string;
  remote?: string;
  branch: string;
  /** Where the branch is fetched to: refs/remotes/<remote>/<branch>. */
  ref: string;
  /** For talking to the remote: never prompts for a password. */
  env: NodeJS.ProcessEnv;
}

type CodeStatus = WatchStatus["code"];
type ContentStatus = WatchStatus["content"];

interface CodeResult {
  status: CodeStatus;
  sha?: string;
  /** Page → the file that changed for it. */
  rescan: Map<string, string>;
  patches: PagePatch[];
  sheets: Record<string, string>;
}

interface ContentResult {
  status: ContentStatus;
  /** Page → when the edit that reached it was made (ms). */
  rescan: Map<string, number>;
}

/** Pages that load one version of one stylesheet. */
interface CssGroup {
  key: string;
  path: string;
  /** The page's recorded path (as served, percent-encoded). */
  pathname: string;
  oldHash: string;
  pages: PageRow[];
  /** Page id → the asset URLs it loaded the file under. */
  urls: Map<number, string[]>;
}

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

async function git(cwd: string, args: string[], timeoutMs = 30_000, env = GIT_ENV): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV, timeout: 30_000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" });
  return stdout;
}

const tryGit = (cwd: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<string | undefined> =>
  git(cwd, args, timeoutMs, env).then(
    (s) => s.trim(),
    () => undefined,
  );

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const short = (sha: string | undefined) => sha?.slice(0, 7);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const message = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0];

/** EDS preview/live hosts: <branch>--<repo>--<owner>.aem.page */
const EDS_HOST = /^([a-z0-9-]+)--([a-z0-9-]+)--([a-z0-9-]+)\.(?:aem|hlx)\.(?:page|live)$/i;

/** A same-site URL → its file path in the repository ("styles/a.css") and as served. */
function sitePath(url: string, origin: string): { path: string; pathname: string } | undefined {
  try {
    const u = new URL(url, origin);
    if (u.origin !== origin) return undefined;
    return { path: decodePath(u.pathname), pathname: u.pathname };
  } catch {
    return undefined;
  }
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return pathname.replace(/^\/+/, "");
  }
}

/** A page's path as the query index lists it: no query, no .html, no trailing slash. */
export function indexPath(url: string): string {
  let p = url.replace(/[?#].*$/, "");
  try {
    p = new URL(p, "http://x").pathname;
  } catch {
    /* keep */
  }
  p = p.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** lastModified: unix seconds (EDS), milliseconds, or a date. */
function toMs(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined;
  if (n !== undefined) return n > 0 ? (n < 1e12 ? n * 1000 : n) : undefined;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

function sitePathUrl(origin: string, path: string): string {
  return `${origin}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function eachLimited<T>(items: Iterable<T>, n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const list = [...items];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (i < list.length) await fn(list[i++]);
    }),
  );
}

export class Watcher {
  status: WatchStatus;
  /** How long code that the site serves differently from git is waited for (CDN caches). */
  settleMs = 90_000;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private running?: Promise<void>;
  private epoch = 0;
  private repo?: Repo;
  /** The last check that found the scan matching the branch. */
  private consistent?: { sha: string; rev: number; status: CodeStatus };
  /** When each branch commit was first seen. */
  private readonly firstSeen = new Map<string, number>();
  private readonly trees = new Map<string, Map<string, string>>();
  private readonly blobHashes = new Map<string, string>();
  private readonly histories = new Map<string, Array<{ sha: string; ms: number }>>();
  private readonly diffs = new Map<string, string[]>();
  private readonly blobsAt = new Map<string, string | undefined>();
  /** `${commit}:${path}` → what the site served once it was settled. */
  private readonly served = new Map<string, Buffer | null>();
  /** Page → the branch commit it was last rescanned for (never twice for one commit). */
  private readonly attempted = new Map<string, string>();
  /** Page → the edit time it was last rescanned for (clock skew can't loop). */
  private readonly handled = new Map<string, number>();
  private sent = "";

  constructor(private readonly host: WatchHost) {
    const w = watchSettings(host.settings());
    this.status = { enabled: w.enabled, intervalSec: w.intervalSec, checking: false, code: { state: "off" }, content: { state: "off" } };
  }

  /** Starts checking on a timer (first check soon after). */
  start(): void {
    this.stopped = false;
    this.soon(5000);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** The site settings changed: forget what was learned (and, for another site, the scan's commit). */
  reset(siteMoved: boolean): void {
    this.epoch++;
    this.repo = undefined;
    this.consistent = undefined;
    this.firstSeen.clear();
    this.served.clear();
    this.attempted.clear();
    this.handled.clear();
    if (siteMoved) for (const k of ["watch_sha", "watch_repo"]) this.host.store.setMeta(k, "");
    const w = watchSettings(this.host.settings());
    this.status = { ...this.status, enabled: w.enabled, intervalSec: w.intervalSec };
    if (!w.enabled) this.status = { ...this.status, checking: false, code: { state: "off" }, content: { state: "off" } };
    this.emit();
    this.soon(2000);
  }

  /** An editor project connected: it may be the site's repository. */
  projectsChanged(): void {
    if (this.status.code.state === "no-repo") this.soon(1000);
  }

  private soon(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    try {
      await this.check();
    } finally {
      this.soon(watchSettings(this.host.settings()).intervalSec * 1000);
    }
  }

  private emit(): void {
    const { checking, checkedAt, ...rest } = this.status;
    const key = JSON.stringify(rest);
    const changed = key !== this.sent;
    this.sent = key;
    this.host.changed(this.status);
    if (changed) this.host.log(`watch: code ${this.status.code.state}${this.status.code.message ? ` (${this.status.code.message})` : ""}; page edits ${this.status.content.state}`);
  }

  /** Checks now (a check already running is awaited instead). */
  check(): Promise<void> {
    this.running ??= this.tick().finally(() => (this.running = undefined));
    return this.running;
  }

  private async tick(): Promise<void> {
    const s = this.host.settings();
    const w = watchSettings(s);
    const st = this.status;
    st.enabled = w.enabled;
    st.intervalSec = w.intervalSec;
    if (!w.enabled) {
      this.status = { ...st, checking: false, code: { state: "off" }, content: { state: "off" } };
      return this.emit();
    }
    if (!s.siteUrl) {
      const msg = "Only a site address (not a folder) can be followed.";
      this.status = { ...st, checking: false, code: { state: "off", message: msg }, content: { state: "off", message: msg } };
      return this.emit();
    }
    const idx = this.host.index();
    if (!idx) {
      const msg = "Scan the site first.";
      this.status = { ...st, checking: false, code: { state: "off", message: msg }, content: { state: "off", message: msg } };
      return this.emit();
    }
    // A scan is running or queued: check once it's done (its pages change).
    if (this.host.jobs.state()) return;

    const epoch = this.epoch;
    st.checking = true;
    this.emit();
    const active = this.host.activeUrls();
    const origin = this.host.config().origin;
    const [content, code] = await Promise.all([
      this.contentCheck(idx, origin, active).catch((err): ContentResult => ({ status: { state: "error", message: message(err) }, rescan: new Map() })),
      this.codeCheck(idx, s, origin, active).catch(
        (err): CodeResult => ({ status: { ...this.repoInfo(), state: "error", message: message(err) }, rescan: new Map(), patches: [], sheets: {} }),
      ),
    ]);
    if (epoch !== this.epoch) {
      // The settings changed meanwhile: the next check (already scheduled) starts over.
      this.status = { ...this.status, checking: false };
      return this.emit();
    }

    const urls = new Set([...content.rescan.keys(), ...code.rescan.keys()]);
    const patches = code.patches.filter((p) => !urls.has(p.url));
    if (urls.size || patches.length) {
      for (const [u, t] of content.rescan) this.handled.set(u, t);
      if (code.sha) for (const u of code.rescan.keys()) this.attempted.set(u, code.sha);
      const files = [...new Set(code.rescan.values())];
      const why = [
        code.rescan.size ? `${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""} changed on ${code.status.branch}` : "",
        content.rescan.size ? `${plural(content.rescan.size, "page")} edited` : "",
        patches.length ? `${plural(patches.length, "page")} only recorded the new stylesheets` : "",
      ].filter(Boolean);
      this.host.log(`watch: ${why.join("; ")}`);
      this.host.jobs.enqueue({
        kind: "pages",
        urls: [...urls],
        label: urls.size ? `Updating ${plural(urls.size, "page")} that changed on the site` : "Recording the site's new stylesheets",
        doneLabel: "Scan updated for changes on the site",
        patches,
        sheets: code.sheets,
        done: () => this.soon(1000),
      });
    }
    this.status = { ...this.status, checking: false, checkedAt: new Date().toISOString(), code: code.status, content: content.status };
    this.emit();
  }

  private repoInfo(): Pick<CodeStatus, "repo" | "branch"> {
    return this.repo ? { repo: this.repo.top, branch: this.repo.branch } : {};
  }

  // ------------------------------------------------------------- page edits

  private async contentCheck(idx: SiteIndex, origin: string, active: Set<string>): Promise<ContentResult> {
    const entries = await this.queryIndex(origin);
    const scanned = new Set<string>();
    for (const p of idx.pages) scanned.add(indexPath(p.url));

    // Fragments (/nav.plain.html…): the site's date for the file is fresher than the query index's.
    const heads = new Map<string, Promise<number | undefined>>();
    const fragmentTime = async (pathname: string): Promise<number | undefined> => {
      let h = heads.get(pathname);
      if (!h && heads.size < 100) heads.set(pathname, (h = this.lastModified(`${origin}${pathname}`)));
      const listed = entries?.get(indexPath(pathname.slice(0, -".plain.html".length)));
      return Math.max((await h) ?? 0, listed ?? 0) || undefined;
    };
    // Older scans don't list the fragments a page loaded: an edit to any non-page entry may reach it.
    let others: Promise<number> | undefined;
    const othersTime = () =>
      (others ??= (async () => {
        const list = [...(entries ?? new Map<string, number>())].filter(([path]) => !scanned.has(path) && !path.split("/").some((s) => s.startsWith(".")));
        const shared = (path: string) => (/(^|[-/])(nav|header|footer|fragments?)([-/]|$)/i.test(path) ? 0 : 1);
        list.sort((a, b) => shared(a[0]) - shared(b[0]));
        let t = Math.max(0, ...list.map(([, ms]) => ms));
        await eachLimited(list.slice(0, 50), 6, async ([path]) => {
          t = Math.max(t, (await fragmentTime(`${path}.plain.html`)) ?? 0);
        });
        return t;
      })());

    const rescan = new Map<string, number>();
    for (const p of idx.pages) {
      if (p.status === "removed" || !active.has(p.url)) continue;
      const at = Date.parse(p.capturedAt);
      const edits: Array<number | undefined> = [entries?.get(indexPath(p.url))];
      if (p.loaded) {
        const frags = Object.keys(p.loaded).filter((path) => path.endsWith(".plain.html"));
        edits.push(...(await Promise.all(frags.map(fragmentTime))));
      } else if (entries) edits.push(await othersTime());
      const t = Math.max(0, ...edits.filter((x): x is number => x !== undefined));
      if (t > at && (this.handled.get(p.url) ?? 0) < t) rescan.set(p.url, t);
    }
    if (rescan.size) return { status: { state: "updating", pages: rescan.size, message: `Rescanning ${plural(rescan.size, "page")} edited on the site` }, rescan };
    if (!entries) {
      return { status: { state: "unavailable", message: "The site has no /query-index.json, so edits to pages aren't followed (fragments are)." }, rescan };
    }
    return { status: { state: "up-to-date", message: `Following ${plural(entries.size, "page")} in /query-index.json` }, rescan };
  }

  /** The site's query index: page path → last edit (ms); undefined when the site has none. */
  private async queryIndex(origin: string): Promise<Map<string, number> | undefined> {
    const out = new Map<string, number>();
    let offset = 0;
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${origin}/query-index.json?offset=${offset}&limit=500`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`/query-index.json: HTTP ${res.status}`);
      let json: any;
      try {
        json = await res.json();
      } catch {
        if (i === 0) return undefined; // not JSON: the site has no index
        throw new Error("/query-index.json isn't valid JSON");
      }
      const sheet = Array.isArray(json?.data) ? json : (json?.default ?? json?.[json?.[":names"]?.[0]]);
      const rows: any[] | undefined = Array.isArray(sheet?.data) ? sheet.data : undefined;
      if (!rows) return i === 0 ? undefined : out;
      for (const r of rows) {
        const ms = toMs(r?.lastModified);
        if (typeof r?.path !== "string" || ms === undefined) continue;
        const key = indexPath(r.path);
        out.set(key, Math.max(out.get(key) ?? 0, ms));
      }
      offset += rows.length;
      const total = Number(sheet.total);
      if (!rows.length || !Number.isFinite(total) || offset >= total) break;
    }
    return out;
  }

  private async lastModified(url: string): Promise<number | undefined> {
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const lm = res.ok ? res.headers.get("last-modified") : null;
      return lm ? toMs(lm) : undefined;
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------- code

  private async codeCheck(idx: SiteIndex, s: SiteSettings, origin: string, active: Set<string>): Promise<CodeResult> {
    const none = { rescan: new Map<string, string>(), patches: [], sheets: {} };
    if (!this.repo) {
      const found = await this.findRepo(s);
      if (typeof found === "string") return { ...none, status: { state: "no-repo", message: found } };
      this.repo = found;
    }
    const repo = this.repo;
    const info = this.repoInfo();
    const { sha: T, offline } = await this.branchHead(repo);
    const note = offline ? { message: `Couldn't reach ${repo.remote}; using what was last fetched.` } : {};
    if (!this.firstSeen.has(T)) {
      if (this.firstSeen.size > 100) this.firstSeen.clear();
      this.firstSeen.set(T, Date.now());
    }
    const memo = this.consistent;
    if (memo && memo.sha === T && memo.rev === idx.revision.id) return { ...none, sha: T, status: { ...memo.status, ...note } };

    const tree = await this.treeOf(repo.top, T);
    const pages = idx.pages.filter((p) => p.status === "ok" && active.has(p.url));
    const css = new Map<string, CssGroup>();
    /** Repo path → pages to rescan when the site changed it, with what each page recorded (when known). */
    const other = new Map<string, Array<{ page: PageRow; was?: string }>>();
    const addOther = (path: string, page: PageRow, was?: string) => {
      let list = other.get(path);
      if (!list) other.set(path, (list = []));
      list.push({ page, was });
    };
    let mapped = false;
    let example: string | undefined;
    const head = tree.get("head.html");

    for (const page of pages) {
      const cssPaths = new Set<string>();
      const assetPaths = new Set<string>();
      for (const [url, val] of Object.entries(page.assets)) {
        const sp = sitePath(url, origin);
        if (!sp) continue;
        assetPaths.add(sp.path);
        const cut = val.indexOf(" ");
        if (!val.slice(cut + 1).includes("text/css")) continue;
        cssPaths.add(sp.path);
        example ??= sp.path;
        const blob = tree.get(sp.path);
        if (!blob) continue;
        mapped = true;
        const hash = val.slice(0, cut);
        if ((await this.blobHash(repo.top, blob)) === hash) continue;
        const gk = `${sp.path}\n${hash}`;
        let g = css.get(gk);
        if (!g) css.set(gk, (g = { key: idx.sheetKey(sp.pathname) ?? sp.pathname, path: sp.path, pathname: sp.pathname, oldHash: hash, pages: [], urls: new Map() }));
        const list = g.urls.get(page.id);
        if (list) list.push(url);
        else {
          g.urls.set(page.id, [url]);
          g.pages.push(page);
        }
      }
      if (page.loaded) {
        for (const [pathname, was] of Object.entries(page.loaded)) {
          const path = decodePath(pathname);
          if (cssPaths.has(path) || path.endsWith(".css")) continue;
          const now = tree.get(path);
          if (!now) continue;
          mapped = true;
          if (now !== was) addOther(path, page, was);
        }
      }
      const S = await this.commitAt(repo.top, T, Date.parse(page.capturedAt));
      if (!page.loaded && S && S !== T) {
        // An older scan doesn't list what the page loaded: go by what changed in git since.
        for (const f of await this.changedSince(repo.top, S, T)) {
          if (f.endsWith(".css")) continue;
          const block = /^blocks\/([^/]+)\//.exec(f);
          const hit = f.startsWith("scripts/") || (block ? [...cssPaths].some((c) => c.startsWith(`blocks/${block[1]}/`)) : assetPaths.has(f));
          if (hit) addOther(f, page);
        }
      }
      // head.html is part of every page but isn't loaded on its own: compare with the version at the scan's time.
      if (head && S && S !== T) {
        const was = await this.blobAt(repo.top, S, "head.html");
        if (was && was !== head) addOther("head.html", page);
      }
    }
    if (example && !mapped) {
      return { ...none, status: { ...info, state: "no-repo", message: `The site's files (e.g. /${example}) aren't in ${repo.top}.` } };
    }

    // Only act once the site serves the new files (CDN caches can lag behind git).
    const settled = Date.now() - this.firstSeen.get(T)! >= this.settleMs;
    const served = new Map<string, Buffer | null>();
    const waiting: string[] = [];
    const paths = new Set([...[...css.values()].map((g) => g.path), ...other.keys()]);
    await eachLimited(paths, 6, async (path) => {
      const key = `${T}:${path}`;
      let body = this.served.get(key);
      if (body === undefined) {
        body = await this.fetchFile(origin, path);
        const fresh = body !== null && blobId(body) === tree.get(path);
        if (!fresh && !settled) {
          waiting.push(path);
          return;
        }
        if (this.served.size > 2000) this.served.clear();
        this.served.set(key, body);
      }
      served.set(path, body);
    });
    const behind = await this.behind(repo.top, T, pages);
    const base = { ...info, ...behind, mainCommit: T };
    if (waiting.length) {
      waiting.sort();
      const more = waiting.length > 1 ? ` and ${plural(waiting.length - 1, "other file")}` : "";
      return { ...none, sha: T, status: { ...base, state: "waiting", message: `Waiting for the site to serve the new /${waiting[0]}${more}`, ...note } };
    }

    const rescan = new Map<string, string>();
    for (const [path, list] of other) {
      const body = served.get(path);
      const now = body ? blobId(body) : undefined;
      for (const { page, was } of list) {
        // The site still serves what the page recorded (it doesn't serve git's file as is).
        if (path !== "head.html" && was !== undefined && now === was) continue;
        if (!rescan.has(page.url)) rescan.set(page.url, `/${path}`);
      }
    }
    const patches = new Map<string, PagePatch>();
    const sheets: Record<string, string> = {};
    for (const g of css.values()) {
      const body = served.get(g.path);
      if (!body) {
        for (const p of g.pages) if (!rescan.has(p.url)) rescan.set(p.url, `/${g.path}`);
        continue;
      }
      const newHash = sha256(body);
      if (newHash === g.oldHash) continue; // the site still serves the scanned version
      this.host.store.putBlob(body);
      const reached = await this.reached(idx, g, body.toString("utf8"));
      const loaded = blobId(body);
      for (const p of g.pages) {
        if (rescan.has(p.url)) continue;
        if (reached.has(p.url)) {
          rescan.set(p.url, `/${g.path}`);
          continue;
        }
        let patch = patches.get(p.url);
        if (!patch) patches.set(p.url, (patch = { url: p.url, assets: {}, loaded: {} }));
        for (const u of g.urls.get(p.id)!) {
          const old = p.assets[u];
          patch.assets![u] = `${newHash} ${old.slice(old.indexOf(" ") + 1)}`;
        }
        patch.loaded![g.pathname] = loaded;
      }
      sheets[g.key] = newHash;
    }
    for (const url of [...rescan.keys()]) {
      if (this.attempted.get(url) !== T) continue;
      this.host.log(`watch: ${url} still differs from ${short(T)} after its rescan; left as is`);
      rescan.delete(url);
    }
    for (const url of rescan.keys()) patches.delete(url);

    if (rescan.size === 0 && patches.size === 0) {
      this.host.store.setMeta("watch_sha", T);
      const status: CodeStatus = { ...info, state: "up-to-date", scanCommit: T, mainCommit: T, behind: 0, ...note };
      this.consistent = { sha: T, rev: idx.revision.id, status: { ...status, message: undefined } };
      return { ...none, sha: T, status };
    }
    const files = [...new Set(rescan.values())];
    const msg = rescan.size
      ? `Rescanning ${plural(rescan.size, "page")} reached by ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` and ${files.length - 2} more` : ""}`
      : "Recording the new stylesheets (no page is reached)";
    return { sha: T, rescan, patches: [...patches.values()], sheets, status: { ...base, state: "updating", pages: rescan.size, message: msg, ...note } };
  }

  /** Pages of the group the stylesheet change reaches (the blast-radius engine, refined by L1). */
  private async reached(idx: SiteIndex, g: CssGroup, newText: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const base = browserModel(this.host.store.getBlob(g.oldHash).toString("utf8"));
      const cur = browserModel(newText);
      const changes = diffModels(base, cur, newText.split("\n").length);
      const l1 = new L1Cache(idx.revision.id, idx.size);
      const scope = PageSet.fromIds(idx.size, g.pages.map((p) => p.id));
      const engine = new L0Engine(idx, this.host.config(), l1, { keysFor: () => [g.key], scope });
      // A page the index doesn't list under this stylesheet can't be judged: rescan it.
      const cand = engine.candidates(g.key).pages;
      for (const p of g.pages) if (!cand.has(p.id)) out.add(p.url);
      let a = engine.analyze(g.key, base, cur, changes);
      for (let round = 0; a.pending.size && round < 4; round++) {
        for (const r of await this.host.pool.resolve(a.pending, idx)) l1.record(r.key, r.checked, r.matched, r.unsupported);
        a = engine.analyze(g.key, base, cur, changes);
      }
      const hit = a.total.exact.or(a.total.possible).or(a.total.unknown);
      for (const pend of a.pending.values()) hit.orInPlace(pend);
      for (const p of g.pages) if (hit.has(p.id)) out.add(p.url);
    } catch (err) {
      this.host.log(`watch: couldn't tell which pages ${g.key} reaches (${message(err)}); rescanning them`);
      for (const p of g.pages) out.add(p.url);
    }
    return out;
  }

  /** What the site serves at `path` now, or null (missing, or unreachable). */
  private async fetchFile(origin: string, path: string): Promise<Buffer | null> {
    try {
      const res = await fetch(sitePathUrl(origin, path), { cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  /** How far the scan is behind the branch (counted from the scan's date when its commit isn't known). */
  private async behind(top: string, T: string, pages: PageRow[]): Promise<Pick<CodeStatus, "behind" | "approx" | "scanCommit">> {
    const known = this.host.store.getMeta("watch_sha") || undefined;
    if (known) {
      const n = await tryGit(top, ["rev-list", "--count", `${known}..${T}`]);
      if (n !== undefined) return { behind: Number(n), scanCommit: known };
    }
    const oldest = Math.min(...pages.map((p) => Date.parse(p.capturedAt)).filter(Number.isFinite));
    const S = Number.isFinite(oldest) ? await this.commitAt(top, T, oldest) : undefined;
    if (!S) return { approx: true };
    const n = await tryGit(top, ["rev-list", "--count", `${S}..${T}`]);
    return { behind: n === undefined ? undefined : Number(n), approx: true, scanCommit: S };
  }

  // -------------------------------------------------------------------- git

  /** The site's repository among the editor's projects: for EDS sites, the one whose remote is <owner>/<repo>. */
  private async findRepo(s: SiteSettings): Promise<Repo | string> {
    const eds = EDS_HOST.exec(new URL(s.siteUrl).hostname);
    const want = eds ? `${eds[3]}/${eds[2]}`.toLowerCase() : undefined;
    const chosen = watchSettings(s).repo;
    const dirs = [...new Set([chosen, this.host.store.getMeta("watch_repo"), ...this.host.projectRoots()].filter((d): d is string => !!d))];
    for (const dir of dirs) {
      const top = await tryGit(dir, ["rev-parse", "--show-toplevel"]);
      if (!top) continue;
      const remotes = ((await tryGit(top, ["remote", "-v"])) ?? "")
        .split("\n")
        .map((l) => /^(\S+)\s+(\S+)/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ name: m[1], url: m[2].toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "") }));
      let remote: string | undefined;
      if (want) {
        remote = remotes.find((r) => r.url.endsWith(`/${want}`) || r.url.endsWith(`:${want}`))?.name;
        if (!remote && dir !== chosen) continue;
      }
      remote ??= remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
      // SSH remotes: fail instead of asking for a passphrase (unless the user set up their own ssh command).
      const ownSsh = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || (await tryGit(top, ["config", "--get", "core.sshCommand"]));
      const env = ownSsh ? GIT_ENV : { ...GIT_ENV, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
      const branch = await this.branchOf(top, remote, eds?.[1], env);
      if (!branch) continue;
      this.host.store.setMeta("watch_repo", top);
      return { top, remote, branch, ref: remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`, env };
    }
    const what = want ? `the ${want} repository` : "the site's repository";
    return `Open ${what} in VS Code once, or enter its folder here, so the server can follow it.`;
  }

  /** The branch the site is deployed from: the EDS host's branch, else the remote's default branch. */
  private async branchOf(top: string, remote: string | undefined, edsRef: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const has = async (ref: string) => (await tryGit(top, ["rev-parse", "-q", "--verify", `${ref}^{commit}`])) !== undefined;
    if (remote && edsRef) {
      const listed = await tryGit(top, ["ls-remote", "--heads", remote, `refs/heads/${edsRef}`], 20_000, env);
      if (listed || (listed === undefined && (await has(`refs/remotes/${remote}/${edsRef}`)))) return edsRef;
    }
    if (remote) {
      const head = await tryGit(top, ["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]);
      if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
      for (const b of ["main", "master"]) if (await has(`refs/remotes/${remote}/${b}`)) return b;
      return undefined;
    }
    for (const b of [edsRef, "main", "master"]) if (b && (await has(`refs/heads/${b}`))) return b;
    return undefined;
  }

  /** The branch's latest commit: asks the remote (cheap) and fetches only when it moved. */
  private async branchHead(repo: Repo): Promise<{ sha: string; offline: boolean }> {
    let remoteSha: string | undefined;
    let offline = false;
    if (repo.remote) {
      const out = await tryGit(repo.top, ["ls-remote", repo.remote, `refs/heads/${repo.branch}`], 20_000, repo.env);
      if (out === undefined) offline = true;
      else remoteSha = out.split(/\s+/)[0] || undefined;
    }
    const local = () => tryGit(repo.top, ["rev-parse", "-q", "--verify", `${repo.ref}^{commit}`]);
    let sha = await local();
    if (remoteSha && remoteSha !== sha) {
      try {
        await git(repo.top, ["fetch", "--no-tags", "-q", repo.remote!, `+refs/heads/${repo.branch}:${repo.ref}`], 120_000, repo.env);
      } catch (err) {
        throw new Error(`Couldn't fetch ${repo.branch}: ${message(err)}`);
      }
      sha = await local();
    }
    if (!sha) throw new Error(`${repo.branch} isn't in ${repo.top}.`);
    return { sha, offline };
  }

  private async treeOf(top: string, sha: string): Promise<Map<string, string>> {
    let tree = this.trees.get(sha);
    if (tree) return tree;
    tree = new Map();
    for (const entry of (await git(top, ["ls-tree", "-r", "-z", "--full-tree", sha])).split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, type, blob] = entry.slice(0, tab).split(" ");
      if (type === "blob") tree.set(entry.slice(tab + 1), blob);
    }
    if (this.trees.size >= 4) this.trees.clear();
    this.trees.set(sha, tree);
    return tree;
  }

  /** sha256 of a git blob's content (what the scan records for a stylesheet). */
  private async blobHash(top: string, blob: string): Promise<string> {
    let h = this.blobHashes.get(blob);
    if (!h) {
      h = sha256(await gitBuffer(top, ["cat-file", "blob", blob]));
      if (this.blobHashes.size > 5000) this.blobHashes.clear();
      this.blobHashes.set(blob, h);
    }
    return h;
  }

  /** The branch's commit at a moment (its own history: merges, not the merged commits). */
  private async commitAt(top: string, T: string, ms: number): Promise<string | undefined> {
    if (!Number.isFinite(ms)) return undefined;
    let list = this.histories.get(T);
    if (!list) {
      const out = (await tryGit(top, ["log", "--first-parent", "--format=%H %ct", "-n", "20000", T])) ?? "";
      list = out
        .split("\n")
        .map((l) => l.split(" "))
        .filter((p) => p.length === 2)
        .map(([sha, ct]) => ({ sha, ms: Number(ct) * 1000 }));
      if (this.histories.size >= 4) this.histories.clear();
      this.histories.set(T, list);
    }
    return list.find((c) => c.ms <= ms)?.sha;
  }

  private async changedSince(top: string, S: string, T: string): Promise<string[]> {
    const key = `${S}..${T}`;
    let files = this.diffs.get(key);
    if (!files) {
      files = ((await tryGit(top, ["diff", "--name-only", "-z", S, T])) ?? "").split("\0").filter(Boolean);
      if (this.diffs.size > 200) this.diffs.clear();
      this.diffs.set(key, files);
    }
    return files;
  }

  private async blobAt(top: string, commit: string, path: string): Promise<string | undefined> {
    const key = `${commit}:${path}`;
    if (!this.blobsAt.has(key)) {
      if (this.blobsAt.size > 2000) this.blobsAt.clear();
      this.blobsAt.set(key, await tryGit(top, ["rev-parse", "-q", "--verify", `${key}`]));
    }
    return this.blobsAt.get(key);
  }
}
