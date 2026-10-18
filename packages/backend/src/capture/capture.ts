// Capture (§5): load every page in headless Chromium, settle it, evaluate all
// relaxed site selectors natively, and record what L0/L1/L2 need. Writes a new
// index revision and publishes it atomically.

import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, sep } from "node:path";
import fg from "fast-glob";
import { fileForUrlPath, type CbrConfig, type Profile, type Recipe } from "../config.js";
import { blobId } from "../daemon/diffBase.js";
import { parseStylesheet, usageKeysFor, type StylesheetModel } from "../css/model.js";
import { analyzeComplex } from "../css/selectors.js";
import { IndexBuilder, SiteIndex, type PagePatch } from "../index/siteIndex.js";
import type { PageRow, Store, VariantInfo } from "../index/store.js";
import { decodeTree, firstMatch, type CompactTree } from "../l1/tree.js";
import { assetKey, openShell } from "../l2/shell.js";
import { BOXES_SCRIPT, COLLECT_SCRIPT, INIT_SCRIPT, SETTLE_SCRIPT, evalSelectorsScript } from "./inPage.js";

export interface CaptureProgress {
  done: number;
  total: number;
  url: string;
  ok: boolean;
}

export interface CaptureOptions {
  /** Recapture only these page paths, carrying the rest forward. */
  urls?: string[];
  onProgress?: (p: CaptureProgress) => void;
  signal?: AbortSignal;
  /** Revisions still being read (e.g. by a running daemon): not pruned. */
  keep?: number[];
  /** Partial runs: carried-forward pages whose recorded files change. */
  patches?: PagePatch[];
  /** Partial runs: stylesheet key → its new captured content hash. */
  sheets?: Record<string, string>;
}

export interface CaptureResult {
  revision: number;
  pages: number;
  captured: number;
  failed: number;
  durationMs: number;
  notes: Record<string, unknown>;
}

interface Collected {
  quirks: boolean;
  lang?: string;
  dir?: string;
  links: string[];
  inline: string[];
  adopted: string[];
  tokens: string[];
  runtime: string[];
  styles: string[];
  tree: CompactTree["n"];
  shell: string;
  boxes: number[];
}

interface SheetInfo {
  key: string;
  hash: string;
  model: StylesheetModel;
  /** Valid relaxed selector keys of the sheet (deduped). */
  keys: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".xml": "application/xml",
};

const RECORDED_TYPES = new Set(["stylesheet", "image", "font"]);

export function buildVariants(cfg: CbrConfig): Array<VariantInfo & { profileDef: Profile; recipeDef?: Recipe }> {
  const out: Array<VariantInfo & { profileDef: Profile; recipeDef?: Recipe }> = [];
  for (const p of cfg.profiles) out.push({ id: out.length, name: p.name, profile: p.name, profileDef: p });
  for (const r of cfg.recipes) {
    const p = cfg.profiles.find((x) => x.name === r.profile) ?? cfg.profiles[0];
    out.push({ id: out.length, name: `${p.name}+${r.name}`, profile: p.name, recipe: r.name, profileDef: p, recipeDef: r });
  }
  return out;
}

export async function discoverUrls(cfg: CbrConfig): Promise<string[]> {
  if (cfg.urls?.length) return [...new Set(cfg.urls)].sort();
  if (cfg.siteRoot) {
    const files = await fg("**/*.{html,htm}", {
      cwd: cfg.siteRoot,
      ignore: ["**/node_modules/**", "**/.git/**", "**/.css-blast-radius/**"],
      dot: false,
    });
    return files.map((f) => "/" + f.split(sep).join("/")).sort();
  }
  if (cfg.baseUrl) {
    const res = await fetch(new URL("/sitemap.xml", cfg.baseUrl));
    if (!res.ok) throw new Error(`no urls configured and ${res.url} returned ${res.status}`);
    const xml = await res.text();
    const out = new Set<string>();
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const u = new URL(m[1], cfg.baseUrl);
      if (u.origin === cfg.origin) out.add(u.pathname + u.search);
    }
    return [...out].sort();
  }
  return [];
}

