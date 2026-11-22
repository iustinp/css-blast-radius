import { describe, expect, it } from "vitest";
import { executedSegments, ranIn, subtractSegments, unionSegments } from "../src/util/coverage.js";

describe("script coverage segments", () => {
  // script [0,100) ran; f [10,40) ran, with a branch [20,30) that didn't; g [50,80) never ran.
  const functions = [
    { ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
    { ranges: [{ startOffset: 10, endOffset: 40, count: 2 }, { startOffset: 20, endOffset: 30, count: 0 }] },
    { ranges: [{ startOffset: 50, endOffset: 80, count: 0 }] },
  ];

  it("keeps the innermost range's verdict", () => {
    const segs = executedSegments(functions);
    expect(segs).toEqual([0, 20, 30, 50, 80, 100]);
    expect(ranIn(segs, 12, 15)).toBe(true);
    expect(ranIn(segs, 22, 28)).toBe(false);
    expect(ranIn(segs, 55, 55)).toBe(false);
    expect(ranIn(segs, 79, 81)).toBe(true);
    expect(ranIn(segs, 100, 100)).toBe(false);
  });

  it("joins the variants of a page", () => {
    expect(unionSegments([0, 10, 30, 40], [5, 20, 50, 60])).toEqual([0, 20, 30, 40, 50, 60]);
    expect(unionSegments([], [1, 2])).toEqual([1, 2]);
  });

  it("keeps what ran that hadn't before", () => {
    expect(subtractSegments([0, 100], [10, 20, 30, 40])).toEqual([0, 10, 20, 30, 40, 100]);
    expect(subtractSegments([10, 20, 50, 60], [0, 30])).toEqual([50, 60]);
    expect(subtractSegments([10, 20], [15, 25])).toEqual([10, 15]);
    expect(subtractSegments([10, 20], [10, 20])).toEqual([]);
    expect(subtractSegments([10, 20], [])).toEqual([10, 20]);
  });
});
