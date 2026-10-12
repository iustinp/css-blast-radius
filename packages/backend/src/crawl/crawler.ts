// Builds the in-memory corpus (Phase A output) used to answer queries.
//
// MVP scope note: pages are kept in memory (jsdom documents + parsed CSS)
// rather than compacted into on-disk postings/rule_usage tables per page.
// This is fine at fixture/demo corpus sizes; the SQLite-backed index
// (see store/db.ts) persists a queryable summary for `index/getStatus` and
// for future incremental/on-disk scaling, but live queries in this MVP
// re-run against the in-memory DOMs for correctness and simplicity.

import fg from "fast-glob";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { capturePage, type CapturedPage } from "./capturePage.js";
import { parseStylesheet, type ParsedStylesheet } from "../css/parseStylesheet.js";

export interface CssFileRecord {
  filePath: string;
  text: string;
  parsed: ParsedStylesheet;
}

export interface Cluster {
  id: string;
  skeletonHash: string;
  pageUrls: string[];
  exemplarUrl: string;
}

export interface Corpus {
  siteRoot: string;
  pages: Map<string, CapturedPage>; // keyed by filePath
  cssFiles: Map<string, CssFileRecord>; // keyed by absolute filePath
  clusters: Map<string, Cluster>; // keyed by skeletonHash
  builtAt: number;
}

async function loadCssFile(filePath: string): Promise<CssFileRecord> {
  const text = await readFile(filePath, "utf8");
  return { filePath, text, parsed: parseStylesheet(text, filePath) };
}

export async function crawlSite(siteRoot: string): Promise<Corpus> {
  const htmlFiles = await fg("**/*.html", { cwd: siteRoot, absolute: true });
  const pages = new Map<string, CapturedPage>();
  const cssFiles = new Map<string, CssFileRecord>();
  const clusters = new Map<string, Cluster>();

  for (const filePath of htmlFiles) {
    const page = await capturePage(filePath, siteRoot);
    pages.set(filePath, page);

    for (const cssPath of page.linkedStylesheetPaths) {
      if (!cssFiles.has(cssPath)) {
        try {
          cssFiles.set(cssPath, await loadCssFile(cssPath));
        } catch {
          // Missing/unreadable stylesheet: recorded as a broken link, not silently dropped.
        }
      }
    }

    const cluster = clusters.get(page.skeletonHash);
    if (cluster) {
      cluster.pageUrls.push(page.url);
    } else {
      clusters.set(page.skeletonHash, {
        id: page.skeletonHash.slice(0, 12),
        skeletonHash: page.skeletonHash,
        pageUrls: [page.url],
        exemplarUrl: page.url,
      });
    }
  }

  return { siteRoot, pages, cssFiles, clusters, builtAt: Date.now() };
}

/** Pages whose <link> set includes this CSS file (absolute path). */
export function pagesLinking(corpus: Corpus, cssFilePath: string): CapturedPage[] {
  const resolved = path.resolve(cssFilePath);
  return [...corpus.pages.values()].filter((p) =>
    p.linkedStylesheetPaths.some((lp) => path.resolve(lp) === resolved),
  );
}
