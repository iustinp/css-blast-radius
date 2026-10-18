import { describe, expect, it } from "vitest";
import { badgeText, branchNote, configuredBase, editLabel, editsText, losesPages, editSides, effectiveBase, externalChangeText, noChangesText, tabName, formatAge, formatChange, formatCount, freshnessText, isZero, reasonText, shortReason, span, tokenText } from "../src/format";
import type { ChangeAnswer, Count } from "../src/protocol";

const c = (exact: number, possible = 0, unknown = 0, complete = true): Count => ({ exact, possible, unknown, complete });
const change = (p: Partial<ChangeAnswer>): ChangeAnswer => ({ id: "x", kind: "declarations", line: 1, pages: c(0), conditions: [], reasons: [], ...p });

describe("formatCount", () => {
  it("reads exact, possible and unknown counts", () => {
    expect(formatCount(c(1))).toBe("1 page");
    expect(formatCount(c(312))).toBe("312 pages");
    expect(formatCount(c(1234))).toBe("1,234 pages");
    expect(formatCount(c(312, 14))).toBe("312 pages (+14 possible)");
    expect(formatCount(c(0, 40))).toBe("Up to 40 pages");
    expect(formatCount(c(5, 0, 3))).toBe("5 pages · 3 unknown");
  });

  it("explains a zero", () => {
    expect(formatCount(c(0))).toBe("0 pages");
    expect(formatCount(c(0), ["token-never-seen:c:promo"])).toBe("0 pages · .promo never seen");
    expect(formatCount(c(0), ["no-effective-change"])).toBe("0 pages · no effective change");
    expect(formatCount(c(0), ["some-new-code"])).toBe("0 pages · some new code");
  });
});

describe("editSides", () => {
  it("splits only a changed selector into the pages that gain and lose the rule", () => {
    expect(editSides(change({ kind: "selector", pages: c(10), gained: c(3), lost: c(7) }))).toEqual(["pages", "gained", "lost"]);
    expect(editSides(change({ kind: "added", pages: c(4), gained: c(4) }))).toEqual(["pages"]);
    expect(editSides(change({ kind: "removed", pages: c(4), lost: c(4) }))).toEqual(["pages"]);
    expect(editSides(change({ pages: c(51) }))).toEqual(["pages"]);
  });
});

describe("formatChange", () => {
  it("shows gained and lost for selector changes", () => {
    expect(formatChange(change({ kind: "selector", pages: c(10), gained: c(3, 2), lost: c(7) }))).toBe("+3–5 / −7 pages");
    expect(formatChange(change({ kind: "selector", pages: c(10), gained: c(0), lost: c(0) }))).toBe("same pages");
  });

  it("shows what a removal takes away", () => {
    expect(formatChange(change({ kind: "removed", pages: c(0), lost: c(45) }))).toBe("rule removed · 45 pages lose it");
    expect(formatChange(change({ kind: "removed", pages: c(0), lost: c(0), reasons: ["selector-never-matches"] }))).toBe("0 pages · selector never matches (rule removed)");
  });

  it("uses the page count otherwise", () => {
    expect(formatChange(change({ pages: c(51) }))).toBe("51 pages");
  });
});

