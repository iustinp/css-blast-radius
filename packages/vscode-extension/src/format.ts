// How numbers read (§7.1 / §8). Pure functions: no vscode import, unit-tested.

import type { ChangeAnswer, Count, FileAnswer, Freshness, RuleCount } from "./protocol";

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

/** A server change has a starting line; server rule ranges extend it to the cursor. */
export function changeAtCursor(changes: ChangeAnswer[], rules: RuleCount[], line: number): ChangeAnswer | undefined {
  const candidates = changes.flatMap((ch) => rules
    .filter((r) => r.line <= ch.line && ch.line <= r.endLine && r.line <= line && line <= r.endLine)
    .map((r) => ({ change: ch, size: r.endLine - r.line })));
  return candidates.sort((a, b) => a.size - b.size)[0]?.change ?? changes.find((ch) => ch.line === line);
}

export function ghostText(answer: FileAnswer, change: ChangeAnswer): string {
  if (answer.editing) return "◀ finish typing…";
  const lost = change.lost ?? (change.kind === "removed" ? change.pages : undefined);
  const lostN = lost?.exact ?? 0;
  let text: string;
  if (lostN && change.kind === "selector" && isZero(change.pages)) {
    text = `matches no page now · ${lostN.toLocaleString("en-US")} lose this style ⚠`;
  } else {
    const count = answer.changes.length > 1 ? answer.total : change.pages;
    text = formatCount(count, answer.changes.length > 1 ? answer.totalReasons : change.reasons).replace(/^Up to /, "up to ");
    if (lostN) text += ` · ${lostN.toLocaleString("en-US")} lose this style ⚠`;
  }
  if (answer.changes.length > 1) text += ` (${answer.changes.length} edits)`;
  return `◀ ${text}`;
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
      return "no linked group uses this";
    case "no-linked-groups":
      return "no page groups linked to this project";
    case "not-in-linked-groups":
      return "no page in the linked groups loads this file";
    case "stylesheet-not-mapped":
      return "file name doesn't match a scanned stylesheet";
    case "index-missing":
      return "no pages scanned yet";
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
      return "No effective change: the rules are the same as on the live site.";
    case "selector-never-matches":
      return "The selector matches no element on any scanned page.";
    case "stylesheet-not-linked":
      return "No page in a linked group uses this file.";
    case "no-linked-groups":
      return "No page groups are linked to this project. Link page groups to see page counts.";
    case "not-in-linked-groups":
      return "No page in the linked groups loads this file.";
    case "stylesheet-not-mapped":
      return "This file's name doesn't match any stylesheet on the scanned pages: counts are only possible.";
    case "index-missing":
      return "No pages scanned yet: run “CSS Blast Radius: Rescan Linked Groups”.";
    case "index-stale":
      return "Pages have changed since the last scan: rescan for exact numbers.";
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
      return `${arg} page(s) could not be scanned: their results are not known.`;
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
  HEAD: "last commit",
  saved: "last save",
  session: "when I opened VS Code",
  production: "the live site",
};
