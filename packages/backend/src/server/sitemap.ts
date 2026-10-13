// Reads a sitemap (or a sitemap index of sitemaps, gzipped or not) into the
// page paths of the site, optionally filtered by a path wildcard.

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";
import { pagePath, UserError, type SiteSettings } from "./settings.js";

const MAX_SITEMAPS = 200;
const MAX_URLS = 200_000;
const MAX_BYTES = 50 * 1024 * 1024;

/** "/blog/*" → a matcher on page paths ("*" = any characters). */
export function wildcard(filter: string | undefined): (path: string) => boolean {
  const f = (filter ?? "").trim();
  if (!f || f === "*") return () => true;
  const pat = f.startsWith("/") || f.startsWith("*") ? f : `/${f}`;
  const re = new RegExp(`^${pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return (p) => re.test(p);
}

function decode(xml: string): string {
  return xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

async function load(where: string, s: SiteSettings): Promise<string> {
  let buf: Buffer;
  if (/^https?:\/\//i.test(where)) {
    let res: Response;
    try {
      res = await fetch(where, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
    } catch (err: any) {
      throw new UserError(`Couldn't load ${where}: ${err?.cause?.code ?? err?.message ?? err}`);
    }
    if (!res.ok) throw new UserError(`${where} answered ${res.status} ${res.statusText}`.trim());
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    // A local site: the sitemap is a file in the site folder.
    if (!s.siteFolder) throw new UserError(`“${where}” isn't a web address.`);
    const p = (() => {
      try {
        return decodeURIComponent(new URL(where, "http://x").pathname);
      } catch {
        return where;
      }
    })();
    const file = resolve(s.siteFolder, "." + (p.startsWith("/") ? p : `/${p}`));
    const rel = relative(s.siteFolder, file);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new UserError("The sitemap must be inside the site folder.");
    if (!existsSync(file)) throw new UserError(`There's no ${p} in the site folder.`);
    buf = readFileSync(file);
  }
  if (buf.length > MAX_BYTES) throw new UserError(`${where} is too large (over 50 MB).`);
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf, { maxOutputLength: MAX_BYTES });
    } catch {
      throw new UserError(`${where} is too large once unzipped (over 50 MB), or isn't valid gzip.`);
    }
  }
  return buf.toString("utf8");
}

export interface SitemapResult {
  /** Pages listed in the sitemap(s), before the filter. */
  total: number;
  /** Matching page paths, sorted. */
  urls: string[];
  /** Pages skipped because they're on another site. */
  otherSite: number;
}

export async function readSitemap(url: string, s: SiteSettings, filter?: string): Promise<SitemapResult> {
  const start = url.trim();
  if (!start) throw new UserError("Enter the sitemap's address.");
  const base = s.siteUrl || undefined;
  const absolute = (u: string) => (/^https?:\/\//i.test(u) || !base ? u : new URL(u, base).href);
  const host = base ? new URL(base).hostname.replace(/^www\./, "") : undefined;
  const match = wildcard(filter);
  const queue = [absolute(start)];
  const seen = new Set<string>();
  const pages = new Set<string>();
  let total = 0;
  let otherSite = 0;
  while (queue.length && seen.size < MAX_SITEMAPS) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const xml = await load(next, s);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    if (!isIndex && !/<urlset[\s>]/i.test(xml)) {
      if (seen.size === 1) throw new UserError(`${next} isn't a sitemap (no <urlset> or <sitemapindex>).`);
      continue;
    }
    for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
      const loc = decode(m[1]);
      if (!loc) continue;
      if (isIndex) {
        queue.push(absolute(loc));
        continue;
      }
      if (host && /^https?:\/\//i.test(loc)) {
        try {
          if (new URL(loc).hostname.replace(/^www\./, "") !== host) {
            otherSite++;
            continue;
          }
        } catch {
          continue;
        }
      }
      const p = pagePath(loc, s);
      if (!p) continue;
      total++;
      if (match(p)) pages.add(p);
      if (pages.size >= MAX_URLS) break;
    }
  }
  return { total, urls: [...pages].sort(), otherSite };
}
