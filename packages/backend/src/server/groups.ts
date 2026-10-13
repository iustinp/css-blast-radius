// Page groups: named lists of pages (from a sitemap, a CSV or pasted URLs)
// that can be paused, rescanned and linked to projects. Stored in
// groups.json; a deleted group can be restored for 5 minutes.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJson, UserError, writeJson } from "./settings.js";

export type GroupSource = { type: "sitemap"; url: string; filter?: string } | { type: "csv"; file: string } | { type: "paste" };

export interface Group {
  id: string;
  name: string;
  active: boolean;
  source: GroupSource;
  /** Member page paths (excluded pages are not in here). */
  urls: string[];
  /** Sitemap groups: pages the user removed; they stay out on rescan. */
  excluded: string[];
  createdAt: string;
  scannedAt: string | null;
  deletedAt?: string;
}

export const RESTORE_MS = 5 * 60_000;

function checkSource(src: any): GroupSource {
  switch (src?.type) {
    case "sitemap":
      if (!String(src.url ?? "").trim()) throw new UserError("Enter the sitemap's address.");
      return { type: "sitemap", url: String(src.url).trim(), ...(src.filter ? { filter: String(src.filter).trim() } : {}) };
    case "csv":
      return { type: "csv", file: String(src.file ?? "pages.csv") };
    case "paste":
      return { type: "paste" };
    default:
      throw new UserError("Choose where the pages come from: a sitemap, a CSV file or a list of addresses.");
  }
}

export class Groups {
  private readonly file: string;
  private list: Group[];

  constructor(dataDir: string) {
    this.file = join(dataDir, "groups.json");
    this.list = readJson<{ groups?: Group[] }>(this.file, {}).groups ?? [];
    this.purge();
  }

  private save(): void {
    writeJson(this.file, { groups: this.list });
  }

  /** Drops groups deleted more than 5 minutes ago. */
  purge(now = Date.now()): boolean {
    const before = this.list.length;
    this.list = this.list.filter((g) => !g.deletedAt || now - Date.parse(g.deletedAt) < RESTORE_MS);
    if (this.list.length !== before) this.save();
    return this.list.length !== before;
  }

  all(): Group[] {
    return this.list.filter((g) => !g.deletedAt);
  }

  find(id: string): Group | undefined {
    return this.list.find((g) => g.id === id && !g.deletedAt);
  }

  get(id: string): Group {
    const g = this.find(id);
    if (!g) throw new UserError("That group doesn't exist (it may have been deleted).", 404);
    return g;
  }

  create(name: string, source: unknown, urls: string[]): Group {
    const n = String(name ?? "").trim();
    if (!n) throw new UserError("Give the group a name.");
    if (n.length > 80) throw new UserError("Use a shorter name (80 characters at most).");
    if (this.all().some((g) => g.name.toLowerCase() === n.toLowerCase())) throw new UserError(`There's already a group called “${n}”.`);
    const g: Group = {
      id: randomBytes(5).toString("hex"),
      name: n,
      active: true,
      source: checkSource(source),
      urls: [...new Set(urls)].sort(),
      excluded: [],
      createdAt: new Date().toISOString(),
      scannedAt: null,
    };
    this.list.push(g);
    this.save();
    return g;
  }

  update(id: string, patch: { name?: unknown; active?: unknown }): Group {
    const g = this.get(id);
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) throw new UserError("Give the group a name.");
      if (this.all().some((x) => x !== g && x.name.toLowerCase() === n.toLowerCase())) throw new UserError(`There's already a group called “${n}”.`);
      g.name = n;
    }
    if (patch.active !== undefined) g.active = !!patch.active;
    this.save();
    return g;
  }

  remove(id: string): void {
    const g = this.get(id);
    g.deletedAt = new Date().toISOString();
    this.save();
  }

  restore(id: string): Group {
    this.purge();
    const g = this.list.find((x) => x.id === id && x.deletedAt);
    if (!g) throw new UserError("That group can't be restored any more.", 404);
    if (this.all().some((x) => x.name.toLowerCase() === g.name.toLowerCase())) g.name = `${g.name} (restored)`;
    delete g.deletedAt;
    this.save();
    return g;
  }

  addPages(id: string, urls: string[]): { added: number; already: number } {
    const g = this.get(id);
    const have = new Set(g.urls);
    let added = 0;
    let already = 0;
    for (const u of new Set(urls)) {
      if (have.has(u)) already++;
      else {
        have.add(u);
        added++;
      }
    }
    g.urls = [...have].sort();
    g.excluded = g.excluded.filter((u) => !have.has(u));
    this.save();
    return { added, already };
  }

  removePage(id: string, url: string): { excluded: boolean } {
    const g = this.get(id);
    const was = g.urls.includes(url);
    g.urls = g.urls.filter((u) => u !== url);
    const excluded = g.source.type === "sitemap" && was;
    if (excluded && !g.excluded.includes(url)) g.excluded.push(url);
    this.save();
    return { excluded };
  }

  include(id: string, url: string): void {
    const g = this.get(id);
    g.excluded = g.excluded.filter((u) => u !== url);
    if (!g.urls.includes(url)) g.urls = [...g.urls, url].sort();
    this.save();
  }

  /** A sitemap re-read: new pages join, pages gone from the sitemap leave (exclusions stay). */
  setSitemapPages(id: string, urls: string[]): { added: string[]; removed: string[] } {
    const g = this.get(id);
    const excluded = new Set(g.excluded);
    const next = new Set(urls.filter((u) => !excluded.has(u)));
    const prev = new Set(g.urls);
    const added = [...next].filter((u) => !prev.has(u));
    const removed = [...prev].filter((u) => !next.has(u));
    g.urls = [...next].sort();
    this.save();
    return { added, removed };
  }

  scanned(id: string, at = new Date().toISOString()): void {
    const g = this.find(id);
    if (!g) return;
    g.scannedAt = at;
    this.save();
  }

  /** Pages of every active group. */
  activeUrls(): Set<string> {
    const out = new Set<string>();
    for (const g of this.all()) if (g.active) for (const u of g.urls) out.add(u);
    return out;
  }
}
