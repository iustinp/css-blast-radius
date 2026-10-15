import { describe, expect, it } from "vitest";
import { changeAtCursor, ghostText, reasonText, shortReason } from "../src/format";
import { ExternalNoticeBatch } from "../src/externalNotice";
import { diffUrl, isLocalServer, serverOrigin } from "../src/urls";
import { fileState, isPicked, normalize, pickedCount, single, toggleAll, toggleChange, toggleFile, toWire, type FileEdits, type Picked } from "../src/selection";
import type { ChangeAnswer, Count, FileAnswer, RuleCount, SessionTotal } from "../src/protocol";

const count = (exact: number, possible = 0): Count => ({ exact, possible, unknown: 0, complete: true });
const change = (line: number, extra: Partial<ChangeAnswer> = {}): ChangeAnswer => ({
  id: "a", kind: "declarations", line, pages: count(362), conditions: [], reasons: [], ...extra,
});
const answer = (changes: ChangeAnswer[], extra: Partial<FileAnswer> = {}): FileAnswer => ({
  queryId: "q", level: 0, indexRevision: 1, editRevision: 2, file: "/site/a.css", diffBase: "production",
  editing: false, total: count(815), totalReasons: [], changes, mapping: { mapped: true, urls: [], linkedPages: 1000 },
  freshness: null, basis: "LOCAL_INDEX", timingMs: 7, ...extra,
});
const rule = (line: number, endLine: number): RuleCount => ({
  line, endLine, selector: ".a", pages: count(362), conditions: [], reasons: [],
});
const session = (exact: number, editRevision: number): SessionTotal => ({
  total: count(exact), editRevision, indexRevision: 1, diffBase: "production", reasons: [], files: [],
});

describe("count at the cursor", () => {
  it("looks up a changed rule anywhere in its server range", () => {
    const changes = [change(3), change(12, { id: "b" })];
    expect(changeAtCursor(changes, [rule(3, 8), rule(12, 14)], 7)?.id).toBe("a");
    expect(changeAtCursor(changes, [rule(3, 8), rule(12, 14)], 14)?.id).toBe("b");
    expect(changeAtCursor(changes, [], 3)?.id).toBe("a");
    expect(changeAtCursor(changes, [rule(3, 8)], 9)).toBeUndefined();
    expect(changeAtCursor([change(3), change(5, { id: "nested" })], [rule(3, 12), rule(5, 8)], 6)?.id).toBe("nested");
  });

  it("renders counts, editing, multiple edits and a selector that stops matching", () => {
    const first = change(1);
    expect(ghostText(answer([first]), first)).toBe("◀ 362 pages");
    expect(ghostText(answer([first, change(5)]), first)).toBe("◀ 362 pages, 815 total (2 edits)");
    const small = change(3, { pages: count(2) });
    expect(ghostText(answer([first, small, change(5)], { total: count(56) }), small)).toBe("◀ 2 pages, 56 total (3 edits)");
    expect(ghostText(answer([first, small], { total: count(0, 56) }), small)).toBe("◀ 2 pages, up to 56 total (2 edits)");
    const one = change(3, { pages: count(1) });
    expect(ghostText(answer([one, change(5)], { total: count(1) }), one)).toBe("◀ 1 page, 1 total (2 edits)");
    expect(ghostText(answer([first], { editing: true }), first)).toBe("◀ finish typing…");
    const selector = change(1, { kind: "selector", pages: count(0), lost: count(649) });
    expect(ghostText(answer([selector]), selector)).toBe("◀ matches no page now · 649 lose this style ⚠");
    expect(ghostText(answer([selector, first], { total: count(56) }), selector))
      .toBe("◀ matches no page now, 56 total (2 edits) · 649 lose this style ⚠");
    const possible = change(1, { pages: count(0, 13) });
    expect(ghostText(answer([possible]), possible)).toBe("◀ up to 13 pages");
  });

  it("explains group scope and unmatched filenames without jargon", () => {
    for (const [code, label] of [
      ["no-linked-groups", "no page groups linked to this project"],
      ["not-in-linked-groups", "no page in the linked groups loads this file"],
      ["stylesheet-not-mapped", "file name doesn't match a scanned stylesheet"],
    ]) expect(shortReason(code)).toBe(label);
    expect(reasonText("no-linked-groups")).toContain("Link page groups");
    expect(reasonText("stylesheet-not-mapped")).toContain("only possible");
    const zero = change(1, { pages: count(0), reasons: ["not-in-linked-groups"] });
    expect(ghostText(answer([zero]), zero)).toBe("◀ 0 pages · no page in the linked groups loads this file");
    expect(ghostText(answer([zero, change(5, { pages: count(0) })], { total: count(0) }), zero))
      .toBe("◀ 0 pages · no page in the linked groups loads this file (2 edits)");
    const unseen = change(1, { pages: count(0), reasons: ["token-never-seen:c:is-playing"] });
    expect(ghostText(answer([unseen, change(5)], { total: count(56) }), unseen)).toBe("◀ 0 pages · .is-playing never seen, 56 total (2 edits)");
  });
});

