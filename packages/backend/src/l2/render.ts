// L2/L3 (§6.6–6.7): what actually changes on one page. The page is loaded
// once (L2: the stored shell, scripts off, assets from the store; L3: the
// live page with scripts and its recipe), the mapped stylesheet is set to the
// base text and then the edited text through CDP, and both states are
// measured with DOMSnapshot in the same tab. Script edits (§17, J3a) can't be
// swapped in a loaded page: it is loaded fresh for each side instead (see
// measureLoads).

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type { CbrConfig, Profile } from "../config.js";
import { newProfileContext, runRecipe, serveSite, sheetKey } from "../capture/capture.js";
import { SETTLE_SCRIPT } from "../capture/inPage.js";
import type { PageRow, Store, VariantInfo } from "../index/store.js";
import { openShell } from "./shell.js";

export type RenderMode = "shell" | "live";

export interface SheetEdit {
  /** Index stylesheet keys of the edited file (e.g. "/css/components.css"). */
  sheetKeys: string[];
  baseText: string;
  editedText: string;
}

export interface ScriptEdit {
  /** URL paths the edited file is served at (e.g. "/js/app.js"). */
  paths: string[];
  baseText: string;
  editedText: string;
}

export interface MeasureRequest extends Partial<SheetEdit> {
  page: PageRow;
  variant: VariantInfo;
  mode: RenderMode;
  /** Several edited files at once (the diff viewer); overrides sheetKeys/baseText/editedText. */
  edits?: SheetEdit[];
  /** Edited scripts: the page is loaded fresh with its scripts for each side (live mode only). */
  scripts?: ScriptEdit[];
  /** Properties to compare; shorthands are expanded in the page. */
  props: string[];
  screenshots?: boolean;
  maxElements?: number;
  /** Bulk work (impact assessment): waits behind interactive renders. */
  background?: boolean;
  /**
   * The edited rules' selectors and the properties each edit sets: matching
   * elements whose own values for those properties change are changed by the
   * edit itself, not just pushed around by it (the outlines).
   */
  targets?: RenderTarget[];
}

export interface RenderTarget {
  /** A selector querySelectorAll accepts (pseudo-elements removed). */
  selector: string;
  /** The rule styles this pseudo-element of the matched elements. */
  pseudo?: "before" | "after" | "marker";
  props: string[];
}

export interface ElementDiff {
  path: string;
  /** moved: same size, new position; resized: box size changed. */
  kind: "changed" | "moved" | "resized" | "appeared" | "disappeared";
  props: Array<{ prop: string; before: string; after: string }>;
  box?: { before: number[] | null; after: number[] | null };
  /** An ancestor element changed too. */
  nested?: boolean;
}

/** An outermost changed element: what the diff viewer outlines. */
export interface Zone {
  before: number[] | null;
  after: number[] | null;
  label: string;
  props: Array<{ prop: string; before: string; after: string }>;
}

export interface PageDiff {
  url: string;
  variant: string;
  mode: RenderMode;
  status: "changed" | "unchanged" | "inconclusive";
  reason?: string;
  warnings: string[];
  changedElements: number;
  movedElements: number;
  elements: ElementDiff[];
  truncated: boolean;
  comparedProps: string[];
  screenshots?: { before: string; after: string };
  /** Outermost changed elements, top to bottom, in page CSS px. */
  zones: Zone[];
  /** Page width in CSS px and screenshot pixels per CSS px (with screenshots). */
  pageWidth?: number;
  scale?: number;
  /**
   * Content in both versions (with screenshots), to line the two up: 8 numbers
   * per item, its box before then after (x, y, width, height in page CSS px).
   * Text runs and images come first (`anchorLeaves` of them), then elements.
   */
  anchors?: number[];
  anchorLeaves?: number;
  /** Script edits: errors the edited page throws or logs that the base page doesn't, and the reverse. */
  errors?: { added: string[]; fixed: string[] };
  timingMs: number;
}

/** Always compared: rendering on/off. */
const BASE_PROPS = ["display", "visibility"];

/** Used when the edit names no properties (definitions, global changes). */
export const DEFAULT_PROPS = [
  "color", "background-color", "background-image", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "text-decoration-line", "opacity", "transform", "border-top-width", "border-top-color", "border-top-style", "margin-top", "padding-top",
  "width", "height", "animation-name", "content", "list-style-type",
];

const MAX_PROPS = 80;

const EXPAND_SCRIPT = `(props) => {
  const out = [];
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); out.push(p); } };
  for (const p of props) {
    if (p.startsWith("--")) continue;
    const s = document.createElement("div").style;
    s.setProperty(p, "inherit");
    if (s.length === 0) add(p);
    for (let i = 0; i < s.length; i++) add(s[i]);
  }
  return out;
}`;

