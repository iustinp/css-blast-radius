// Site settings of a local server (one server = one site): where pages are
// loaded from and which devices they are scanned on. Stored as settings.json
// in the data folder.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ROOT_ORIGIN, type CbrConfig, type Profile } from "../config.js";

export type Device = "desktop" | "mobile" | "tablet";

export const DEVICES: Record<Device, Profile> = {
  desktop: { name: "desktop", width: 1366, height: 768 },
  mobile: { name: "mobile", width: 390, height: 844, isMobile: true, deviceScaleFactor: 3 },
  tablet: { name: "tablet", width: 820, height: 1180, isMobile: true, deviceScaleFactor: 2 },
};

export interface SiteSettings {
  /** "https://www.example.com", or "" when siteFolder is used. */
  siteUrl: string;
  /** Absolute path of a folder holding the built site's HTML, or "". */
  siteFolder: string;
  devices: Device[];
}

/** An error whose message is shown to the user as is. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const DEFAULT_SETTINGS: SiteSettings = { siteUrl: "", siteFolder: "", devices: ["desktop"] };

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadSettings(dataDir: string): SiteSettings {
  const raw = readJson<Partial<SiteSettings>>(join(dataDir, "settings.json"), {});
  return { ...DEFAULT_SETTINGS, ...raw, devices: raw.devices?.length ? raw.devices : DEFAULT_SETTINGS.devices };
}

export function saveSettings(dataDir: string, s: SiteSettings): void {
  writeJson(join(dataDir, "settings.json"), s);
}

/** Checks and normalizes settings sent by the setup page. */
export function validateSettings(input: any): SiteSettings {
  let siteUrl = String(input?.siteUrl ?? "").trim();
  let siteFolder = String(input?.siteFolder ?? "").trim();
  // "www.example.com" typed into a single address box: a site, not a folder.
  if (!siteUrl && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(siteFolder) && !siteFolder.startsWith("/")) {
    siteUrl = siteFolder;
    siteFolder = "";
  }
  const devices = [...new Set((Array.isArray(input?.devices) ? input.devices : []) as string[])].filter((d): d is Device => d in DEVICES);
  if (!siteUrl && !siteFolder) throw new UserError("Enter the site's address or a folder with its pages.");
  if (siteUrl && siteFolder) throw new UserError("Use either a site address or a folder, not both.");
  if (devices.length === 0) throw new UserError("Pick at least one device.");
  let url = "";
  if (siteUrl) {
    let u: URL;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
    } catch {
      throw new UserError(`“${siteUrl}” isn't a web address.`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError("The site address must start with http:// or https://.");
    url = u.origin;
  }
  let folder = "";
  if (siteFolder) {
    if (!isAbsolute(siteFolder)) throw new UserError("Enter the folder's full path, e.g. /Users/me/site/dist.");
    folder = resolve(siteFolder);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new UserError(`The folder ${folder} doesn't exist.`);
  }
  return { siteUrl: url, siteFolder: folder, devices };
}

export function isConfigured(s: SiteSettings): boolean {
  return !!(s.siteUrl || s.siteFolder);
}

/** Identifies the site an index was built for: another site means a full rescan. */
export function siteKey(s: SiteSettings): string {
  return JSON.stringify([s.siteUrl, s.siteFolder, [...s.devices].sort()]);
}

/** The capture/analysis config for the site; workspaceRoot is set per project. */
export function buildConfig(s: SiteSettings, dataDir: string, urls: string[] = []): CbrConfig {
  return {
    workspaceRoot: dataDir,
    siteRoot: s.siteFolder || undefined,
    baseUrl: s.siteUrl || undefined,
    origin: s.siteUrl ? new URL(s.siteUrl).origin : ROOT_ORIGIN,
    urls,
    profiles: s.devices.map((d) => DEVICES[d]),
    recipes: [],
    stylesheets: [],
    capture: { concurrency: 6, timeoutMs: 20_000, fidelitySample: 0.1, matcherSample: 0.1 },
    dataDir,
  };
}

/**
 * A page given by the user (full URL, path, or "blog/a.html") → its path on
 * the site ("/blog/a.html?x=1"), or undefined when it can't be a page.
 */
export function pagePath(input: string, s: SiteSettings): string | undefined {
  const t = input.trim().replace(/^["']|["']$/g, "");
  if (!t || /^(javascript|mailto|tel|data):/i.test(t)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t)) return undefined;
  let u: URL;
  try {
    if (/^https?:\/\//i.test(t)) u = new URL(t);
    else if (t.startsWith("//")) u = new URL(`https:${t}`);
    else u = new URL(t.startsWith("/") ? t : `/${t}`, s.siteUrl || ROOT_ORIGIN);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  return (u.pathname || "/") + u.search;
}
