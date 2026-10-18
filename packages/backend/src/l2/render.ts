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

export interface SheetEdit {
  /** Index stylesheet keys of the edited file (e.g. "/css/components.css"). */
  sheetKeys: string[];
  baseText: string;
  editedText: string;
}

export interface MeasureRequest extends Partial<SheetEdit> {
  page: PageRow;
  variant: VariantInfo;
  mode: RenderMode;
  /** Several edited files at once (the diff viewer); overrides sheetKeys/baseText/editedText. */
  edits?: SheetEdit[];
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
}

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

      const requested = [...new Set([...BASE_PROPS, ...(req.props.length ? req.props : DEFAULT_PROPS)])];
      const props = ((await page.evaluate(`(${EXPAND_SCRIPT})(${JSON.stringify(requested)})`)) as string[]).slice(0, MAX_PROPS);
      if (requested.length + 10 < props.length) out.warnings.push(`compared the first ${MAX_PROPS} longhands only`);
      out.comparedProps = props;

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
      diffSnapshots(before, after, props, req.maxElements ?? 200, out, targets);
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
  return { styles, boxes, nodes, index };
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

function diffSnapshots(a: Snapshot, b: Snapshot, props: string[], max: number, out: PageDiff, targets?: Map<string, Set<string>>): void {
  const snap = (id: string) => (a.index.has(id) ? a : b);
  const at = (id: string) => snap(id).index.get(id) ?? -1;
  const parentOf = (id: string): string | undefined => {
    const s = snap(id);
    const p = s.nodes.parent[s.index.get(id)!];
    return p >= 0 ? s.nodes.keys[p] : undefined;
  };
  const label = (id: string) => nodePath(snap(id).nodes, at(id));
  const ids = [...new Set<string>([...a.styles.keys(), ...b.styles.keys()])].sort((x, y) => at(x) - at(y));
  const changed: Array<[string, ElementDiff]> = [];
  const moved: Array<[string, ElementDiff]> = [];
  for (const id of ids) {
    // Elements and pseudo-elements; text runs are covered by their parent box.
    if (snap(id).nodes.type[at(id)] !== 1) continue;
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
    const boxMoved = !!ba && !!bb && ba.some((v, k) => Math.abs(v - bb[k]) > TOLERANCE);
    if (diffs.length) changed.push([id, { path: label(id), kind: "changed", props: diffs, box: { before: ba, after: bb } }]);
    else if (boxMoved) {
      const resized = Math.abs(ba![2] - bb![2]) > TOLERANCE || Math.abs(ba![3] - bb![3]) > TOLERANCE;
      moved.push([id, { path: label(id), kind: resized ? "resized" : "moved", props: [], box: { before: ba, after: bb } }]);
    }
  }
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