interface Snapshot {
  /** Keyed by nodeKeys(): the same element gets the same key in both snapshots. */
  styles: Map<string, string[]>;
  boxes: Map<string, number[]>;
  nodes: { parent: number[]; type: number[]; name: string[]; attrs: string[][]; keys: string[] };
  /** node key → node index */
  index: Map<string, number>;
  /** Script edits: each element's own text (its text children), by node key. */
  text?: Map<string, string>;
}

/** One load of a page for a script edit. */
interface Load {
  snap: Snapshot;
  shot?: string;
  width?: number;
  errors: string[];
  /** Requests for the edited files. */
  hits: number;
}

/**
 * Every load of a page for a script edit starts at the same time and draws the
 * same random numbers (times still pass), so they agree on what depends on them.
 */
const determinismScript = (start: number) => `(() => {
  const RealDate = Date;
  const t0 = performance.now();
  const now = () => ${start} + Math.floor(performance.now() - t0);
  function FakeDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return args.length ? new RealDate(...args) : new RealDate(now());
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.defineProperty(FakeDate, 'name', { value: 'Date' });
  window.Date = FakeDate;
  let seed = 0x2545f491;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = rand;
  try {
    crypto.getRandomValues = function (arr) {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
      return arr;
    };
    crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(rand() * 16);
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  } catch {}
})();`;

/** Waits until the page stops changing (300 ms without DOM mutations, at most 2 s). */
const QUIET_SCRIPT = `new Promise((resolve) => {
  let timer;
  const done = () => { mo.disconnect(); clearTimeout(cap); resolve(true); };
  const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 300); });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  timer = setTimeout(done, 300);
  const cap = setTimeout(done, 2000);
})`;

const MAX_ERRORS = 20;