/** Index key of a stylesheet URL: the path for same-origin sheets, else the URL. */
export function sheetKey(cfg: CbrConfig, absUrl: string): string {
  try {
    const u = new URL(absUrl);
    return u.origin === cfg.origin ? u.pathname : assetKey(absUrl);
  } catch {
    return absUrl;
  }
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sampled(s: string, rate: number): boolean {
  return rate >= 1 || (rate > 0 && fnv(s) % 10_000 < rate * 10_000);
}

function importUrls(model: StylesheetModel, base: string): string[] {
  const out: string[] = [];
  for (const params of model.imports) {
    const m = /^(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/.exec(params);
    if (!m) continue;
    try {
      out.push(new URL(m[1], base).href);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Splits an inline style attribute into declarations (good enough for usage keys). */
function inlineDecls(style: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of style.split(/;(?![^(]*\))/)) {
    const i = part.indexOf(":");
    if (i > 0) out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

export class Capturer {
  private browser?: Browser;
  private readonly sheetCache = new Map<string, SheetInfo>();
  private readonly variants;
  private unsupportedSyntax = 0;
  private readonly fidelity: number[] = [];

  constructor(
    private readonly cfg: CbrConfig,
    private readonly store: Store,
  ) {
    this.variants = buildVariants(cfg);
  }

  async run(opts: CaptureOptions = {}): Promise<CaptureResult> {
    const t0 = Date.now();
    const discovered = await discoverUrls(this.cfg);
    const prev = opts.urls ? SiteIndex.load(this.store) : undefined;
    const sameVariants = prev && JSON.stringify(prev.variants) === JSON.stringify(this.variants.map(({ id, name, profile, recipe }) => ({ id, name, profile, ...(recipe ? { recipe } : {}) })));
    const partial = !!(opts.urls && prev && sameVariants);
    const targets = partial ? [...new Set(opts.urls)] : discovered;
    const builder = new IndexBuilder(
      this.variants.map(({ id, name, profile, recipe }) => ({ id, name, profile, ...(recipe ? { recipe } : {}) })),
      partial ? targets : discovered,
      partial ? prev : undefined,
    );
    const rev = this.store.createRevision(partial ? "partial" : "full", builder.variants);
    if (partial) {
      for (const p of opts.patches ?? []) builder.patchPage(p);
      for (const [key, hash] of Object.entries(opts.sheets ?? {})) builder.setSheetHash(key, hash);
    }

    let failed = 0;
    let done = 0;
    try {
      if (targets.length) {
        this.browser = await chromium.launch({ headless: true });
        const contexts = new Map<string, BrowserContext>();
        for (const v of this.variants) {
          if (contexts.has(v.profile)) continue;
          contexts.set(v.profile, await this.newContext(v.profileDef));
        }
        const queue = [...targets];
        const worker = async () => {
          for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
            if (opts.signal?.aborted) throw new Error("capture cancelled");
            const ok = await this.capturePage(url, builder, contexts);
            if (!ok) failed++;
            opts.onProgress?.({ done: ++done, total: targets.length, url, ok });
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, this.cfg.capture.concurrency) }, worker));
      }
      const notes = {
        durationMs: Date.now() - t0,
        captured: targets.length,
        failed,
        chromium: this.browser?.version() ?? null,
        unsupportedSyntaxChecks: this.unsupportedSyntax,
        fidelity: this.fidelity.length
          ? { sampled: this.fidelity.length, min: Math.min(...this.fidelity), mean: this.fidelity.reduce((a, b) => a + b, 0) / this.fidelity.length }
          : null,
        mode: this.cfg.siteRoot ? "root" : "live",
      };
      builder.publish(this.store, rev, notes);
      this.store.pruneRevisions([rev, ...(prev ? [prev.revision.id] : []), ...(opts.keep ?? [])]);
      return { revision: rev, pages: builder.size, captured: targets.length, failed, durationMs: Date.now() - t0, notes };
    } catch (err: any) {
      this.store.failRevision(rev, String(err?.message ?? err));
      throw err;
    } finally {
      await this.browser?.close().catch(() => {});
      this.browser = undefined;
    }
  }

  private newContext(p: Profile): Promise<BrowserContext> {
    return newProfileContext(this.browser!, p);
  }

  private async capturePage(url: string, builder: IndexBuilder, contexts: Map<string, BrowserContext>): Promise<boolean> {
    const id = builder.id(url);
    const row: PageRow = {
      id,
      url,
      status: "ok",
      quirks: false,
      trees: {},
      shells: {},
      assets: {},
      loaded: {},
      capturedAt: new Date().toISOString(),
    };
    const notes: string[] = [];
    for (const v of this.variants) {
      if (v.recipeDef?.urls && !new RegExp(v.recipeDef.urls).test(url)) continue;
      try {
        await this.captureVariant(url, id, v, contexts.get(v.profile)!, builder, row);
      } catch (err: any) {
        const msg = String(err?.message ?? err).split("\n")[0];
        if (v.recipe) notes.push(`${v.name}: ${msg}`);
        else {
          row.status = "failed";
          row.error = msg;
          break;
        }
      }
    }
    if (notes.length) row.error = notes.join("; ");
    builder.setPage(row);
    return row.status === "ok";
  }

  private async captureVariant(
    url: string,
    id: number,
    v: (typeof this.variants)[number],
    ctx: BrowserContext,
    builder: IndexBuilder,
    row: PageRow,
  ): Promise<void> {
    const cfg = this.cfg;
    const full = new URL(url, cfg.origin).href;
    const page = await ctx.newPage();
    const cssTexts = new Map<string, string>();
    try {
      await page.route("**/*", (route) => this.serve(route, row, cssTexts));
      const resp = await page.goto(full, { waitUntil: "load", timeout: cfg.capture.timeoutMs });
      if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp?.status() ?? "no response"}`);
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
      await page.evaluate(SETTLE_SCRIPT);
      if (v.recipeDef) {
        await runRecipe(page, v.recipeDef);
        await page.evaluate(SETTLE_SCRIPT);
      }
      const c = (await page.evaluate(COLLECT_SCRIPT)) as Collected;

      // Stylesheets → models → the relaxed selectors this page must evaluate.
      const sheets: SheetInfo[] = [];
      const seen = new Set<string>();
      const addSheet = (absUrl: string | undefined, text: string, depth: number) => {
        const key = absUrl ? sheetKey(cfg, absUrl) : `inline:${createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
        if (seen.has(key) || depth > 8) return;
        seen.add(key);
        const info = this.sheet(key, text);
        sheets.push(info);
        if (absUrl) builder.addSheet(key, info.hash, id);
        for (const imp of importUrls(info.model, absUrl ?? full)) {
          const t = cssTexts.get(assetKey(imp));
          if (t !== undefined) addSheet(imp, t, depth + 1);
        }
      };
      for (const href of c.links) {
        const t = cssTexts.get(assetKey(href));
        if (t !== undefined) addSheet(href, t, 0);
        else builder.addSheet(sheetKey(cfg, href), undefined, id);
      }
      for (const t of [...c.inline, ...c.adopted]) addSheet(undefined, t, 0);

      const keySet = new Set<string>();
      for (const s of sheets) for (const k of s.keys) keySet.add(k);
      const keys = [...keySet];
      const statuses = keys.length ? ((await page.evaluate(evalSelectorsScript(keys))) as string) : "";
      const status = new Map<string, number>();
      for (let i = 0; i < keys.length; i++) {
        const st = statuses.charCodeAt(i) - 48;
        status.set(keys[i], st);
        builder.addSelectorResult(keys[i], v.id, id, st);
      }

      for (const t of c.tokens) builder.addToken(t, id);
      for (const cls of c.runtime) builder.addRuntimeToken("c:" + cls, id);
      const uses = new Set<string>();
      for (const s of sheets) {
        for (const r of s.model.rules) {
          if (r.invalid || r.uses.length === 0) continue;
          if (!r.complex.some((cx) => status.get(cx.key) === 1)) continue;
          for (const u of r.uses) uses.add(u);
        }
      }
      for (const style of c.styles) {
        for (const [prop, value] of inlineDecls(style)) for (const u of usageKeysFor(prop, value)) uses.add(u);
      }
      // A used @keyframes / @position-try uses what its declarations use (e.g. var(--x)).
      const defs = sheets.flatMap((s) => s.model.defs).filter((d) => d.uses.length);
      for (let grew = true; grew; ) {
        grew = false;
        for (const d of defs) {
          if (!uses.has(d.usageKey)) continue;
          for (const u of d.uses) if (!uses.has(u)) (uses.add(u), (grew = true));
        }
      }
      for (const u of uses) builder.addUsage(u, id);

      const tree: CompactTree = { v: 1, quirks: c.quirks, lang: c.lang, dir: c.dir, n: c.tree };
      row.trees[v.id] = this.store.putBlob(JSON.stringify(tree));
      row.shells[v.id] = this.store.putBlob(c.shell);
      if (v.id === 0) {
        row.quirks = c.quirks;
        row.lang = c.lang;
      }

      this.crossCheck(url, tree, keys, status, builder);

      if (sampled(`fid:${url}:${v.id}`, cfg.capture.fidelitySample)) {
        const f = await this.checkFidelity(ctx, full, c, row);
        row.fidelity = Math.min(row.fidelity ?? 1, f);
        this.fidelity.push(f);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  private sheet(key: string, text: string): SheetInfo {
    const hash = createHash("sha256").update(text).digest("hex");
    const cached = this.sheetCache.get(hash);
    if (cached) return { ...cached, key };
    this.store.putBlob(text);
    const model = parseStylesheet(text);
    const keys = new Set<string>();
    for (const r of model.rules) {
      if (r.invalid) continue;
      for (const cx of r.complex) if (!cx.unanalyzable && !cx.invalid) keys.add(cx.key);
    }
    const info = { key, hash, model, keys: [...keys] };
    this.sheetCache.set(hash, info);
    return info;
  }

  /** Serves a request (disk in root mode, network in live mode) and records it. */
  private async serve(route: Route, row: PageRow, cssTexts: Map<string, string>): Promise<void> {
    const req = route.request();
    const url = assetKey(req.url());
    const r = await serveSite(this.cfg, route);
    if (!r) return;
    const type = req.resourceType();
    if (r.status < 400 && type !== "document") {
      try {
        const u = new URL(url);
        if (u.origin === this.cfg.origin) row.loaded![u.pathname] = blobId(r.body);
      } catch {
        /* not a URL */
      }
    }
    if (r.status < 400 && (RECORDED_TYPES.has(type) || r.ct.includes("text/css"))) {
      row.assets[url] = `${this.store.putBlob(r.body)} ${r.ct}`;
      if (type === "stylesheet" || r.ct.includes("text/css")) cssTexts.set(url, r.body.toString("utf8"));
    }
  }

  /**
   * L1 matcher cross-check (§5.3 step 5): every selector Chromium matched
   * must match on the tree; a sample of non-matches must not. Features of a
   * disagreeing selector are marked unsupported for L1.
   */
  private crossCheck(url: string, tree: CompactTree, keys: string[], status: Map<string, number>, builder: IndexBuilder): void {
    const decoded = decodeTree(tree);
    for (const key of keys) {
      const st = status.get(key);
      if (st === 2) continue;
      if (st === 0 && !sampled(`mx:${url}:${key}`, this.cfg.capture.matcherSample)) continue;
      let hit: boolean;
      try {
        hit = firstMatch(decoded, key) !== null;
      } catch {
        this.unsupportedSyntax++;
        continue;
      }
      const agree = hit === (st === 1);
      for (const f of analyzeComplex(key).features.length ? analyzeComplex(key).features : ["simple"]) {
        builder.addMatcherCheck(f, agree, agree ? undefined : `${key} on ${url}: chromium=${st === 1} l1=${hit}`);
      }
    }
  }

  /** Renders the shell like L2 does and compares element boxes with the live page. */
  private async checkFidelity(ctx: BrowserContext, full: string, c: Collected, row: PageRow): Promise<number> {
    const page = await ctx.newPage();
    try {
      await openShell(page, this.store, { url: full, html: c.shell, assets: row.assets });
      const boxes = (await page.evaluate(BOXES_SCRIPT)) as number[];
      if (boxes.length !== c.boxes.length) return 0;
      let same = 0;
      for (let i = 0; i < boxes.length; i += 4) {
        let ok = true;
        for (let k = 0; k < 4; k++) if (Math.abs(boxes[i + k] - c.boxes[i + k]) > 1) ok = false;
        if (ok) same++;
      }
      return boxes.length ? same / (boxes.length / 4) : 1;
    } catch {
      return 0;
    } finally {
      await page.close().catch(() => {});
    }
  }
}

/** A browser context with the capture policy (§5.1) for one profile. */
export async function newProfileContext(browser: Browser, p: Profile, opts: { initScript?: boolean } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: p.width, height: p.height },
    deviceScaleFactor: p.deviceScaleFactor ?? 1,
    isMobile: p.isMobile ?? false,
    hasTouch: p.isMobile ?? false,
    userAgent: p.userAgent,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    colorScheme: "light",
    serviceWorkers: "block",
  });
  if (opts.initScript !== false) await ctx.addInitScript({ content: INIT_SCRIPT });
  return ctx;
}

/**
 * Answers a request from the site: files under siteRoot in root mode
 * (other origins aborted), the network in live mode. Returns what was served.
 */
export async function serveSite(cfg: CbrConfig, route: Route): Promise<{ body: Buffer; ct: string; status: number } | undefined> {
  const url = assetKey(route.request().url());
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    await route.abort();
    return undefined;
  }
  try {
    if (cfg.siteRoot) {
      if (u.origin !== cfg.origin) {
        await route.abort();
        return undefined;
      }
      const file = fileForUrlPath(cfg, u.pathname);
      if (!file || !existsSync(file)) {
        await route.fulfill({ status: 404, body: "not found" });
        return undefined;
      }
      const body = await readFile(file);
      const ct = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      await route.fulfill({ status: 200, headers: { "content-type": ct }, body });
      return { body, ct, status: 200 };
    }
    const resp = await route.fetch();
    const body = await resp.body();
    await route.fulfill({ response: resp, body });
    return { body, ct: resp.headers()["content-type"] ?? "", status: resp.status() };
  } catch {
    await route.abort().catch(() => {});
    return undefined;
  }
}

export async function runRecipe(page: Page, r: Recipe): Promise<void> {
  for (const s of r.steps) {
    if (s.click) await page.click(s.click, { timeout: 5_000 });
    if (s.hover) await page.hover(s.hover, { timeout: 5_000 });
    if (s.fill) await page.fill(s.fill[0], s.fill[1], { timeout: 5_000 });
    if (s.press) await page.keyboard.press(s.press);
    if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 5_000 });
    if (s.waitMs) await page.waitForTimeout(s.waitMs);
  }
}
