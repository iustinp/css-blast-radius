// How numbers read (§7.1 / §8). Pure functions: no vscode import, unit-tested.

import type { ChangeAnswer, Count, Freshness } from "./protocol";

const plural = (n: number, word = "page") => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export function isZero(c: Count): boolean {
  return c.exact === 0 && c.possible === 0 && c.unknown === 0;
}

/** A range "5" or "5–9" (exact … exact + possible). */
export function span(c: Count): string {
  return c.possible ? `${c.exact}–${c.exact + c.possible}` : `${c.exact}`;
}

/**
 * `312 pages`, `312 pages (+14 possible)`, `Up to 340 pages`, `… · 3 unknown`,
 * `0 pages · <why>`.
 */
export function formatCount(c: Count, reasons: string[] = []): string {
  let s: string;
  if (isZero(c)) {
    const why = reasons.length ? shortReason(reasons[0]) : "";
    return why ? `0 pages · ${why}` : "0 pages";
  }
  if (c.exact === 0 && c.possible > 0) s = `Up to ${plural(c.possible)}`;
  else if (c.possible > 0) s = `${plural(c.exact)} (+${c.possible.toLocaleString("en-US")} possible)`;
  else s = plural(c.exact);
  if (c.unknown) s += ` · ${c.unknown.toLocaleString("en-US")} unknown`;
  return s;
}

/** End-of-line text for one change. */
export function formatChange(ch: ChangeAnswer): string {
  if (ch.kind === "selector" && ch.gained && ch.lost) {
    if (isZero(ch.gained) && isZero(ch.lost)) return "same pages";
    return `+${span(ch.gained)} / −${span(ch.lost)} pages`;
  }
  if (ch.kind === "removed") {
    const lost = ch.lost ?? ch.pages;
    return isZero(lost) ? formatCount(lost, ch.reasons) + " (rule removed)" : `rule removed · ${span(lost)} pages lose it`;
  }
  return formatCount(ch.pages, ch.reasons);
}

export function formatAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function freshnessText(f: Freshness | null): string {
  if (!f) return "no index";
  return `captured ${formatAge(f.ageMs)} (revision ${f.revision})${f.stale ? " · stale" : ""}`;
}

/** Token display: c:foo → .foo, i:x → #x, a:href → [href], t:li → li. */
export function tokenText(t: string): string {
  const k = t.slice(0, 2);
  const v = t.slice(2);
  if (k === "c:") return `.${v}`;
  if (k === "i:") return `#${v}`;
  if (k === "a:") return `[${v}]`;
  if (k === "t:") return v;
  return t;
}

/** One-line reason for decorations. */
export function shortReason(r: string): string {
  const [code, arg = ""] = splitReason(r);
  switch (code) {
    case "no-effective-change":
      return "no effective change";
    case "selector-never-matches":
      return "selector never matches";
    case "stylesheet-not-linked":
      return "no page links this file";
    case "stylesheet-not-mapped":
      return "file not mapped";
    case "index-missing":
      return "no index";
    case "index-stale":
      return "stale";
    case "token-never-seen":
      return `${tokenText(arg)} never seen`;
    case "definition-unused":
    case "custom-property-unused":
      return "not used";
    case "capture-failed":
      return `${arg} failed`;
    default:
      return code.replace(/-/g, " ");
  }
}

function splitReason(r: string): [string, string?] {
  const i = r.indexOf(":");
  return i < 0 ? [r] : [r.slice(0, i), r.slice(i + 1)];
}

/** Plain-language reason for the hover and panel. */
export function reasonText(r: string): string {
  const [code, arg = ""] = splitReason(r);
  switch (code) {
    case "no-effective-change":
      return "No effective change: the rules are the same as in the diff base.";
    case "selector-never-matches":
      return "The selector matches no element on any captured page.";
    case "stylesheet-not-linked":
      return "No captured page links this stylesheet.";
    case "stylesheet-not-mapped":
      return "This file isn't mapped to a deployed stylesheet: counted over all captured pages (upper bound).";
    case "index-missing":
      return "No index yet: run “CSS Blast Radius: Capture Site”.";
    case "index-stale":
      return "The index is older than your markup or this stylesheet: recapture for exact numbers.";
    case "token-never-seen":
      return `\`${tokenText(arg)}\` never appears on a captured page.`;
    case "added-by-js":
      return `\`${tokenText(arg)}\` is added by scripts at runtime: pages that load them are kept as possible.`;
    case "new-selector":
      return "New selector: the page list is being resolved.";
    case "matcher-unsupported":
      return `\`${arg}\` can't be evaluated on snapshots: matching pages are kept as possible.`;
    case "unknown-syntax-upper-bound":
      return "Unknown syntax: the count is an upper bound.";
    case "selector-not-analyzable":
      return "The selector can't be analyzed: the count is an upper bound.";
    case "invalid-selector":
      return `Invalid selector (${arg}): browsers drop this rule.`;
    case "capture-failed":
      return `${arg} page(s) failed to capture: they count as unknown.`;
    case "custom-property-scope":
      return "Custom property: counted where it is defined and used.";
    case "custom-property-unused":
      return "The custom property isn't used on any captured page.";
    case "definition-unused":
      return "Defined but never used on a captured page.";
    case "global-change":
      return `Global change (${arg}): may affect every page linking this file.`;
    case "chromium-rejects-selector":
      return "Chromium rejects this selector: browsers drop the rule.";
    case "parse-error":
      return `The file doesn't parse (${arg}): showing the last valid version.`;
    case "invalid-on-save":
      return `Invalid rule on save (${arg}): browsers will drop it.`;
    case "editing":
      return "You're mid-edit: showing the last valid version.";
    default:
      return r;
  }
}

export const DIFF_BASE_LABEL: Record<string, string> = {
  HEAD: "HEAD (uncommitted changes)",
  saved: "last save",
  session: "session start",
  production: "production (captured CSS)",
};