/** A free slot goes to interactive work first, then to background work. */
class Semaphore {
  private readonly queue: Array<() => void> = [];
  private readonly background: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>, background = false): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => (background ? this.background : this.queue).push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift() ?? this.background.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class Renderer {
  private browser?: Promise<Browser>;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly limit: Semaphore;

  constructor(
    readonly cfg: CbrConfig,
    readonly store: Store,
    opts: { concurrency?: number } = {},
  ) {
    this.limit = new Semaphore(opts.concurrency ?? 3);
  }

  private profile(name: string): Profile {
    return this.cfg.profiles.find((p) => p.name === name) ?? this.cfg.profiles[0];
  }

  private launch(): Promise<Browser> {
    return (this.browser ??= chromium.launch({ headless: true }));
  }

  private context(profile: string): Promise<BrowserContext> {
    let c = this.contexts.get(profile);
    if (!c) {
      c = this.launch().then((b) => newProfileContext(b, this.profile(profile), { initScript: false }));
      this.contexts.set(profile, c);
    }
    return c;
  }

  /** Forget a failed context; relaunch next time only if the browser itself is gone. */
  private async dropBroken(profile: string): Promise<void> {
    const ctx = this.contexts.get(profile);
    this.contexts.delete(profile);
    ctx?.then((c) => c.close()).catch(() => {});
    const launching = this.browser;
    const b = await launching?.catch(() => undefined);
    if (b?.isConnected()) return;
    if (this.browser === launching) {
      this.browser = undefined;
      this.contexts.clear();
    }
    await b?.close().catch(() => {});
  }

  measure(req: MeasureRequest): Promise<PageDiff> {
    return this.limit.run(() => this.measureNow(req), req.background);
  }

  private async measureNow(req: MeasureRequest): Promise<PageDiff> {
    const t0 = performance.now();
    const out: PageDiff = {
      url: req.page.url,
      variant: req.variant.name,
      mode: req.mode,
      status: "inconclusive",
      warnings: [],
      changedElements: 0,
      movedElements: 0,
      elements: [],
      truncated: false,
      comparedProps: [],
      zones: [],
      timingMs: 0,
    };
    const edits = (req.edits ?? [{ sheetKeys: req.sheetKeys ?? [], baseText: req.baseText ?? "", editedText: req.editedText ?? "" }]).filter(
      (e) => e.sheetKeys.length > 0,
    );
    const done = (status: PageDiff["status"], reason?: string) => {
      out.status = status;
      if (reason) out.reason = reason;
      out.timingMs = Math.round(performance.now() - t0);
      return out;
    };
    if (req.page.status !== "ok") return done("inconclusive", `page capture failed: ${req.page.error ?? "unknown"}`);
    if (req.scripts?.length) return this.measureLoads(req, edits, out, done);
    if (edits.length === 0) return done("inconclusive", "stylesheet-not-mapped: no page stylesheet to replace");
    if (req.mode === "shell" && req.page.fidelity !== undefined && req.page.fidelity < 0.98) {
      out.warnings.push(`shell replay fidelity ${(req.page.fidelity * 100).toFixed(1)}% (boxes within 1px of the live page)`);
    }

    let ctx: BrowserContext;
    let page: Page;
    try {
      ctx = await this.context(req.variant.profile);
      page = await ctx.newPage();
    } catch (err: any) {
      await this.dropBroken(req.variant.profile);
      return done("inconclusive", `browser unavailable: ${String(err?.message ?? err).split("\n")[0]}`);
    }
    try {
      // CSS must be enabled before navigation: enabling it on a loaded page
      // under request interception stalls ~5 s in Chromium's resource loader.
      const cdp = await ctx.newCDPSession(page);
      // styleSheetId → the edit applied to it (the first edit naming the sheet wins).
      const sheets = new Map<string, SheetEdit>();
      const want = new Map<string, SheetEdit>();
      for (const e of edits) for (const k of e.sheetKeys) if (!want.has(k)) want.set(k, e);
      cdp.on("CSS.styleSheetAdded", (e: any) => {
        const h = e.header;
        const edit = h.origin === "regular" && h.sourceURL ? want.get(sheetKey(this.cfg, h.sourceURL)) : undefined;
        if (edit) sheets.set(h.styleSheetId, edit);
      });
      cdp.on("CSS.styleSheetRemoved", (e: any) => sheets.delete(e.styleSheetId));
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");

      const full = new URL(req.page.url, this.cfg.origin).href;
      const timeout = this.cfg.capture.timeoutMs;
      if (req.mode === "shell") {
        const hash = req.page.shells[req.variant.id];
        if (!hash) return done("inconclusive", `no stored shell for variant ${req.variant.name}`);
        await openShell(page, this.store, { url: full, html: this.store.getBlob(hash).toString("utf8"), assets: req.page.assets, timeoutMs: timeout });
      } else {
        await page.route("**/*", (route) => serveSite(this.cfg, route).then(() => undefined));
        const resp = await page.goto(full, { waitUntil: "load", timeout });
        if (!resp || resp.status() >= 400) return done("inconclusive", `live load failed: HTTP ${resp?.status() ?? "no response"}`);
        await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
        await page.evaluate(SETTLE_SCRIPT);
        const recipe = req.variant.recipe ? this.cfg.recipes.find((r) => r.name === req.variant.recipe) : undefined;
        if (recipe) {
          await runRecipe(page, recipe);
          await page.evaluate(SETTLE_SCRIPT);
        }
      }

      if (sheets.size === 0) return done("inconclusive", "the edited stylesheet is not loaded on this page");

      const props = await comparedProps(page, req, out);

      const apply = async (side: "baseText" | "editedText") => {
        for (const [id, edit] of sheets) await cdp.send("CSS.setStyleSheetText", { styleSheetId: id, text: edit[side] });
        await page.evaluate(SETTLE_SCRIPT);
      };
      const shot = async () =>
        (await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, animations: "disabled", timeout })).toString("base64");

      await apply("baseText");
      const before = await snapshot(cdp, props);
      const beforeShot = req.screenshots ? await shot() : undefined;
      await apply("editedText");
      const after = await snapshot(cdp, props);
      const afterShot = req.screenshots ? await shot() : undefined;
      if (beforeShot && afterShot) {
        out.screenshots = { before: beforeShot, after: afterShot };
        out.pageWidth = (await page.evaluate("Math.max(document.documentElement.scrollWidth, innerWidth)")) as number;
        out.scale = this.profile(req.variant.profile).deviceScaleFactor ?? 1;
      }

      const targets = req.targets?.length ? await matchTargets(page, cdp, req.targets, props).catch(() => undefined) : undefined;
      diffSnapshots(before, after, props, req.maxElements ?? 200, out, { targets });
      if (out.screenshots) {
        const { anchors, leaves } = anchorsOf(before, after);
        out.anchors = anchors;
        out.anchorLeaves = leaves;
      }
      return done(out.changedElements + out.movedElements > 0 ? "changed" : "unchanged");
    } catch (err: any) {
      return done("inconclusive", String(err?.message ?? err).split("\n")[0]);
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Script edits: the page is loaded fresh for each side with its scripts
   * running and the edited files (scripts, and stylesheets too) served as
   * their base or edited text; everything else the first load fetched is
   * served the same again, and times and random numbers start the same.
   * Elements are matched across loads by their place in the tree. When the
   * sides differ, the base side is loaded once more: what differs between
   * those two loads changes by itself (timers, live content) and is left out.
   */
  private async measureLoads(req: MeasureRequest, edits: SheetEdit[], out: PageDiff, done: (status: PageDiff["status"], reason?: string) => PageDiff): Promise<PageDiff> {
    out.mode = "live";
    let browser: Browser;
    try {
      browser = await this.launch();
    } catch (err: any) {
      await this.dropBroken(req.variant.profile);
      return done("inconclusive", `browser unavailable: ${String(err?.message ?? err).split("\n")[0]}`);
    }
    const served = new Map<string, { type: string; base: string; edited: string }>();
    for (const s of req.scripts ?? []) for (const p of s.paths) if (!served.has(p)) served.set(p, { type: "text/javascript", base: s.baseText, edited: s.editedText });
    for (const e of edits) for (const k of e.sheetKeys) if (!served.has(k)) served.set(k, { type: "text/css", base: e.baseText, edited: e.editedText });
    const replay = new Map<string, { status: number; headers: Record<string, string>; body: Buffer }>();
    const profile = this.profile(req.variant.profile);
    const recipe = req.variant.recipe ? this.cfg.recipes.find((r) => r.name === req.variant.recipe) : undefined;
    const full = new URL(req.page.url, this.cfg.origin).href;
    const timeout = this.cfg.capture.timeoutMs;
    const init = determinismScript(Date.now());
    let props: string[] = [];
    let targets: Map<string, Set<string>> | undefined;

    const load = async (side: "base" | "edited", first = false): Promise<Load> => {
      const ctx = await newProfileContext(browser, profile, { initScript: false });
      try {
        await ctx.addInitScript({ content: init });
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(`${e.name || "Error"}: ${e.message}`));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        let hits = 0;
        await page.route("**/*", async (route) => {
          const r = route.request();
          const edit = served.get(sheetKey(this.cfg, r.url()));
          if (edit) {
            hits++;
            await route.fulfill({ status: 200, headers: { "content-type": edit.type }, body: side === "base" ? edit.base : edit.edited }).catch(() => {});
            return;
          }
          const id = `${r.method()} ${r.url()}\n${r.postData() ?? ""}`;
          const saved = replay.get(id);
          if (saved) {
            await route.fulfill(saved).catch(() => {});
            return;
          }
          const res = await serveSite(this.cfg, route);
          if (res && !replay.has(id)) replay.set(id, { status: res.status, headers: replayHeaders(res.headers), body: res.body });
        });
        const resp = await page.goto(full, { waitUntil: "load", timeout });
        if (!resp || resp.status() >= 400) throw new Error(`live load failed: HTTP ${resp?.status() ?? "no response"}`);
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
        await page.evaluate(SETTLE_SCRIPT);
        if (recipe) {
          await runRecipe(page, recipe);
          await page.evaluate(SETTLE_SCRIPT);
        }
        await page.evaluate(QUIET_SCRIPT).catch(() => {});
        await page.evaluate(SETTLE_SCRIPT);
        const cdp = await ctx.newCDPSession(page);
        if (first) props = await comparedProps(page, req, out);
        const snap = await snapshot(cdp, props, true);
        if (first && req.targets?.length) {
          await cdp.send("DOM.enable");
          targets = await matchTargets(page, cdp, req.targets, props).catch(() => undefined);
        }
        const load: Load = { snap, errors: [...new Set(errors)].slice(0, MAX_ERRORS).map((e) => clip(e, 300)), hits };
        if (req.screenshots && (first || side === "edited")) {
          load.shot = (await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, animations: "disabled", timeout })).toString("base64");
          load.width = (await page.evaluate("Math.max(document.documentElement.scrollWidth, innerWidth)")) as number;
        }
        return load;
      } finally {
        await ctx.close().catch(() => {});
      }
    };

    try {
      const before = await load("base", true);
      const edited = await load("edited");
      if (!before.hits && !edited.hits) return done("inconclusive", "this page didn't load the edited files");
      const after = alignTo(before.snap, edited.snap);
      const first = compareElements(before.snap, after, props, true);
      let added = edited.errors.filter((e) => !before.errors.includes(e));
      let fixed = before.errors.filter((e) => !edited.errors.includes(e));
      let ignore: Set<string> | undefined;
      if (first.changed.length + first.moved.length + added.length + fixed.length > 0) {
        const again = await load("base");
        const noise = compareElements(before.snap, alignTo(before.snap, again.snap), props, true);
        ignore = new Set([...noise.changed, ...noise.moved].map(([id]) => id));
        const left = [...first.changed, ...first.moved].filter(([id]) => ignore!.has(id)).length;
        if (left) {
          out.warnings.push(`${left} element${left === 1 ? "" : "s"} change${left === 1 ? "s" : ""} by ${left === 1 ? "itself" : "themselves"} between loads of this page (timers, live content), so ${left === 1 ? "it's" : "they're"} left out.`);
        }
        added = added.filter((e) => !again.errors.includes(e));
        fixed = fixed.filter((e) => again.errors.includes(e));
      }
      diffSnapshots(before.snap, after, props, req.maxElements ?? 200, out, { targets, ignore, content: true });
      if (added.length || fixed.length) out.errors = { added, fixed };
      if (before.shot && edited.shot) {
        out.screenshots = { before: before.shot, after: edited.shot };
        out.pageWidth = Math.max(before.width ?? 0, edited.width ?? 0);
        out.scale = profile.deviceScaleFactor ?? 1;
        const { anchors, leaves } = anchorsOf(before.snap, after);
        out.anchors = anchors;
        out.anchorLeaves = leaves;
      }
      return done(out.changedElements + out.movedElements + added.length > 0 ? "changed" : "unchanged");
    } catch (err: any) {
      if (!browser.isConnected()) await this.dropBroken(req.variant.profile);
      return done("inconclusive", String(err?.message ?? err).split("\n")[0]);
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    this.contexts.clear();
    if (b) await (await b).close().catch(() => {});
  }
}

