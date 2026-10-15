// How numbers read (§7.1 / §8). Pure functions: no vscode import, unit-tested.

import type { ChangeAnswer, Count, DiffBaseKind, FileAnswer, Freshness, RuleCount } from "./protocol";

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

export function sameCount(a: Count, b: Count): boolean {
  return a.exact === b.exact && a.possible === b.possible && a.unknown === b.unknown;
}

/** `CSS changed outside the editor (1 file): now 40 pages affected (was 12 pages).` */
export function externalChangeText(files: number, after: Count, before?: Count): string {
  const head = `CSS changed outside the editor (${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"})`;
  const count = (c: Count) => formatCount(c).replace(/^Up to/, "up to");
  return before ? `${head}: now ${count(after)} affected (was ${count(before)}).` : `${head}: ${formatCount(after)} affected.`;
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

/**
 * The count at the cursor: the edit under it first, then, when the file has
 * other edits, all of them together (`2 pages, 56 total (6 edits)`).
 */
export function ghostText(answer: FileAnswer, change: ChangeAnswer): string {
  if (answer.editing) return "◀ finish typing…";
  const lost = change.lost ?? (change.kind === "removed" ? change.pages : undefined);
  const lostN = lost?.exact ?? 0;
  const lowerUpTo = (s: string) => s.replace(/^Up to /, "up to ");
  let text = lostN && change.kind === "selector" && isZero(change.pages)
    ? "matches no page now"
    : lowerUpTo(formatCount(change.pages, change.reasons));
  if (answer.changes.length > 1) {
    // All edits at 0 means this one is too: nothing to add but the edit count.
    if (!isZero(answer.total)) text += `, ${lowerUpTo(formatCount(answer.total).replace(/\bpages?\b/, "total"))}`;
    text += ` (${answer.changes.length} edits)`;
  }
  if (lostN) text += ` · ${lostN.toLocaleString("en-US")} lose this style ⚠`;
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

type Branch = { mainRef: string; behind: number; mainShown?: boolean };

/** The deployed branch's name without the remote (`origin/main` → `main`). */
export const mainName = (branch: Branch) => branch.mainRef.replace(/^[^/]+\//, "");

/** Shown when the branch lacks newer commits of the deployed branch: are they counted? */
export function branchNote(branch: Branch | undefined): string | undefined {
  if (!branch || branch.behind <= 0) return undefined;
  const n = branch.behind.toLocaleString("en-US");
  const head = `${mainName(branch)} has ${n} newer commit${branch.behind === 1 ? "" : "s"} not in your branch`;
  return branch.mainShown
    ? `${head}; their changes are counted as if your branch undid them.`
    : `${head}; only your branch's changes are counted.`;
}

export const DIFF_BASE_LABEL: Record<string, string> = {
  HEAD: "the last commit",
  saved: "the last save",
  session: "when this window opened",
  production: "the live site",
};

/** The panel's tabs, broadest first: each compares your CSS with a different starting point. */
export const TABS: Array<{ base: DiffBaseKind; name: string; tip: string }> = [
  { base: "production", name: "All", tip: "Every CSS change the live site doesn't have yet: committed, uncommitted, unsaved or made by other tools." },
  { base: "HEAD", name: "Uncommitted", tip: "Changes since your last commit, saved or not." },
  { base: "session", name: "This session", tip: "Changes since this window opened (a reload starts over)." },
  { base: "saved", name: "Unsaved", tip: "Typing you haven't saved yet." },
];

export const tabName = (base: string | undefined) => TABS.find((t) => t.base === base)?.name ?? "All";

/** Without git there's no last commit: "Uncommitted" falls back to "This session". */
export function effectiveBase(base: DiffBaseKind, git: boolean | undefined): DiffBaseKind {
  return base === "HEAD" && git === false ? "session" : base;
}

/** The setting's tab (empty: the default, Uncommitted). */
export function configuredBase(value: unknown): DiffBaseKind {
  return TABS.some((t) => t.base === value) ? (value as DiffBaseKind) : "HEAD";
}

export function noChangesText(diffBase: string | undefined, branch: Branch | undefined): string {
  switch (diffBase) {
    case "HEAD":
      return "No uncommitted CSS changes.";
    case "session":
      return "No CSS changes since this window opened.";
    case "saved":
      return "No unsaved CSS changes.";
    default:
      return branch && !branch.mainShown ? "Your branch has no CSS changes." : "No CSS changes compared with the live site.";
  }
}