describe("server and diff URLs", () => {
  it("uses the RPC origin and percent-encodes the page and session", () => {
    expect(diffUrl("http://localhost:4317", "my id", "/some page?a=1&b=2", true))
      .toBe("http://localhost:4317/diff?s=my%20id&url=%2Fsome%20page%3Fa%3D1%26b%3D2&embed=1");
    expect(isLocalServer(serverOrigin("http://127.0.0.1:4317"))).toBe(true);
    expect(isLocalServer(serverOrigin("http://example.com:4317"))).toBe(false);
    expect(() => serverOrigin("https://127.0.0.1:4317")).toThrow();
    expect(() => serverOrigin("http://localhost:4317/other")).toThrow();
  });
});

describe("outside-editor notification batching", () => {
  it("shows immediately, then merges and deduplicates changes inside ten seconds", () => {
    const notices = new ExternalNoticeBatch();
    notices.add(["a.css"], session(9, 1));
    expect(notices.take(100)?.files).toEqual(["a.css"]);
    notices.add(["a.css", "b.css"], session(20, 2));
    notices.add(["c.css"], session(30, 3));
    expect(notices.delay(999)).toBe(9101);
    expect(notices.take(9_999)).toBeUndefined();
    expect(notices.take(10_100)).toEqual({ files: ["a.css", "b.css", "c.css"], session: session(30, 3) });
    expect(notices.take(10_101)).toBeUndefined();
  });

  it("remembers the count before the first change, and stays quiet when it's back to it", () => {
    const notices = new ExternalNoticeBatch();
    notices.add(["a.css"], session(9, 1), count(4));
    notices.add(["b.css"], session(12, 2), count(9));
    expect(notices.take(0)).toEqual({ files: ["a.css", "b.css"], session: session(12, 2), before: count(4) });
    notices.add(["a.css"], session(20, 3), count(12));
    notices.add(["a.css"], session(12, 4), count(20));
    expect(notices.waiting).toBe(true);
    expect(notices.take(20_000)).toBeUndefined();
    expect(notices.waiting).toBe(false);
  });
});

describe("picking edits in the panel", () => {
  const files: FileEdits[] = [
    { path: "/a.css", ids: ["a1", "a2", "a3"] },
    { path: "/b.css", ids: ["b1"] },
  ];
  const states = (sel: Picked) => files.map((f) => fileState(sel, f));

  it("starts with everything and toggles everything off and on", () => {
    let sel: Picked = undefined;
    expect(states(sel)).toEqual(["all", "all"]);
    sel = toggleAll(sel, files);
    expect(states(sel)).toEqual(["none", "none"]);
    expect(toWire(sel)).toEqual([]);
    sel = toggleAll(sel, files);
    expect(sel).toBeUndefined();
    expect(toWire(sel)).toBeUndefined();
  });

  it("unpicks the file and All edits when one of their edits is unpicked", () => {
    const sel = toggleChange(undefined, files, "/a.css", "a2");
    expect(states(sel)).toEqual(["some", "all"]);
    expect(isPicked(sel, "/a.css", "a2")).toBe(false);
    expect(pickedCount(sel, files)).toBe(3);
    expect(toWire(sel)).toEqual([{ path: "/a.css", changeIds: ["a1", "a3"] }, { path: "/b.css" }]);
  });

  it("picks the parents again once all their edits are picked", () => {
    let sel = toggleChange(undefined, files, "/a.css", "a2");
    sel = toggleChange(sel, files, "/a.css", "a2");
    expect(sel).toBeUndefined();
  });

  it("picks or unpicks every edit of a file", () => {
    let sel = toggleAll(undefined, files);
    sel = toggleFile(sel, files, "/a.css");
    expect(states(sel)).toEqual(["all", "none"]);
    expect(toWire(sel)).toEqual([{ path: "/a.css" }]);
    sel = toggleChange(sel, files, "/b.css", "b1");
    expect(sel).toBeUndefined();
    sel = toggleFile(sel, files, "/b.css");
    expect(toWire(sel)).toEqual([{ path: "/a.css" }]);
    // A partly picked file is picked whole on click.
    sel = toggleChange(sel, files, "/a.css", "a1");
    expect(states(sel)).toEqual(["some", "none"]);
    sel = toggleFile(sel, files, "/a.css");
    expect(states(sel)).toEqual(["all", "none"]);
  });

  it("keeps the picks while no edits are known (reconnecting)", () => {
    const sel = toggleChange(undefined, files, "/a.css", "a2");
    expect(normalize(sel, [])).toBe(sel);
  });

  it("knows when exactly one edit is picked", () => {
    let sel = toggleAll(undefined, files);
    expect(single(sel, files)).toBeUndefined();
    sel = toggleChange(sel, files, "/a.css", "a3");
    expect(single(sel, files)).toEqual({ path: "/a.css", id: "a3" });
    sel = toggleFile(sel, files, "/b.css");
    expect(single(sel, files)).toBeUndefined();
  });
});