describe("helpers", () => {
  it("span and isZero", () => {
    expect(span(c(4))).toBe("4");
    expect(span(c(4, 3))).toBe("4–7");
    expect(isZero(c(0))).toBe(true);
    expect(isZero(c(0, 0, 1))).toBe(false);
  });

  it("tokens", () => {
    expect(tokenText("c:card")).toBe(".card");
    expect(tokenText("i:main")).toBe("#main");
    expect(tokenText("a:href")).toBe("[href]");
    expect(tokenText("t:li")).toBe("li");
    expect(tokenText("weird")).toBe("weird");
  });

  it("ages and freshness", () => {
    expect(formatAge(10_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5 min ago");
    expect(formatAge(3 * 3_600_000)).toBe("3 h ago");
    expect(formatAge(5 * 86_400_000)).toBe("5 days ago");
    expect(freshnessText(null)).toBe("no index");
    expect(freshnessText({ revision: 2, capturedAt: "", ageMs: 120_000, stale: true })).toBe("captured 2 min ago (revision 2) · stale");
  });

  it("reasons", () => {
    expect(shortReason("capture-failed:3")).toBe("3 failed");
    expect(reasonText("invalid-on-save:line 12")).toBe("Invalid rule on save (line 12): browsers will drop it.");
    expect(reasonText("token-never-seen:c:promo")).toContain("`.promo`");
    expect(reasonText("unlisted")).toBe("unlisted");
  });
});

describe("branchNote", () => {
  it("says how many newer deployed-branch commits are left out", () => {
    expect(branchNote({ mainRef: "origin/main", behind: 7 })).toBe("main has 7 newer commits not in your branch; only your branch's changes are counted.");
    expect(branchNote({ mainRef: "upstream/release/v2", behind: 1 })).toBe("release/v2 has 1 newer commit not in your branch; only your branch's changes are counted.");
  });

  it("stays quiet when the branch is up to date or there is no branch", () => {
    expect(branchNote({ mainRef: "origin/main", behind: 2, mainShown: true })).toBe("main has 2 newer commits not in your branch; their changes are counted as if your branch undid them.");
    expect(branchNote({ mainRef: "origin/main", behind: 0 })).toBeUndefined();
    expect(branchNote(undefined)).toBeUndefined();
  });
});

describe("tabs", () => {
  it("starts on Uncommitted unless the setting names another tab", () => {
    expect(configuredBase("")).toBe("HEAD");
    expect(configuredBase(undefined)).toBe("HEAD");
    expect(configuredBase("production")).toBe("production");
    expect(configuredBase("nonsense")).toBe("HEAD");
    expect(tabName("production")).toBe("All");
    expect(tabName("session")).toBe("This session");
  });

  it("falls back from Uncommitted to This session without git", () => {
    expect(effectiveBase("HEAD", false)).toBe("session");
    expect(effectiveBase("HEAD", undefined)).toBe("HEAD"); // older servers don't say
    expect(effectiveBase("saved", false)).toBe("saved");
  });

  it("says plainly that there's nothing to show, per tab", () => {
    expect(noChangesText("HEAD", undefined)).toBe("No uncommitted CSS changes.");
    expect(noChangesText("production", { mainRef: "origin/main", behind: 1, mainShown: false })).toBe("Your branch has no CSS changes.");
    expect(noChangesText("production", { mainRef: "origin/main", behind: 1, mainShown: true })).toBe("No CSS changes compared with the live site.");
  });
});

describe("CSS changed outside the editor", () => {
  const c = (exact: number, possible = 0): Count => ({ exact, possible, unknown: 0, complete: true });
  it("says how the count moved", () => {
    expect(externalChangeText(1, c(40), c(12))).toBe("CSS changed outside the editor (1 file): now 40 pages affected (was 12 pages).");
    expect(externalChangeText(2, c(0, 5), c(0))).toBe("CSS changed outside the editor (2 files): now up to 5 pages affected (was 0 pages).");
    expect(externalChangeText(1, c(3))).toBe("CSS changed outside the editor (1 file): 3 pages affected.");
  });
});

describe("live-site helpers", () => {
  it("names an edit by its selector, definition or kind", () => {
    expect(editLabel(change({ selector: ".btn" }))).toBe(".btn");
    expect(editLabel(change({ kind: "definition", definition: { kind: "keyframes", name: "spin", change: "changed" } }))).toBe("@keyframes spin");
    expect(editLabel(change({ kind: "declarations" }))).not.toBe("");
  });

  it("warns only when a removed rule or changed selector loses enough pages", () => {
    expect(losesPages(change({ kind: "removed", pages: c(12) }), 10)).toBe(true);
    expect(losesPages(change({ kind: "removed", pages: c(12), lost: c(3) }), 10)).toBe(false);
    expect(losesPages(change({ kind: "selector", pages: c(50), lost: c(10) }), 10)).toBe(true);
    expect(losesPages(change({ kind: "selector", pages: c(50) }), 10)).toBe(false);
    expect(losesPages(change({ kind: "declarations", pages: c(500), lost: c(500) }), 10)).toBe(false);
  });

  it("counts edits and fits a two-character badge", () => {
    expect(editsText(1)).toBe("1 edit");
    expect(editsText(1200)).toBe("1,200 edits");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("+");
  });
});
