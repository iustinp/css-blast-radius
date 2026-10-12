// Workspace configuration (cbr.config.json, optional). Defaults make a static
// site folder work with no config: serve it from disk, capture every *.html.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Profile {
  name: string;
  width: number;
  height: number;
  isMobile?: boolean;
  deviceScaleFactor?: number;
  userAgent?: string;
}

export interface RecipeStep {
  click?: string;
  hover?: string;
  fill?: [string, string];
  press?: string;
  waitFor?: string;
  waitMs?: number;
}

/** A scripted page state, captured as its own variant (§5.1). */
export interface Recipe {
  name: string;
  /** Regex on the page URL path; recipes run only on matching pages. */
  urls?: string;
  profile?: string;
  steps: RecipeStep[];
}

export interface StylesheetMapping {
  /** URL path prefix, e.g. "/css/". */
  urlPrefix: string;
  /** Absolute directory holding the files served under urlPrefix. */
  dir: string;
}

export interface CbrConfig {
  workspaceRoot: string;
  /** Root mode: the site is a folder served from disk at `origin`. */
  siteRoot?: string;
  /** Live mode: capture from this origin (staging/production). */
  baseUrl?: string;
  origin: string;
  /** Page paths (root-relative). Default: every *.html under siteRoot, or sitemap.xml. */
  urls?: string[];
  profiles: Profile[];
  recipes: Recipe[];
  stylesheets: StylesheetMapping[];
  capture: {
    concurrency: number;
    timeoutMs: number;
    /** Share of pages whose L2 shell is checked against the live render. */
    fidelitySample: number;
    /** Share of non-matching selectors cross-checked with the L1 matcher. */
    matcherSample: number;
  };
  dataDir: string;
}

export const ROOT_ORIGIN = "http://site.local";

export const DEFAULT_PROFILES: Profile[] = [{ name: "desktop", width: 1280, height: 800 }];

export const KNOWN_PROFILES: Record<string, Profile> = {
  desktop: DEFAULT_PROFILES[0],
  mobile: { name: "mobile", width: 390, height: 844, isMobile: true, deviceScaleFactor: 3 },
};

export function loadConfig(workspaceRoot: string, overrides: Partial<{ siteRoot: string; baseUrl: string; dataDir: string }> = {}): CbrConfig {
  const ws = resolve(workspaceRoot);
  const file = join(ws, "cbr.config.json");
  const raw: any = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(ws, p));

  const baseUrl: string | undefined = overrides.baseUrl ?? raw.baseUrl;
  const siteRoot = overrides.siteRoot ? abs(overrides.siteRoot) : raw.root ? abs(raw.root) : baseUrl ? undefined : ws;
  const origin = baseUrl ? new URL(baseUrl).origin : ROOT_ORIGIN;

  const profiles: Profile[] = (raw.profiles ?? ["desktop"]).map((p: string | Profile) =>
    typeof p === "string" ? KNOWN_PROFILES[p] ?? { ...DEFAULT_PROFILES[0], name: p } : p,
  );

  const stylesheets: StylesheetMapping[] = (raw.stylesheets ?? []).map((m: any) => ({ urlPrefix: m.urlPrefix, dir: abs(m.dir) }));
  if (stylesheets.length === 0 && siteRoot) stylesheets.push({ urlPrefix: "/", dir: siteRoot });

  return {
    workspaceRoot: ws,
    siteRoot,
    baseUrl,
    origin,
    urls: raw.urls,
    profiles,
    recipes: raw.recipes ?? [],
    stylesheets,
    capture: {
      concurrency: raw.capture?.concurrency ?? 6,
      timeoutMs: raw.capture?.timeoutMs ?? 20_000,
      fidelitySample: raw.capture?.fidelitySample ?? 0.1,
      matcherSample: raw.capture?.matcherSample ?? 0.1,
    },
    dataDir: overrides.dataDir ? abs(overrides.dataDir) : abs(raw.dataDir ?? ".css-blast-radius"),
  };
}

/** Workspace file → stylesheet URL path(s) it is served as. */
export function urlsForFile(cfg: CbrConfig, file: string): string[] {
  const out: string[] = [];
  const f = resolve(file);
  for (const m of cfg.stylesheets) {
    const rel = relative(m.dir, f);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const prefix = m.urlPrefix.endsWith("/") ? m.urlPrefix : m.urlPrefix + "/";
    out.push(prefix + rel.split(sep).join("/"));
  }
  return out;
}

/** URL path → file on disk (root mode), or undefined if outside the site root. */
export function fileForUrlPath(cfg: CbrConfig, path: string): string | undefined {
  if (!cfg.siteRoot) return undefined;
  let p: string;
  try {
    p = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (p.includes("\0")) return undefined;
  const target = resolve(cfg.siteRoot, "." + (p.endsWith("/") ? p + "index.html" : p));
  const rel = relative(cfg.siteRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return target;
}
