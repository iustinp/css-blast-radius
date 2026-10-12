// L2/L3 (§6.6–6.7): what actually changes on one page. The page is loaded
// once (L2: the stored shell, scripts off, assets from the store; L3: the
// live page with scripts and its recipe), the mapped stylesheet is set to the
// base text and then the edited text through CDP, and both states are
// measured with DOMSnapshot in the same tab.

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type { CbrConfig, Profile } from "../config.js";
import { newProfileContext, runRecipe, serveSite, sheetKey } from "../capture/capture.js";
import { SETTLE_SCRIPT } from "../capture/inPage.js";
import type { PageRow, Store, VariantInfo } from "../index/store.js";
import { openShell } from "./shell.js";

export type RenderMode = "shell" | "live";

export interface MeasureRequest {
  page: PageRow;
  variant: VariantInfo;
  mode: RenderMode;
  /** Index stylesheet keys of the edited file (e.g. "/css/components.css"). */
  sheetKeys: string[];
  baseText: string;
  editedText: string;
  /** Properties to compare; shorthands are expanded in the page. */
  props: string[];
  screenshots?: boolean;
  maxElements?: number;
}

export interface ElementDiff {
  path: string;
  /** moved: same size, new position; resized: box size changed. */
  kind: "changed" | "moved" | "resized" | "appeared" | "disappeared";
  props: Array<{ prop: string; before: string; after: string }>;
  box?: { before: number[] | null; after: number[] | null };
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
  /** node index → [styles…] */
  styles: Map<number, string[]>;
  boxes: Map<number, number[]>;
  nodes: { parent: number[]; type: number[]; name: string[]; attrs: string[][] };
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
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

  private context(profile: string): Promise<BrowserContext> {
    let c = this.contexts.get(profile);
    if (!c) {
      this.browser ??= chromium.launch({ headless: true });
      c = this.browser.then((b) => newProfileContext(b, this.profile(profile), { initScript: false }));
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
    return this.limit.run(() => this.measureNow(req));
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
      timingMs: 0,
    };
    const done = (status: PageDiff["status"], reason?: string) => {
      out.status = status;
      if (reason) out.reason = reason;
      out.timingMs = Math.round(performance.now() - t0);
      return out;
    };
    if (req.page.status !== "ok") return done("inconclusive", `page capture failed: ${req.page.error ?? "unknown"}`);
    if (req.sheetKeys.length === 0) return done("inconclusive", "stylesheet-not-mapped: no page stylesheet to replace");
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
      const sheets = new Map<string, string>();
      const want = new Set(req.sheetKeys);
      cdp.on("CSS.styleSheetAdded", (e: any) => {
        const h = e.header;
        if (h.origin === "regular" && h.sourceURL && want.has(sheetKey(this.cfg, h.sourceURL))) sheets.set(h.styleSheetId, h.sourceURL);
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

      const sheetIds = [...sheets.keys()];
      if (sheetIds.length === 0) return done("inconclusive", "the edited stylesheet is not loaded on this page");

      const requested = [...new Set([...BASE_PROPS, ...(req.props.length ? req.props : DEFAULT_PROPS)])];
      const props = ((await page.evaluate(`(${EXPAND_SCRIPT})(${JSON.stringify(requested)})`)) as string[]).slice(0, MAX_PROPS);
      if (requested.length + 10 < props.length) out.warnings.push(`compared the first ${MAX_PROPS} longhands only`);
      out.comparedProps = props;

      const apply = async (text: string) => {
        for (const id of sheetIds) await cdp.send("CSS.setStyleSheetText", { styleSheetId: id, text });
        await page.evaluate(SETTLE_SCRIPT);
      };
      const shot = async () =>
        (await page.screenshot({ type: "jpeg", quality: 70, fullPage: true, animations: "disabled", timeout })).toString("base64");

      await apply(req.baseText);
      const before = await snapshot(cdp, props);
      const beforeShot = req.screenshots ? await shot() : undefined;
      await apply(req.editedText);
      const after = await snapshot(cdp, props);
      const afterShot = req.screenshots ? await shot() : undefined;
      if (beforeShot && afterShot) out.screenshots = { before: beforeShot, after: afterShot };

      diffSnapshots(before, after, props, req.maxElements ?? 200, out);
      return done(out.changedElements + out.movedElements > 0 ? "changed" : "unchanged");
    } catch (err: any) {
      return done("inconclusive", String(err?.message ?? err).split("\n")[0]);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    this.contexts.clear();
    if (b) await (await b).close().catch(() => {});
  }
}

async function snapshot(cdp: CDPSession, props: string[]): Promise<Snapshot> {
  const r: any = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: props });
  const s: string[] = r.strings;
  const doc = r.documents[0];
  const str = (i: number) => (i >= 0 ? s[i] : "");
  const nodes = {
    parent: doc.nodes.parentIndex as number[],
    type: doc.nodes.nodeType as number[],
    name: (doc.nodes.nodeName as number[]).map(str),
    attrs: (doc.nodes.attributes as number[][]).map((a) => a.map(str)),
  };
  const styles = new Map<number, string[]>();
  const boxes = new Map<number, number[]>();
  const layout = doc.layout;
  for (let i = 0; i < layout.nodeIndex.length; i++) {
    const n = layout.nodeIndex[i];
    if (styles.has(n)) continue;
    styles.set(n, (layout.styles[i] as number[]).map(str));
    boxes.set(n, layout.bounds[i] as number[]);
  }
  return { styles, boxes, nodes };
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

const TOLERANCE = 0.5;

function diffSnapshots(a: Snapshot, b: Snapshot, props: string[], max: number, out: PageDiff): void {
  const all = new Set<number>([...a.styles.keys(), ...b.styles.keys()]);
  const changed: ElementDiff[] = [];
  const moved: ElementDiff[] = [];
  const order = [...all].sort((x, y) => x - y);
  for (const n of order) {
    // Elements and pseudo-elements; text runs are covered by their parent box.
    const type = a.nodes.type[n] ?? b.nodes.type[n];
    if (type !== 1) continue;
    const sa = a.styles.get(n);
    const sb = b.styles.get(n);
    const ba = a.boxes.get(n) ?? null;
    const bb = b.boxes.get(n) ?? null;
    if (!sa || !sb) {
      changed.push({ path: nodePath(a.nodes, n), kind: sa ? "disappeared" : "appeared", props: [], box: { before: ba, after: bb } });
      continue;
    }
    const diffs: ElementDiff["props"] = [];
    for (let k = 0; k < props.length; k++) if (sa[k] !== sb[k]) diffs.push({ prop: props[k], before: sa[k], after: sb[k] });
    const boxMoved = !!ba && !!bb && ba.some((v, k) => Math.abs(v - bb[k]) > TOLERANCE);
    if (diffs.length) changed.push({ path: nodePath(a.nodes, n), kind: "changed", props: diffs, box: boxMoved ? { before: ba, after: bb } : undefined });
    else if (boxMoved) {
      const resized = Math.abs(ba![2] - bb![2]) > TOLERANCE || Math.abs(ba![3] - bb![3]) > TOLERANCE;
      moved.push({ path: nodePath(a.nodes, n), kind: resized ? "resized" : "moved", props: [], box: { before: ba, after: bb } });
    }
  }
  out.changedElements = changed.length;
  out.movedElements = moved.length;
  const list = [...changed, ...moved];
  out.truncated = list.length > max;
  out.elements = list.slice(0, max);
}