/** The longhands to compare (shorthands expanded in the page). */
async function comparedProps(page: Page, req: MeasureRequest, out: PageDiff): Promise<string[]> {
  const requested = [...new Set([...BASE_PROPS, ...(req.props.length ? req.props : DEFAULT_PROPS)])];
  const props = ((await page.evaluate(`(${EXPAND_SCRIPT})(${JSON.stringify(requested)})`)) as string[]).slice(0, MAX_PROPS);
  if (requested.length + 10 < props.length) out.warnings.push(`compared the first ${MAX_PROPS} longhands only`);
  out.comparedProps = props;
  return props;
}

/** Recorded response headers that still fit the decoded body when served again. */
function replayHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) out[k] = v;
  return out;
}

function clip(v: string, max = 120): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** `content`: also each element's own text (script edits change what pages say, not just how they look). */
async function snapshot(cdp: CDPSession, props: string[], content = false): Promise<Snapshot> {
  const r: any = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: props });
  const s: string[] = r.strings;
  const doc = r.documents[0];
  const str = (i: number) => (i >= 0 ? s[i] : "");
  const parent = doc.nodes.parentIndex as number[];
  const name = (doc.nodes.nodeName as number[]).map(str);
  const nodes = {
    parent,
    type: doc.nodes.nodeType as number[],
    name,
    attrs: (doc.nodes.attributes as number[][]).map((a) => a.map(str)),
    keys: nodeKeys(parent, name, doc.nodes.backendNodeId as number[]),
  };
  const index = new Map<string, number>();
  nodes.keys.forEach((k, i) => index.set(k, i));
  const styles = new Map<string, string[]>();
  const boxes = new Map<string, number[]>();
  const layout = doc.layout;
  for (let i = 0; i < layout.nodeIndex.length; i++) {
    const id = nodes.keys[layout.nodeIndex[i]];
    if (styles.has(id)) continue;
    styles.set(id, (layout.styles[i] as number[]).map(str));
    boxes.set(id, layout.bounds[i] as number[]);
  }
  if (!content) return { styles, boxes, nodes, index };
  const value = (doc.nodes.nodeValue ?? []) as number[];
  const own = new Map<number, string>();
  for (let i = 0; i < parent.length; i++) if (nodes.type[i] === 3 && parent[i] >= 0) own.set(parent[i], (own.get(parent[i]) ?? "") + str(value[i] ?? -1));
  const text = new Map<string, string>();
  for (const [i, t] of own) {
    const v = t.replace(/\s+/g, " ").trim();
    if (v) text.set(nodes.keys[i], v);
  }
  return { styles, boxes, nodes, index, text };
}

