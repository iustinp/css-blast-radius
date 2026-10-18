// In-memory view of one published index revision, plus the builder that a
// capture run fills and writes. Queries (L0/L1) only read SiteIndex; they
// never see a revision that is still building.

import { PageSet } from "../util/pageSet.js";
import type { PageRow, RevisionRow, Store, VariantInfo } from "./store.js";

export interface SelectorEntry {
  byVariant: PageSet[];
  /** Union over variants: pages where the relaxed selector matched. */
  matches: PageSet;
  /** Pages where the selector was evaluated natively. */
  evaluated: PageSet;
  /** Pages where Chromium rejected the selector (invalid there). */
  rejected: PageSet;
}

export interface MatcherCheck {
  feature: string;
  agree: number;
  disagree: number;
  example?: string;
}

function splitVariants(size: number, buf: Buffer, count: number): PageSet[] {
  const bytes = ((size + 31) >>> 5) * 4;
  const out: PageSet[] = [];
  for (let v = 0; v < count; v++) out.push(PageSet.fromBuffer(size, buf.subarray(v * bytes, (v + 1) * bytes)));
  return out;
}

export class SiteIndex {
  readonly size: number;
  readonly pages: PageRow[];
  readonly byUrl = new Map<string, number>();
  /** Captured pages (ok or failed); removed pages are excluded. */
  readonly all: PageSet;
  readonly ok: PageSet;
  readonly failed: PageSet;
  readonly quirks: PageSet;
  readonly tokens = new Map<string, PageSet>();
  readonly runtimeTokens = new Map<string, PageSet>();
  readonly usage = new Map<string, PageSet>();
  /** --b → custom properties whose captured values reference var(--b). */
  readonly varDependents = new Map<string, Set<string>>();
  readonly sheets = new Map<string, { hash?: string; pages: PageSet }>();
  private sheetsLower?: Map<string, string>;
  readonly matcherChecks: MatcherCheck[];
  readonly unsupportedFeatures = new Set<string>();
  private readonly selectorCache = new Map<string, SelectorEntry | null>();
  private readonly selectStmt;

  private constructor(
    private readonly store: Store,
    readonly revision: RevisionRow,
  ) {
    const rev = revision.id;
    this.size = revision.pageCount;
    this.pages = store.pages(rev);
    this.all = PageSet.empty(this.size);
    this.ok = PageSet.empty(this.size);
    this.failed = PageSet.empty(this.size);
    this.quirks = PageSet.empty(this.size);
    for (const p of this.pages) {
      this.byUrl.set(p.url, p.id);
      if (p.status === "removed") continue;
      this.all.add(p.id);
      if (p.status === "ok") this.ok.add(p.id);
      else this.failed.add(p.id);
      if (p.quirks) this.quirks.add(p.id);
    }
    const db = store.db;
    for (const r of db.prepare("SELECT token, runtime, pages FROM token_posting WHERE rev = ?").iterate(rev) as Iterable<any>) {
      (r.runtime ? this.runtimeTokens : this.tokens).set(r.token, PageSet.fromBuffer(this.size, r.pages));
    }
    for (const r of db.prepare("SELECT key, pages FROM usage_posting WHERE rev = ?").iterate(rev) as Iterable<any>) {
      this.usage.set(r.key, PageSet.fromBuffer(this.size, r.pages));
      if (r.key.startsWith("vdep:")) {
        const [from, to] = r.key.slice(5).split(">");
        let set = this.varDependents.get(from);
        if (!set) this.varDependents.set(from, (set = new Set()));
        set.add(to);
      }
    }
    for (const r of db.prepare("SELECT url, content_hash, pages FROM stylesheet WHERE rev = ?").iterate(rev) as Iterable<any>) {
      this.sheets.set(r.url, { hash: r.content_hash ?? undefined, pages: PageSet.fromBuffer(this.size, r.pages) });
    }
    this.matcherChecks = (db.prepare("SELECT feature, agree, disagree, example FROM matcher_check WHERE rev = ?").all(rev) as any[]).map(
      (r) => ({ feature: r.feature, agree: r.agree, disagree: r.disagree, example: r.example ?? undefined }),
    );
    for (const c of this.matcherChecks) if (c.disagree > 0) this.unsupportedFeatures.add(c.feature);
    this.selectStmt = db.prepare("SELECT by_variant, evaluated, rejected FROM selector_match WHERE rev = ? AND key = ?");
  }

