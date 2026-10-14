import { describe, expect, it } from "vitest";
import { diffModels } from "../src/css/diff.js";
import { browserModel } from "../src/css/model.js";
import { partialText } from "../src/css/partial.js";

/** Applies the changes whose label (selector or definition name) is in `pick`; returns the text and what it changes. */
function apply(from: string, to: string, pick: string[]) {
  const fm = browserModel(from);
  const tm = browserModel(to);
  const changes = diffModels(fm, tm, to.split("\n").length);
  const label = (i: number) => {
    const c = changes[i];
    return c.def?.name ?? (c.after ?? c.before)?.selectorText ?? c.kind;
  };
  const res = partialText(from, to, changes, (i) => pick.includes(label(i)), fm, tm);
  const got = diffModels(fm, browserModel(res.text), res.text.split("\n").length);
  return {
    text: res.text,
    alsoApplied: res.alsoApplied.map(label),
    fallback: !!res.fallback,
    applied: got.map((c) => `${c.kind} ${c.def?.name ?? (c.after ?? c.before)?.selectorText ?? ""}`.trim()).sort(),
  };
}

describe("partialText", () => {
  const from = `.a {
  color: red;
}

.b {
  color: red;
}

.c {
  color: red;
}
`;

  it("applies only the chosen declaration edits", () => {
    const to = from.replace(/red/g, "blue");
    const r = apply(from, to, [".b"]);
    expect(r.applied).toEqual(["declarations .b"]);
    expect(r.alsoApplied).toEqual([]);
    expect(apply(from, to, [".a", ".c"]).applied).toEqual(["declarations .a", "declarations .c"]);
  });

  it("returns the base or the current text when nothing or everything is chosen", () => {
    const to = from.replace(/red/g, "blue");
    expect(apply(from, to, []).text).toBe(from);
    expect(apply(from, to, [".a", ".b", ".c"]).text).toBe(to);
  });

  it("handles added and removed rules, including a whole new @media block", () => {
    const to = from.replace(".b {\n  color: red;\n}\n\n", "") + "\n@media (min-width: 800px) {\n  .d {\n    margin: 0;\n  }\n}\n";
    expect(apply(from, to, [".d"]).applied).toEqual(["added .d"]);
    expect(apply(from, to, [".b"]).applied).toEqual(["removed .b"]);
    const d = apply(from, to, [".d"]).text;
    expect(d).toContain("@media (min-width: 800px) {\n  .d {");
    expect(d).toContain(".b {");
  });

  it("splits one-line rules edited in one hunk", () => {
    const f = ".a { color: red }\n.b { color: red }\n.c { color: red }\n";
    const t = ".a { color: blue }\n.b { color: blue }\n.c { color: red }\n";
    const r = apply(f, t, [".b"]);
    expect(r.applied).toEqual(["declarations .b"]);
    expect(r.text).toBe(".a { color: red }\n.b { color: blue }\n.c { color: red }\n");
  });

  it("keeps a nested rule's edit apart from its parent's", () => {
    const f = ".card {\n  color: red;\n  .title {\n    margin: 0;\n  }\n}\n";
    const t = ".card {\n  color: blue;\n  .title {\n    margin: 4px;\n  }\n}\n";
    expect(apply(f, t, [".card .title"]).applied).toEqual(["declarations .card .title"]);
    expect(apply(f, t, [".card"]).applied).toEqual(["declarations .card"]);
  });

  it("applies edits that share a line together, and says so", () => {
    const f = ".a { color: red } .b { color: red }\n";
    const t = ".a { color: blue } .b { color: blue }\n";
    const r = apply(f, t, [".a"]);
    expect(r.applied).toEqual(["declarations .a", "declarations .b"]);
    expect(r.alsoApplied).toEqual([".b"]);
    expect(r.fallback).toBe(false);
  });

  it("applies a condition edit with its block", () => {
    const f = "@media (min-width: 600px) {\n  .a { color: red }\n}\n.b { color: red }\n";
    const t = "@media (min-width: 900px) {\n  .a { color: red }\n}\n.b { color: blue }\n";
    expect(apply(f, t, [".a"]).applied).toEqual(["condition .a"]);
    expect(apply(f, t, [".b"]).applied).toEqual(["declarations .b"]);
  });

  it("applies a definition edit on its own", () => {
    const f = "@keyframes spin {\n  to { transform: rotate(1turn) }\n}\n.a { color: red }\n";
    const t = "@keyframes spin {\n  to { transform: rotate(2turn) }\n}\n.a { color: blue }\n";
    expect(apply(f, t, ["spin"]).applied).toEqual(["definition spin"]);
    expect(apply(f, t, [".a"]).applied).toEqual(["declarations .a"]);
  });

  it("keeps comment-only hunks with the edits when the file has no file-level change", () => {
    const f = "/* old */\n.a { color: red }\n\n.b { color: red }\n";
    const t = "/* new */\n.a { color: red }\n\n.b { color: blue }\n";
    const r = apply(f, t, [".b"]);
    expect(r.applied).toEqual(["declarations .b"]);
    expect(r.text.startsWith("/* new */")).toBe(true);
  });

  it("applies each edit of a mixed set on its own", () => {
    const f = `:root {
  --gap: 8px;
}

.header {
  display: flex;
}

.header .logo {
  width: 120px;
}

.panel > ul > li {
  margin: 0;
}

@media (min-width: 900px) {
  .panel {
    padding: 16px;
  }

  .card {
    border: 1px solid #ccc;
    .title {
      font-weight: 600;
    }
  }
}

.footer {
  color: #333;
}

.old {
  display: none;
}
`;
    const t = f
      .replace("--gap: 8px", "--gap: 12px")
      .replace(".header .logo", ".header .brand")
      .replace("margin: 0;", "margin: 90px;")
      .replace("padding: 16px;", "padding: 24px;")
      .replace("font-weight: 600;", "font-weight: 700;")
      .replace(".old {\n  display: none;\n}\n", ".new {\n  display: block;\n}\n")
      .replace("@media (min-width: 900px)", "@media (min-width: 1000px)");
    const fm = browserModel(f);
    const all = diffModels(fm, browserModel(t), t.split("\n").length);
    expect(all.length).toBeGreaterThan(5);
    for (const c of all) {
      const name = (c.after ?? c.before)!.selectorText;
      const r = apply(f, t, [name]);
      expect(r.fallback, name).toBe(false);
      expect(r.applied.some((x) => x.endsWith(` ${name}`)), name).toBe(true);
      expect(r.applied.length - r.alsoApplied.length, name).toBe(1);
    }
  });

  it("keeps @import changes apart from rule edits on the next line", () => {
    const base = "@import url(a.css);\n.a{color:red}\n";
    const cur = "@import url(b.css);\n.a{color:blue}\n";
    const rule = apply(base, cur, [".a"]);
    expect(rule.applied).toEqual(["declarations .a"]);
    expect(rule.text).toContain("a.css");
    const imp = apply(base, cur, ["import"]);
    expect(imp.applied).toEqual(["import"]);
    expect(imp.fallback).toBe(false);
    expect(imp.text).toContain("color:red");
  });

  it("brings the layer order along with a new @layer block, and says so", () => {
    const base = ".z {\n  color: red;\n}\n";
    const cur = "@layer theme {\n  .x {\n    color: red;\n  }\n}\n.z {\n  color: blue;\n}\n";
    const x = apply(base, cur, [".x"]);
    expect(x.fallback).toBe(false);
    expect(x.applied).toEqual(["added .x", "layer-order"]);
    expect(x.alsoApplied).toEqual(["layer-order"]);
    expect(x.text).toContain("color: red;\n}\n");
    // The order alone can't be separated from the block: everything is shown, with a warning.
    expect(apply(base, cur, ["layer-order"]).fallback).toBe(true);
  });

  it("doesn't apply an unpicked move the line diff sees as another rule moving", () => {
    const a = ".a {\n  color: red;\n  margin: 0;\n  padding: 0;\n}\n";
    const base = `${a}.b { color: red; }\n.c { color: green; }\n`;
    const cur = `.b { color: red; }\n${a}.c { color: black; }\n`;
    const c = apply(base, cur, [".c"]);
    expect(c.fallback).toBe(false);
    expect(c.applied).toEqual(["declarations .c"]);
    expect(c.text.indexOf(".a")).toBeLessThan(c.text.indexOf(".b"));
    const m = apply(base, cur, [".a"]);
    expect(m.fallback).toBe(false);
    expect(m.text.indexOf(".b")).toBeLessThan(m.text.indexOf(".a"));
    expect(m.text).toContain("green");
  });
});

