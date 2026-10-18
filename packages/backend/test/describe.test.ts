import { describe, expect, it } from "vitest";
import { parseStylesheet } from "../src/css/model.js";
import { diffModels } from "../src/css/diff.js";
import { changeLines, commonLines, describeChange } from "../src/css/describe.js";

const one = (before: string, after: string) => {
  const changes = diffModels(parseStylesheet(before), parseStylesheet(after), after.split("\n").length);
  expect(changes).toHaveLength(1);
  return describeChange(changes[0]);
};

describe("edit card (analysis/getChange)", () => {
  it("lists every declaration in file order, the edited ones marked, and goes to the first edited one", () => {
    const d = one(
      ".a {\n  color: red;\n  margin: 0;\n  padding: 1px;\n  border: 0;\n}",
      ".a {\n  color: red;\n  margin: 90px;\n  border: 0;\n  gap: 2px !important;\n}",
    );
    expect(d.rule?.decls).toEqual([
      { text: "color: red", state: "same", line: 2, column: 3 },
      { text: "margin: 90px", state: "changed", was: "0", line: 3, column: 3 },
      { text: "padding: 1px", state: "removed" },
      { text: "border: 0", state: "same", line: 4, column: 3 },
      { text: "gap: 2px !important", state: "changed", line: 5, column: 3 },
    ]);
    expect(d).toMatchObject({ line: 3, column: 3, rule: { selector: ".a", conditions: [], removed: false, line: 1, endLine: 6 } });
  });

  it("a new selector or new conditions: the whole rule is the edit", () => {
    const sel = one("@media (min-width: 600px) {\n.a { color: red; }\n}", "@media (min-width: 600px) {\n.b { color: red; }\n}");
    expect(sel.rule).toMatchObject({ selector: ".b", oldSelector: ".a", conditions: ["@media (min-width: 600px)"] });
    expect(sel.rule?.decls).toEqual([{ text: "color: red", state: "changed", line: 2, column: 6 }]);
    expect(sel.line).toBe(2);
    const cond = one("@media (min-width: 600px) {\n.a { color: red; }\n}", "@media (min-width: 900px) {\n.a { color: red; }\n}");
    expect(cond.rule).toMatchObject({ conditions: ["@media (min-width: 900px)"], oldConditions: ["@media (min-width: 600px)"] });
  });

  it("a removed rule shows as it was, where it was", () => {
    const d = one(".a { color: red; }\n.b { margin: 0; gap: 1px; }\n.c { color: blue; }", ".a { color: red; }\n.c { color: blue; }");
    expect(d.rule).toMatchObject({ selector: ".b", removed: true, line: 2 });
    expect(d.rule?.decls).toEqual([{ text: "margin: 0", state: "removed" }, { text: "gap: 1px", state: "removed" }]);
  });

  it("finds declarations after other top-level statements", () => {
    const d = one(".z { top: 0; }\n@media print {\n  .a {\n    color: red;\n  }\n}", ".z { top: 0; }\n@media print {\n  .a {\n    color: blue;\n  }\n}");
    expect(d).toMatchObject({ line: 4, column: 5, rule: { conditions: ["@media print"], line: 3 } });
  });

  it("finds declarations in minified CSS", () => {
    const d = one(".a{color:red}.b{margin:0;gap:1px}", ".a{color:red}.b{margin:0;gap:2px}");
    expect(d).toMatchObject({ line: 1, column: 26 });
  });

  it("jumps to the selector of a whole-rule edit in minified CSS", () => {
    expect(one(".a{color:red}.b{margin:0}", ".a{color:red}.c{margin:0}")).toMatchObject({ line: 1, column: 14 });
    expect(one(".a{color:red}", ".a{color:red}.c{margin:0}")).toMatchObject({ line: 1, column: 14 });
    expect(one(".a{color:red}.b{margin:0;gap:1px}", ".a{color:red}.b{margin:0}")).toMatchObject({ line: 1, column: 14 });
    expect(one("x{}\n  @media (width > 1px) { .b { gap: 1px } }", "x{}\n  @media (width > 1px) { .c { gap: 1px } }")).toMatchObject({ line: 2, column: 26 });
  });

  it("edits outside style rules get a summary", () => {
    const d = one("@keyframes spin { to { rotate: 1turn; } }", "@keyframes spin { to { rotate: 2turn; } }");
    expect(d.rule).toBeUndefined();
    expect(d.summary).toBe("@keyframes spin changed");
  });
});

describe("editor line highlights (analysis/liveEdits)", () => {
  const changes = (before: string, after: string) => diffModels(parseStylesheet(before), parseStylesheet(after), after.split("\n").length);

  it("marks the changed declarations' lines, merging neighbours, or the whole rule for a new one", () => {
    const [d] = changes(".a {\n  color: red;\n  margin: 0;\n  padding: 1px;\n}", ".a {\n  color: blue;\n  margin: 1px;\n  padding: 1px;\n  gap: 0;\n}");
    expect(changeLines(d)).toEqual([[2, 3], [5, 5]]);
    const [added] = changes(".a { color: red; }", ".a { color: red; }\n.b {\n  color: red;\n}");
    expect(changeLines(added)).toEqual([[2, 4]]);
  });

  it("on a branch, marks only lines the branch changed that the live site also lacks", () => {
    const start = ".btn {\n  color: red;\n  padding: 4px;\n}";
    const live = parseStylesheet(".btn {\n  color: blue;\n  padding: 4px;\n}").rules[0];
    const [mine] = changes(start, ".btn {\n  color: red;\n  padding: 8px;\n}");
    expect(commonLines(mine, { ...mine, before: live })).toEqual([[3, 3]]);
    // Nothing in common (the live site's rule can't tell): the branch's own lines.
    const same = parseStylesheet(".btn {\n  color: red;\n  padding: 8px;\n}").rules[0];
    expect(commonLines(mine, { ...mine, before: same })).toEqual([[3, 3]]);
  });
});