  /**
   * The captured key of the stylesheet served at `url`. Falls back to a
   * case-insensitive match: on a case-insensitive file system a page can link
   * /css/app.css while the file is css/App.css.
   */
  sheetKey(url: string): string | undefined {
    if (this.sheets.has(url)) return url;
    if (!this.sheetsLower) {
      this.sheetsLower = new Map();
      for (const k of this.sheets.keys()) if (!this.sheetsLower.has(k.toLowerCase())) this.sheetsLower.set(k.toLowerCase(), k);
    }
    return this.sheetsLower.get(url.toLowerCase());
  }

  static load(store: Store, revisionId?: number): SiteIndex | undefined {
    const rev = revisionId !== undefined ? store.revision(revisionId) : store.currentRevision();
    if (!rev || rev.status !== "ready") return undefined;
    return new SiteIndex(store, rev);
  }

  get variants(): VariantInfo[] {
    return this.revision.variants;
  }

  selector(key: string): SelectorEntry | undefined {
    const hit = this.selectorCache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const r = this.selectStmt.get(this.revision.id, key) as any;
    const entry = r ? this.decodeSelector(r) : null;
    if (this.selectorCache.size > 200_000) this.selectorCache.clear();
    this.selectorCache.set(key, entry);
    return entry ?? undefined;
  }

  /** Loads many selector rows in a few queries (CodeLens over a whole file). */
  prefetch(keys: Iterable<string>): void {
    const missing = [...new Set(keys)].filter((k) => !this.selectorCache.has(k));
    for (let i = 0; i < missing.length; i += 400) {
      const chunk = missing.slice(i, i + 400);
      const rows = this.store.db
        .prepare(`SELECT key, by_variant, evaluated, rejected FROM selector_match WHERE rev = ? AND key IN (${chunk.map(() => "?").join(",")})`)
        .all(this.revision.id, ...chunk) as any[];
      const found = new Map(rows.map((r) => [r.key as string, r]));
      if (this.selectorCache.size > 200_000) this.selectorCache.clear();
      for (const k of chunk) {
        const r = found.get(k);
        this.selectorCache.set(k, r ? this.decodeSelector(r) : null);
      }
    }
  }

  private decodeSelector(r: any): SelectorEntry {
    const byVariant = splitVariants(this.size, r.by_variant, this.variants.length);
    const matches = PageSet.empty(this.size);
    for (const s of byVariant) matches.orInPlace(s);
    return {
      byVariant,
      matches,
      evaluated: PageSet.fromBuffer(this.size, r.evaluated),
      rejected: r.rejected ? PageSet.fromBuffer(this.size, r.rejected) : PageSet.empty(this.size),
    };
  }

  token(t: string): PageSet | undefined {
    return this.tokens.get(t);
  }

  url(id: number): string {
    return this.pages[id]?.url ?? `#${id}`;
  }
}

/** A page whose recorded files change without recapturing it. */
export interface PagePatch {
  url: string;
  /** Asset URL → "blob hash content-type", as a capture records it. */
  assets?: Record<string, string>;
  /** Site path → git blob id. */
  loaded?: Record<string, string>;
}

