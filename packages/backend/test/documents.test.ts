import { describe, expect, it } from "vitest";
import {
  Doc,
  ResyncNeeded,
  applyChanges,
  sha256,
  type TextChange,
} from "../src/daemon/documents.js";

describe("applyChanges utility", () => {
  it("replaces the entire text when range is omitted", () => {
    const res = applyChanges("old text", [{ text: "new text" }]);
    expect(res).toBe("new text");
  });

  it("applies single ranged change on a single line", () => {
    const original = ".btn { color: red; }";
    const changes: TextChange[] = [
      {
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } },
        text: "blue",
      },
    ];
    expect(applyChanges(original, changes)).toBe(".btn { color: blue; }");
  });

  it("applies multi-change batches in sequential order", () => {
    const original = "alpha beta gamma";
    // Change "beta" to "BETA", then change "gamma" to "GAMMA"
    // Sequential means the second change is evaluated against the intermediate text!
    const change1: TextChange = {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      text: "BETA",
    };
    const change2: TextChange = {
      range: { start: { line: 0, character: 11 }, end: { line: 0, character: 16 } },
      text: "GAMMA",
    };
    expect(applyChanges(original, [change1, change2])).toBe("alpha BETA GAMMA");
  });

  it("handles UTF-16 surrogate pairs (emoji) in character offsets", () => {
    // 🚀 is represented by surrogate pair \uD83D\uDE80 (2 UTF-16 code units)
    const textWithEmoji = "/* 🚀 */ .rocket { color: red; }";
    // "/* " is 3 chars. 🚀 is 2 chars. " */ " is 4 chars.
    // So character 9 is the start of ".rocket"
    const change: TextChange = {
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } },
      text: ".starship",
    };
    expect(applyChanges(textWithEmoji, [change])).toBe("/* 🚀 */ .starship { color: red; }");
  });

  it("handles CRLF (\\r\\n) line endings properly", () => {
    const crlfText = ".first {\r\n  color: red;\r\n}\r\n.second {\r\n  color: blue;\r\n}";
    // Edit on line 4 (.second's color)
    const change: TextChange = {
      range: { start: { line: 4, character: 9 }, end: { line: 4, character: 13 } },
      text: "navy",
    };
    const result = applyChanges(crlfText, [change]);
    expect(result).toBe(".first {\r\n  color: red;\r\n}\r\n.second {\r\n  color: navy;\r\n}");
  });

  it("handles insertion at the end of document", () => {
    const text = ".card { padding: 8px; }\n";
    const change: TextChange = {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      text: ".card .title { font-weight: bold; }\n",
    };
    expect(applyChanges(text, [change])).toBe(".card { padding: 8px; }\n.card .title { font-weight: bold; }\n");
  });

  it("clamps out-of-bounds positions past EOF", () => {
    const text = "abc";
    const change: TextChange = {
      range: { start: { line: 99, character: 99 }, end: { line: 99, character: 99 } },
      text: "def",
    };
    expect(applyChanges(text, [change])).toBe("abcdef");
  });
});

describe("Doc class lifecycle and change sync", () => {
  it("initializes version, text, and saved hash", () => {
    const doc = new Doc("/path/style.css", ".btn { color: red; }", 1, ".btn { color: red; }");
    expect(doc.version).toBe(1);
    expect(doc.text).toBe(".btn { color: red; }");
    expect(doc.saved).toBe(true);
    expect(doc.savedHash).toBe(sha256(".btn { color: red; }"));
  });

  it("accepts full-replacement change at any version", () => {
    const doc = new Doc("/path/style.css", ".btn { color: red; }", 1, ".btn { color: red; }");
    // version jumps from 1 to 10
    doc.change(10, [{ text: ".btn { color: blue; }" }]);
    expect(doc.version).toBe(10);
    expect(doc.text).toBe(".btn { color: blue; }");
    expect(doc.saved).toBe(false);
  });

  it("accepts ranged change when version === current + 1", () => {
    const doc = new Doc("/path/style.css", ".btn { color: red; }", 1, ".btn { color: red; }");
    doc.change(2, [
      {
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } },
        text: "blue",
      },
    ]);
    expect(doc.version).toBe(2);
    expect(doc.text).toBe(".btn { color: blue; }");
  });

  it("throws ResyncNeeded (-32001) when ranged change has a version gap", () => {
    const doc = new Doc("/path/style.css", ".btn { color: red; }", 1, ".btn { color: red; }");
    try {
      doc.change(3, [
        {
          range: { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } },
          text: "blue",
        },
      ]);
      expect.fail("Should have thrown ResyncNeeded");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ResyncNeeded);
      expect(err.code).toBe(-32001);
      expect(err.message).toContain("resend the full text");
    }
  });

  it("updates savedHash and saved status on save()", () => {
    const doc = new Doc("/path/style.css", ".btn { color: red; }", 1, ".btn { color: red; }");
    doc.change(2, [{ text: ".btn { color: green; }" }]);
    expect(doc.saved).toBe(false);

    doc.save(undefined);
    expect(doc.saved).toBe(true);
    expect(doc.savedHash).toBe(sha256(".btn { color: green; }"));

    doc.save(".btn { color: purple; }");
    expect(doc.text).toBe(".btn { color: purple; }");
    expect(doc.saved).toBe(true);
    expect(doc.savedHash).toBe(sha256(".btn { color: purple; }"));
  });
});

