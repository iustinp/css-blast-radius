import { describe, expect, it } from "vitest";
import { formatAge, formatChange, formatCount, freshnessText, isZero, reasonText, shortReason, span, tokenText } from "../src/format";
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