/** Accumulates one capture run; can start from a previous revision (partial recapture). */
export class IndexBuilder {
  readonly size: number;
  readonly urls: string[];
  private readonly ids = new Map<string, number>();
  readonly pages = new Map<number, PageRow>();
  private readonly tokens = new Map<string, PageSet>();
  private readonly runtime = new Map<string, PageSet>();
  private readonly usage = new Map<string, PageSet>();
  private readonly sheets = new Map<string, { hash?: string; pages: PageSet }>();
  private readonly selectors = new Map<string, { byVariant: PageSet[]; evaluated: PageSet; rejected: PageSet }>();
  private readonly checks = new Map<string, MatcherCheck>();

  constructor(
    readonly variants: VariantInfo[],
    urls: string[],
    prev?: SiteIndex,
  ) {
    const all: string[] = prev ? prev.pages.map((p) => p.url) : [];
    for (const u of all) this.ids.set(u, this.ids.size);
    for (const u of urls) if (!this.ids.has(u)) this.ids.set(u, this.ids.size);
    this.urls = [...this.ids.keys()];
    this.size = this.urls.length;
    if (prev) this.importPrevious(prev, new Set(urls));
  }

  private grow(s: PageSet): PageSet {
    if (s.size === this.size) return s;
    const out = PageSet.empty(this.size);
    out.words.set(s.words.subarray(0, Math.min(s.words.length, out.words.length)));
    return out;
  }

  private importPrevious(prev: SiteIndex, recapturing: Set<string>): void {
    const keep = PageSet.empty(this.size);
    for (const p of prev.pages) {
      if (recapturing.has(p.url) || p.status === "removed") continue;
      keep.add(p.id);
      this.pages.set(p.id, p);
    }
    const kept = (s: PageSet) => this.grow(s).andInPlace(keep);
    for (const [k, v] of prev.tokens) this.tokens.set(k, kept(v));
    for (const [k, v] of prev.runtimeTokens) this.runtime.set(k, kept(v));
    for (const [k, v] of prev.usage) this.usage.set(k, kept(v));
    for (const [k, v] of prev.sheets) this.sheets.set(k, { hash: v.hash, pages: kept(v.pages) });
    for (const c of prev.matcherChecks) this.checks.set(c.feature, { ...c });
    const rows = prev["store"].db
      .prepare("SELECT key FROM selector_match WHERE rev = ?")
      .all(prev.revision.id) as Array<{ key: string }>;
    for (const { key } of rows) {
      const e = prev.selector(key)!;
      this.selectors.set(key, {
        byVariant: e.byVariant.map(kept),
        evaluated: kept(e.evaluated),
        rejected: kept(e.rejected),
      });
    }
  }

  id(url: string): number {
    const id = this.ids.get(url);
    if (id === undefined) throw new Error(`unknown page ${url}`);
    return id;
  }

  setPage(row: PageRow): void {
    this.pages.set(row.id, row);
  }

  /** Updates a carried-forward page's recorded files (a change that doesn't reach it). */
  patchPage(p: PagePatch): void {
    const id = this.ids.get(p.url);
    const row = id === undefined ? undefined : this.pages.get(id);
    if (!row || row.status === "removed") return;
    this.pages.set(row.id, {
      ...row,
      assets: { ...row.assets, ...p.assets },
      // An older scan didn't list what pages load: don't start a partial list.
      ...(p.loaded && row.loaded ? { loaded: { ...row.loaded, ...p.loaded } } : {}),
    });
  }

  /** The stylesheet's captured content is now `hash`. */
  setSheetHash(url: string, hash: string): void {
    const s = this.sheets.get(url);
    if (s) s.hash = hash;
  }

  private post(map: Map<string, PageSet>, key: string, id: number): void {
    let s = map.get(key);
    if (!s) map.set(key, (s = PageSet.empty(this.size)));
    s.add(id);
  }

  addToken(token: string, id: number): void {
    this.post(this.tokens, token, id);
  }

  addRuntimeToken(token: string, id: number): void {
    this.post(this.runtime, token, id);
  }

  addUsage(key: string, id: number): void {
    this.post(this.usage, key, id);
  }