/** Above this many sibling pairs, siblings are matched by kind and order instead of aligned. */
const MAX_ALIGN = 1_000_000;

/**
 * `b`, a snapshot of another load of the page, keyed like `a`: nodes in the
 * same place in the tree (siblings aligned in order by tag and id) get a's
 * keys, the others new ones.
 */
function alignTo(a: Snapshot, b: Snapshot): Snapshot {
  const sa = signatures(a.nodes);
  const sb = signatures(b.nodes);
  const ka = childLists(a.nodes.parent);
  const kb = childLists(b.nodes.parent);
  const keys = b.nodes.keys.map((_, i) => `+${i}`);
  const stack: Array<[number, number]> = [[a.nodes.parent.length, b.nodes.parent.length]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [cx, cy] of alignSiblings(ka[x], kb[y], sa, sb)) {
      keys[cy] = a.nodes.keys[cx];
      stack.push([cx, cy]);
    }
  }
  const styles = new Map<string, string[]>();
  const boxes = new Map<string, number[]>();
  const text = new Map<string, string>();
  const index = new Map<string, number>();
  keys.forEach((k, i) => {
    index.set(k, i);
    const old = b.nodes.keys[i];
    const st = b.styles.get(old);
    if (st) styles.set(k, st);
    const box = b.boxes.get(old);
    if (box) boxes.set(k, box);
    const t = b.text?.get(old);
    if (t !== undefined) text.set(k, t);
  });
  return { styles, boxes, nodes: { ...b.nodes, keys }, index, text };
}

function signatures(nodes: Snapshot["nodes"]): string[] {
  return nodes.name.map((name, i) => {
    const attrs = nodes.attrs[i] ?? [];
    for (let k = 0; k < attrs.length; k += 2) if (attrs[k] === "id") return `${name}#${attrs[k + 1]}`;
    return name;
  });
}