describe("Doc.current() parsing semantics (§6.1)", () => {
  it("valid text becomes lastValid, editing=false, notes empty", () => {
    const doc = new Doc("/style.css", ".btn { color: red; }", 1, ".btn { color: red; }");
    const cur = doc.current();
    expect(cur.editing).toBe(false);
    expect(cur.notes).toEqual([]);
    expect(cur.model.rules).toHaveLength(1);
    expect(cur.model.rules[0].selectorText).toBe(".btn");
  });

  it("unsaved text with a parse error returns lastValid with editing=true", () => {
    const doc = new Doc("/style.css", ".btn { color: red; }", 1, ".btn { color: red; }");
    doc.current(); // establish lastValid

    // Introduce a parse error while editing (e.g. unclosed stray curly braces)
    doc.change(2, [{ text: ".btn { color: red; } }" }]);
    expect(doc.saved).toBe(false);

    const cur = doc.current();
    expect(cur.editing).toBe(true);
    expect(cur.text).toBe(".btn { color: red; }"); // returned lastValid text
    expect(cur.model.rules).toHaveLength(1);
    expect(cur.model.rules[0].selectorText).toBe(".btn");
  });

  it("unsaved text with an invalid selector substitutes the last valid rule at the same start line", () => {
    const validCss = ".first { color: red; }\n.btn { color: green; }";
    const doc = new Doc("/style.css", validCss, 1, validCss);
    doc.current(); // establish lastValid

    // Break the second selector while typing: ".btn > >" on line 2 (0-indexed line 1)
    const typingCss = ".first { color: red; }\n.btn > > { color: green; }";
    doc.change(2, [{ text: typingCss }]);
    expect(doc.saved).toBe(false);

    const cur = doc.current();
    expect(cur.editing).toBe(true);
    expect(cur.model.rules).toHaveLength(2);
    expect(cur.model.rules[0].selectorText).toBe(".first");
    // Substituted rule from lastValid at the same line
    expect(cur.model.rules[1].selectorText).toBe(".btn");
  });

  it("saved text with invalid selector drops invalid rules with invalid-on-save:line N notes", () => {
    const invalidCss = ".valid { color: red; }\n.invalid > > .broken { color: blue; }";
    const doc = new Doc("/style.css", invalidCss, 1, invalidCss);
    // Already saved on disk
    expect(doc.saved).toBe(true);

    const cur = doc.current();
    expect(cur.editing).toBe(false);
    expect(cur.model.rules).toHaveLength(1);
    expect(cur.model.rules[0].selectorText).toBe(".valid");
    expect(cur.notes).toHaveLength(1);
    expect(cur.notes[0]).toMatch(/^invalid-on-save:line 2/);
  });

  it("saved text with a parse error returns lastValid with parse-error:line N note and editing=false", () => {
    const validCss = ".btn { color: red; }";
    const doc = new Doc("/style.css", validCss, 1, validCss);
    doc.current(); // establish lastValid

    const badCss = ".btn { color: red; } }";
    doc.change(2, [{ text: badCss }]);
    doc.save(undefined);
    expect(doc.saved).toBe(true);

    const cur = doc.current();
    expect(cur.editing).toBe(false);
    expect(cur.model.rules).toHaveLength(1);
    expect(cur.model.rules[0].selectorText).toBe(".btn");
    expect(cur.notes.some((n) => n.startsWith("parse-error:"))).toBe(true);
  });

  it("document starting with a parse error (no previous lastValid) keeps what browsers keep", () => {
    const badCss = ".broken { color: red; } }";
    const doc = new Doc("/style.css", badCss, 1, badCss);
    const cur = doc.current();
    expect(cur.editing).toBe(false);
    expect(cur.model.rules.map((r) => r.selectorText)).toEqual([".broken"]);
    expect(cur.notes.some((n) => n.startsWith("parse-error:"))).toBe(true);

    // Unsaved from the start: no last valid version to fall back on.
    const docUnsaved = new Doc("/style.css", badCss, 1, undefined);
    docUnsaved.savedHash = "different";
    const curUnsaved = docUnsaved.current();
    expect(curUnsaved.editing).toBe(true);
    expect(curUnsaved.model.rules.map((r) => r.selectorText)).toEqual([".broken"]);
  });
});