  addSheet(url: string, hash: string | undefined, id: number): void {
    let s = this.sheets.get(url);
    if (!s) this.sheets.set(url, (s = { hash, pages: PageSet.empty(this.size) }));
    if (hash) s.hash = hash;
    s.pages.add(id);
  }

  /** status: 0 = no match, 1 = match, 2 = rejected by Chromium. */
  addSelectorResult(key: string, variant: number, id: number, status: number): void {
    let e = this.selectors.get(key);
    if (!e) {
      e = {
        byVariant: this.variants.map(() => PageSet.empty(this.size)),
        evaluated: PageSet.empty(this.size),
        rejected: PageSet.empty(this.size),
      };
      this.selectors.set(key, e);
    }
    e.evaluated.add(id);
    if (status === 1) e.byVariant[variant].add(id);
    else if (status === 2) e.rejected.add(id);
  }

  addMatcherCheck(feature: string, agree: boolean, example?: string): void {
    let c = this.checks.get(feature);
    if (!c) this.checks.set(feature, (c = { feature, agree: 0, disagree: 0 }));
    if (agree) c.agree++;
    else {
      c.disagree++;
      c.example ??= example;
    }
  }

  matchesOf(key: string, id: number): boolean {
    const e = this.selectors.get(key);
    return !!e && e.byVariant.some((s) => s.has(id));
  }

  /** Writes all rows for `rev` and publishes it. */
  publish(store: Store, rev: number, notes: Record<string, unknown>): void {
    const db = store.db;
    const nonEmpty = (s: PageSet) => !s.isEmpty();
    db.transaction(() => {
      const insPage = db.prepare("INSERT INTO page (rev, id, url, data) VALUES (?, ?, ?, ?)");
      for (let id = 0; id < this.size; id++) {
        const row: PageRow = this.pages.get(id) ?? {
          id,
          url: this.urls[id],
          status: "removed",
          quirks: false,
          trees: {},
          shells: {},
          assets: {},
          capturedAt: new Date().toISOString(),
        };
        insPage.run(rev, id, row.url, JSON.stringify(row));
      }
      const insTok = db.prepare("INSERT INTO token_posting (rev, token, runtime, pages) VALUES (?, ?, ?, ?)");
      for (const [k, v] of this.tokens) if (nonEmpty(v)) insTok.run(rev, k, 0, v.toBuffer());
      for (const [k, v] of this.runtime) if (nonEmpty(v)) insTok.run(rev, k, 1, v.toBuffer());
      const insUse = db.prepare("INSERT INTO usage_posting (rev, key, pages) VALUES (?, ?, ?)");
      for (const [k, v] of this.usage) if (nonEmpty(v)) insUse.run(rev, k, v.toBuffer());
      const insSheet = db.prepare("INSERT INTO stylesheet (rev, url, content_hash, pages) VALUES (?, ?, ?, ?)");
      for (const [k, v] of this.sheets) if (nonEmpty(v.pages)) insSheet.run(rev, k, v.hash ?? null, v.pages.toBuffer());
      const insSel = db.prepare("INSERT INTO selector_match (rev, key, by_variant, evaluated, rejected) VALUES (?, ?, ?, ?, ?)");
      for (const [k, e] of this.selectors) {
        if (!nonEmpty(e.evaluated)) continue;
        insSel.run(rev, k, Buffer.concat(e.byVariant.map((s) => s.toBuffer())), e.evaluated.toBuffer(), nonEmpty(e.rejected) ? e.rejected.toBuffer() : null);
      }
      const insCheck = db.prepare("INSERT INTO matcher_check (rev, feature, agree, disagree, example) VALUES (?, ?, ?, ?, ?)");
      for (const c of this.checks.values()) insCheck.run(rev, c.feature, c.agree, c.disagree, c.example ?? null);
    })();
    store.publishRevision(rev, this.size, notes);
  }
}