/** Each node's children in order; the last list holds the roots. */
function childLists(parent: number[]): number[][] {
  const out: number[][] = Array.from({ length: parent.length + 1 }, () => []);
  parent.forEach((p, i) => out[p >= 0 ? p : parent.length].push(i));
  return out;
}

/** Matching pairs of two sibling lists: the longest common run of signatures. */
function alignSiblings(xs: number[], ys: number[], sa: string[], sb: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let lo = 0;
  let hx = xs.length;
  let hy = ys.length;
  while (lo < hx && lo < hy && sa[xs[lo]] === sb[ys[lo]]) {
    out.push([xs[lo], ys[lo]]);
    lo++;
  }
  while (hx > lo && hy > lo && sa[xs[hx - 1]] === sb[ys[hy - 1]]) {
    hx--;
    hy--;
    out.push([xs[hx], ys[hy]]);
  }
  const n = hx - lo;
  const m = hy - lo;
  if (!n || !m) return out;
  if (n * m > MAX_ALIGN) {
    // The k-th node of a kind on one side goes with the k-th on the other.
    const left = new Map<string, number[]>();
    for (let i = hx - 1; i >= lo; i--) {
      let l = left.get(sa[xs[i]]);
      if (!l) left.set(sa[xs[i]], (l = []));
      l.push(xs[i]);
    }
    for (let j = lo; j < hy; j++) {
      const x = left.get(sb[ys[j]])?.pop();
      if (x !== undefined) out.push([x, ys[j]]);
    }
    return out;
  }
  const w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = sa[xs[lo + i]] === sb[ys[lo + j]] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (sa[xs[lo + i]] === sb[ys[lo + j]]) {
      out.push([xs[lo + i], ys[lo + j]]);
      i++;
      j++;
    } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * DOM nodes keep their backend id between snapshots. Pseudo-elements don't:
 * Chromium rebuilds them when it re-evaluates media queries (a full-page
 * screenshot does), so they are keyed by their owner and pseudo name instead.
 */
function nodeKeys(parent: number[], name: string[], backend: number[]): string[] {
  const keys: string[] = new Array(name.length);
  const used = new Set<string>();
  const keyOf = (i: number): string => {
    if (keys[i] !== undefined) return keys[i];
    let k = String(backend[i]);
    if (name[i].startsWith("::") && parent[i] >= 0) {
      const base = keyOf(parent[i]) + name[i].toLowerCase();
      k = base;
      for (let n = 2; used.has(k); n++) k = `${base}#${n}`;
    }
    used.add(k);
    return (keys[i] = k);
  };
  for (let i = 0; i < name.length; i++) keyOf(i);
  return keys;
}

function nodePath(nodes: Snapshot["nodes"], idx: number): string {
  const parts: string[] = [];
  for (let n = idx, depth = 0; n >= 0 && depth < 5; n = nodes.parent[n], depth++) {
    const name = nodes.name[n].toLowerCase();
    if (name === "#document" || name === "html") break;
    const attrs = nodes.attrs[n] ?? [];
    let id = "";
    let cls: string[] = [];
    for (let k = 0; k < attrs.length; k += 2) {
      if (attrs[k] === "id") id = attrs[k + 1];
      if (attrs[k] === "class") cls = attrs[k + 1].trim().split(/\s+/).filter(Boolean).slice(0, 2);
    }
    parts.unshift(name + (id ? `#${id}` : "") + cls.map((c) => `.${c}`).join(""));
    if (id) break;
  }
  return parts.join(" > ") || nodes.name[idx].toLowerCase();
}

/** At most this many selector queries per page. */
const MAX_TARGET_QUERIES = 200;

/**
 * The elements (and pseudo-elements) the edited rules apply to, by snapshot
 * node key, with the compared longhands their edits set.
 */
async function matchTargets(page: Page, cdp: CDPSession, targets: RenderTarget[], compared: string[]): Promise<Map<string, Set<string>>> {
  const groups = new Map<string, { pseudo: string; props: string[]; selectors: string[] }>();
  for (const t of targets) {
    const props = [...new Set(t.props)].sort();
    const k = `${t.pseudo ?? ""}|${props.join(",")}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { pseudo: t.pseudo ? `::${t.pseudo}` : "", props, selectors: [] }));
    if (!g.selectors.includes(t.selector)) g.selectors.push(t.selector);
  }
  const list = [...groups.values()];
  const expanded = (await page.evaluate(`(${JSON.stringify(list.map((g) => g.props))}).map(${EXPAND_SCRIPT})`)) as string[][];
  const inCompared = new Set(compared);

  const backend = new Map<number, number>();
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1 })) as any;
  const walk = (n: any) => {
    backend.set(n.nodeId, n.backendNodeId);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);

  const out = new Map<string, Set<string>>();
  let queries = 0;
  const query = async (selector: string): Promise<number[]> => {
    if (queries++ >= MAX_TARGET_QUERIES) return [];
    try {
      return ((await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector })) as any).nodeIds;
    } catch {
      return [];
    }
  };
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const own = expanded[i].filter((p) => inCompared.has(p));
    if (!own.length) continue;
    let ids = await query(g.selectors.join(", "));
    // One selector the browser rejects fails the whole list: query them one by one.
    if (!ids.length && g.selectors.length > 1) for (const sel of g.selectors) ids = ids.concat(await query(sel));
    for (const id of ids) {
      const b = backend.get(id);
      if (b === undefined) continue;
      const key = String(b) + g.pseudo;
      let set = out.get(key);
      if (!set) out.set(key, (set = new Set()));
      for (const p of own) set.add(p);
    }
  }
  return out;
}

const MAX_ANCHORS = 6000;
const LEAF_ELEMENTS = /^(img|svg|video|canvas|iframe|input|button|select|textarea|picture|object|embed)$/i;

/** Before/after box pairs of what is on the page in both versions (see PageDiff.anchors). */
function anchorsOf(a: Snapshot, b: Snapshot): { anchors: number[]; leaves: number } {
  const leaves: Array<[number[], number[]]> = [];
  const others: Array<[number[], number[], number]> = [];
  for (const [key, ba] of a.boxes) {
    const bb = b.boxes.get(key);
    if (!bb || ba[2] <= 0 || ba[3] <= 0 || bb[2] <= 0 || bb[3] <= 0) continue;
    const i = a.index.get(key)!;
    const type = a.nodes.type[i];
    const name = a.nodes.name[i];
    if (type === 3 || (type === 1 && LEAF_ELEMENTS.test(name))) leaves.push([ba, bb]);
    else if (type === 1 && !/^(html|body)$/i.test(name)) others.push([ba, bb, ba[2] * ba[3]]);
  }
  // Too many: keep every text run and image we can, then the smallest elements.
  const keepLeaves = leaves.slice(0, MAX_ANCHORS);
  const keepOthers = others.length > MAX_ANCHORS - keepLeaves.length ? others.sort((x, y) => x[2] - y[2]).slice(0, MAX_ANCHORS - keepLeaves.length) : others;
  const anchors: number[] = [];
  for (const [ba, bb] of [...keepLeaves, ...keepOthers]) for (const v of [...ba.slice(0, 4), ...bb.slice(0, 4)]) anchors.push(Math.round(v));
  return { anchors, leaves: keepLeaves.length };
}

const TOLERANCE = 0.5;
const MAX_ZONES = 100;
const MAX_ZONE_PROPS = 12;
const ROOT = /^(html|body)$/i;
/** Computed values that are layout results: they change when anything nearby grows or shrinks. */
const DERIVED = /^(width|height|inline-size|block-size|(margin|padding|inset)(-.+)?|top|right|bottom|left|transform|transform-origin|perspective-origin|grid-template-(rows|columns))$/;
const SIZE = /^(width|height|inline-size|block-size)$/;

interface DiffOptions {
  /** See matchTargets. */
  targets?: Map<string, Set<string>>;
  /** Node keys left out. */
  ignore?: Set<string>;
  /** Compare each element's own text and attributes too. */
  content?: boolean;
}

/** Looks up node keys in whichever snapshot has them (a first). */
function pairOf(a: Snapshot, b: Snapshot) {
  const snap = (id: string) => (a.index.has(id) ? a : b);
  const at = (id: string) => snap(id).index.get(id) ?? -1;
  const parentOf = (id: string): string | undefined => {
    const s = snap(id);
    const p = s.nodes.parent[s.index.get(id)!];
    return p >= 0 ? s.nodes.keys[p] : undefined;
  };
  const label = (id: string) => nodePath(snap(id).nodes, at(id));
  return { snap, at, parentOf, label };
}

/** Elements whose compared values change, and those that only move or resize. */
function compareElements(a: Snapshot, b: Snapshot, props: string[], content = false, ignore?: Set<string>) {
  const { snap, at, label } = pairOf(a, b);
  const ids = [...new Set<string>([...a.styles.keys(), ...b.styles.keys()])].sort((x, y) => at(x) - at(y));
  const changed: Array<[string, ElementDiff]> = [];
  const moved: Array<[string, ElementDiff]> = [];
  for (const id of ids) {
    // Elements and pseudo-elements; text runs are covered by their parent box.
    if (ignore?.has(id) || snap(id).nodes.type[at(id)] !== 1) continue;
    const sa = a.styles.get(id);
    const sb = b.styles.get(id);
    const ba = a.boxes.get(id) ?? null;
    const bb = b.boxes.get(id) ?? null;
    if (!sa || !sb) {
      changed.push([id, { path: label(id), kind: sa ? "disappeared" : "appeared", props: [], box: { before: ba, after: bb } }]);
      continue;
    }
    const diffs: ElementDiff["props"] = [];
    for (let k = 0; k < props.length; k++) if (sa[k] !== sb[k]) diffs.push({ prop: props[k], before: sa[k], after: sb[k] });
    if (content) diffs.push(...contentDiffs(a, b, id));
    const boxMoved = !!ba && !!bb && ba.some((v, k) => Math.abs(v - bb[k]) > TOLERANCE);
    if (diffs.length) changed.push([id, { path: label(id), kind: "changed", props: diffs, box: { before: ba, after: bb } }]);
    else if (boxMoved) {
      const resized = Math.abs(ba![2] - bb![2]) > TOLERANCE || Math.abs(ba![3] - bb![3]) > TOLERANCE;
      moved.push([id, { path: label(id), kind: resized ? "resized" : "moved", props: [], box: { before: ba, after: bb } }]);
    }
  }
  return { changed, moved };
}

/** An element's own text and attributes, before and after. */
function contentDiffs(a: Snapshot, b: Snapshot, id: string): ElementDiff["props"] {
  const out: ElementDiff["props"] = [];
  const ta = a.text?.get(id) ?? "";
  const tb = b.text?.get(id) ?? "";
  if (ta !== tb) out.push({ prop: "text", before: clip(ta), after: clip(tb) });
  const attrs = (s: Snapshot) => {
    const m = new Map<string, string>();
    const list = s.nodes.attrs[s.index.get(id)!] ?? [];
    for (let k = 0; k < list.length; k += 2) m.set(list[k], list[k + 1]);
    return m;
  };
  const ma = attrs(a);
  const mb = attrs(b);
  for (const name of new Set([...ma.keys(), ...mb.keys()])) {
    const va = ma.get(name);
    const vb = mb.get(name);
    if (va !== vb) out.push({ prop: `[${name}]`, before: va === undefined ? "(none)" : clip(va), after: vb === undefined ? "(none)" : clip(vb) });
  }
  return out;
}

function diffSnapshots(a: Snapshot, b: Snapshot, props: string[], max: number, out: PageDiff, opts: DiffOptions = {}): void {
  const { snap, at, parentOf } = pairOf(a, b);
  const { targets } = opts;
  const { changed, moved } = compareElements(a, b, props, opts.content, opts.ignore);
  out.changedElements = changed.length;
  out.movedElements = moved.length;

  // Zones: the outermost elements the edits change themselves. A parent that
  // only got taller (or a page-wide box whose used size or margins moved)
  // follows from them; a rule's own elements, a new look (color, font,
  // display...), or anything appearing or disappearing is a change of its own.
  const isRoot = (id: string) => ROOT.test(snap(id).nodes.name[at(id)]);
  const grew = new Set<string>();
  for (const [id] of changed) for (let p = parentOf(id); p !== undefined && !grew.has(p); p = parentOf(p)) grew.add(p);
  const isCause = ([id, e]: [string, ElementDiff]) => {
    if (e.kind !== "changed") return !isRoot(id);
    const own = targets?.get(id);
    if (own && e.props.some((p) => own.has(p.prop))) return true;
    if (e.props.some((p) => !DERIVED.test(p.prop))) return true;
    if (isRoot(id)) return false;
    return !(grew.has(id) && e.props.every((p) => SIZE.test(p.prop)));
  };
  const causes = changed.filter(isCause);
  // Only when nothing changed directly (a property we didn't compare) do moved boxes stand in.
  const shifted = moved.filter(([id]) => !isRoot(id));
  const source = causes.length ? causes : shifted.length ? shifted : changed;
  const inSource = new Map(source);
  const outerOf = (id: string): string | undefined => {
    let found: string | undefined;
    for (let p = parentOf(id); p !== undefined; p = parentOf(p)) if (inSource.has(p)) found = p;
    return found;
  };
  const zones = new Map<string, Zone>();
  for (const [id, e] of source) {
    if (outerOf(id) === undefined) zones.set(id, { before: e.box?.before ?? null, after: e.box?.after ?? null, label: e.path, props: [...e.props] });
  }
  for (const [id, e] of [...changed, ...moved]) {
    const outer = outerOf(id);
    if (outer === undefined) continue;
    e.nested = true;
    const z = zones.get(outer);
    if (!z) continue;
    for (const p of e.props) if (z.props.length < MAX_ZONE_PROPS && !z.props.some((x) => x.prop === p.prop)) z.props.push(p);
  }
  const top = (z: Zone) => Math.min(z.before?.[1] ?? Infinity, z.after?.[1] ?? Infinity);
  out.zones = [...zones.values()].sort((x, y) => top(x) - top(y)).slice(0, MAX_ZONES);

  // Outermost first, then everything nested in them.
  const list = [...changed, ...moved].map(([, e]) => e).sort((x, y) => Number(!!x.nested) - Number(!!y.nested));
  out.truncated = list.length > max;
  out.elements = list.slice(0, max);
}
