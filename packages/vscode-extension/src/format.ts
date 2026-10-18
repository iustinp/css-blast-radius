// How numbers read (§7.1 / §8). Pure functions: no vscode import, unit-tested.

import type { ChangeAnswer, Count, DiffBaseKind, FileAnswer, Freshness, RuleCount, WatchStatus } from "./protocol";

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

export const KIND_LABEL: Record<string, string> = {
  declarations: "Declarations changed",
  selector: "Selector changed",
  condition: "Condition changed",
  added: "Rule added",
  removed: "Rule removed",
  moved: "Rule moved",
  definition: "Definition changed",
  "layer-order": "Layer order changed",
  import: "@import changed",
  namespace: "@namespace changed",
  unrecognized: "At-rule changed",
};

/** What an edit is called in lists: its selector, else the definition or kind. */
export function editLabel(ch: ChangeAnswer): string {
  if (ch.selector) return ch.selector;
  if (ch.definition) return `@${ch.definition.kind} ${ch.definition.name}`;
  return KIND_LABEL[ch.kind] ?? ch.kind;
}

/** A removed rule or a changed selector that stops reaching at least `threshold` pages. */
export function losesPages(ch: ChangeAnswer, threshold: number): boolean {
  const lost = ch.kind === "removed" ? ch.lost ?? ch.pages : ch.kind === "selector" ? ch.lost : undefined;
  return !!lost && lost.exact >= threshold;
}

/** `3 edits`, `1 edit`. */
export const editsText = (n: number) => `${n.toLocaleString("en-US")} edit${n === 1 ? "" : "s"}`;

/** A file badge holds 2 characters. */
export const badgeText = (n: number) => (n > 99 ? "+" : String(n));

/**
 * The page lists one edit splits into. Only a changed selector has more than one:
 * the pages that gain the rule (only the new selector matches) and those that lose it
 * (only the old one matched). A new or removed rule's side would repeat its pages.
 */
export function editSides(ch: ChangeAnswer): Array<"pages" | "gained" | "lost"> {
  return ch.gained && ch.lost ? ["pages", "gained", "lost"] : ["pages"];
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

/**
 * The All tab's line about the scan it compares with: which commit of the
 * site's branch it matches, and what the server is catching up on.
 */
export function scanLine(w: WatchStatus | undefined): { text: string; tip: string; busy: boolean } | undefined {
  if (!w?.enabled) return undefined;
  const c = w.code;
  const ct = w.content;
  const parts: string[] = [];
  const tips: string[] = [];
  const branch = c.branch ?? "the site's branch";
  const sha = c.mainCommit?.slice(0, 7);
  const behind = c.behind ? `${c.approx ? "about " : ""}${plural(c.behind, "commit")} behind ${branch}` : "";
  switch (c.state) {
    case "up-to-date":
      parts.push(sha ? `Scan matches ${branch} (${sha})` : "Scan matches the site's code");
      break;
    case "updating":
      parts.push(behind ? `Scan is ${behind}` : `${branch} changed`);
      if (c.pages) parts.push(`updating ${plural(c.pages)}`);
      break;
    case "waiting":
      parts.push(`${branch} changed, waiting for the site to serve it`);
      break;
    case "no-repo":
      parts.push("Can't follow the site's code: repository not found");
      break;
    case "error":
      parts.push("Couldn't check the site's code");
      break;
  }
  if (c.message) tips.push(c.message);
  if (ct.state === "updating") parts.push(`updating ${plural(ct.pages ?? 0)} edited on the site`);
  else if (ct.state === "error") parts.push("couldn't check page edits");
  if (ct.message && ct.state !== "up-to-date") tips.push(ct.message);
  if (c.state === "up-to-date" && (ct.state === "up-to-date" || ct.state === "unavailable" || ct.state === "off")) parts.push("up to date");
  if (!parts.length) return undefined;
  const text = parts.join(" · ");
  tips.push(
    "The All tab compares your CSS with the pages as last scanned. "
    + `The server checks the site every ${w.intervalSec % 60 === 0 ? plural(w.intervalSec / 60, "minute").replace(/^1 minute$/, "minute") : plural(w.intervalSec, "second")} `
    + "and rescans only the pages a merge or a page edit reaches. Settings are on the setup page.",
  );
  const busy = c.state === "updating" || c.state === "waiting" || ct.state === "updating";
  return { text: text[0].toUpperCase() + text.slice(1), tip: tips.join("\n\n"), busy };
}
