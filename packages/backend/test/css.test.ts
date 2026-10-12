import { describe, expect, it } from "vitest";
import { analyzeComplex } from "../src/css/selectors.js";
import { parseStylesheet } from "../src/css/model.js";
import { diffModels } from "../src/css/diff.js";
import { PageSet } from "../src/util/pageSet.js";

describe("selector relaxation (§6.3)", () => {
  const cases: Array<[string, string, boolean]> = [
    [".nav a:hover", ".nav a", false],
    [".menu.is-open .item", ".menu.is-open .item", true],
    [".card:not(:hover) .title", ".card .title", false],
    [".card:not(.x) .title", ".card:not(.x) .title", true],
    ["input:checked + label", "input + label", false],
    [".a::before", ".a", true],
    [".a:hover::after", ".a", false],
    [":hover", "*", false],
    [".list :focus-visible", ".list *", false],
    [".x:is(.a:hover, .b)", ".x:is(.a, .b)", false],
    [".x:has(> img)", ".x:has(> img)", true],
    ["li:nth-child(2 of .item)", "li:nth-child(2 of .item)", true],
    ["li:nth-child(2 of :hover)", "li", false],
    ["a:-moz-whatever", "a", false],
    ["  .a   >   .b  ", ".a > .b", true],
    [".a\n.b", ".a .b", true],
  ];
  for (const [input, key, exact] of cases) {
    it(`${input} → ${key}`, () => {
      const r = analyzeComplex(input);
      expect(r.key).toBe(key);
      expect(r.exact).toBe(exact);
      expect(r.invalid).toBeUndefined();
    });
  }

  it("records dropped parts and tokens", () => {
    const r = analyzeComplex("nav.main > a[href]:hover");
    expect(r.dropped).toEqual([":hover"]);
    expect(r.tokens).toEqual(["a:href", "c:main", "t:a", "t:nav"]);
    expect(r.features).toContain("comb:>");
  });

  it("does not take tokens from :not() or multi-argument :is()", () => {
    expect(analyzeComplex(".a:not(.b)").tokens).toEqual(["c:a"]);
    expect(analyzeComplex(":is(.a, .b) .c").tokens).toEqual(["c:c"]);
    expect(analyzeComplex(":is(.a) .c").tokens).toEqual(["c:a", "c:c"]);
  });

  it("flags selectors browsers reject", () => {
    expect(analyzeComplex(".a >").invalid).toBeTruthy();
    expect(analyzeComplex(".a > > .b").invalid).toBeTruthy();
  });

  it("unparseable selectors become * (an upper bound)", () => {
    const r = analyzeComplex(".a[");
    expect(r.invalid || r.unanalyzable).toBeTruthy();
  });
});

describe("stylesheet model", () => {
  it("desugars nesting", () => {
    const m = parseStylesheet(`.card { color: red; .title { color: blue } &:hover { color: green } .a, .b { x: 1 } }`);
    expect(m.rules.map((r) => r.selectorText)).toEqual([".card", ".card .title", ".card:hover", ".card .a, .card .b"]);
    const list = parseStylesheet(`.a, .b { & > .c { color: red } }`);
    expect(list.rules[0].selectorText).toBe(":is(.a, .b) > .c");
  });

  it("desugars @scope", () => {
    const m = parseStylesheet(`@scope (.card) { .title { color: red } :scope { color: blue } }`);
    expect(m.rules.map((r) => r.selectorText)).toEqual([":is(.card) .title", ":is(.card)"]);
    expect(m.rules[0].conditions[0].kind).toBe("scope");
  });

  it("handles bare declarations in nested @media", () => {
    const m = parseStylesheet(`.a { color: red; @media (min-width: 600px) { color: blue } }`);
    expect(m.rules).toHaveLength(2);
    expect(m.rules[1].selectorText).toBe(".a");
    expect(m.rules[1].condKey).toBe("@media (min-width: 600px)");
  });

  it("collects definitions, layers and usage", () => {
    const m = parseStylesheet(`
      @layer base, components;
      @font-face { font-family: "Brand Sans"; src: local(Arial); }
      @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }
      :root { --brand: red; --accent: var(--brand); }
      @layer components { .btn { font-family: "Brand Sans", sans-serif; animation: pulse 1s; color: var(--accent) } }
    `);
    expect(m.layerOrder).toEqual(["base", "components"]);
    expect(m.defs.map((d) => d.usageKey).sort()).toEqual(["anim:pulse", "font:brand sans"]);
    expect(m.rules).toHaveLength(2);
    const btn = m.rules[1];
    expect(btn.layer).toBe("components");
    expect(btn.uses).toEqual(expect.arrayContaining(["font:brand sans", "anim:pulse", "var:--accent"]));
    expect([...m.varEdges.get("--accent")!]).toEqual(["--brand"]);
  });

  it("skips keyframe selectors and empty rules", () => {
    const m = parseStylesheet(`@keyframes k { 0% { top: 0 } } .empty {} .x { a: b }`);
    expect(m.rules.map((r) => r.selectorText)).toEqual([".x"]);
  });

  it("reports parse errors without throwing", () => {
    const m = parseStylesheet(`.a { color: red`);
    // postcss tolerates an unclosed block; a stray brace is an error.
    const bad = parseStylesheet(`.a { color: red } }`);
    expect(m.parseError === undefined || typeof m.parseError.message === "string").toBe(true);
    expect(bad.parseError).toBeTruthy();
  });
});

describe("diff classification", () => {
  const d = (a: string, b: string) => diffModels(parseStylesheet(a), parseStylesheet(b), 999);

  it("declaration change", () => {
    const c = d(`.a { color: red } .b { x: 1 }`, `.a { color: blue } .b { x: 1 }`);
    expect(c).toHaveLength(1);
    expect(c[0].kind).toBe("declarations");
    expect(c[0].changedProps).toEqual(["color"]);
  });

  it("selector change", () => {
    const c = d(`.a { color: red } .b { x: 1 }`, `.a2 { color: red } .b { x: 1 }`);
    expect(c.map((x) => x.kind)).toEqual(["selector"]);
    expect(c[0].before!.selectorText).toBe(".a");
    expect(c[0].after!.selectorText).toBe(".a2");
  });

  it("condition change", () => {
    const c = d(`@media (min-width: 1px) { .a { x: 1 } }`, `@media (min-width: 2px) { .a { x: 1 } }`);
    expect(c.map((x) => x.kind)).toEqual(["condition"]);
  });

  it("added and removed", () => {
    expect(d(`.a { x: 1 }`, `.a { x: 1 } .b { y: 2 }`).map((x) => x.kind)).toEqual(["added"]);
    expect(d(`.a { x: 1 } .b { y: 2 }`, `.a { x: 1 }`).map((x) => x.kind)).toEqual(["removed"]);
  });

  it("move", () => {
    const c = d(`.a { x: 1 } .b { y: 2 } .c { z: 3 }`, `.b { y: 2 } .c { z: 3 } .a { x: 1 }`);
    expect(c.map((x) => x.kind)).toEqual(["moved"]);
  });

  it("definitions, layer order, imports", () => {
    expect(d(`@keyframes k { to { top: 0 } }`, `@keyframes k { to { top: 1px } }`)[0].def).toMatchObject({
      usageKey: "anim:k",
      change: "changed",
    });
    expect(d(`@layer a, b;`, `@layer b, a;`)[0].kind).toBe("layer-order");
    expect(d(`@import "x.css";`, `@import "y.css";`)[0].kind).toBe("import");
  });

  it("no change", () => {
    expect(d(`.a { x: 1 }`, `.a {  x:   1  }`)).toEqual([]);
  });
});

describe("PageSet", () => {
  it("set algebra and count", () => {
    const a = PageSet.fromIds(100, [1, 5, 33, 99]);
    const b = PageSet.fromIds(100, [5, 33, 64]);
    expect(a.and(b).toArray()).toEqual([5, 33]);
    expect(a.or(b).count()).toBe(5);
    expect(a.andNot(b).toArray()).toEqual([1, 99]);
    expect(PageSet.full(70).count()).toBe(70);
    const round = PageSet.fromBuffer(100, a.toBuffer());
    expect(round.equals(a)).toBe(true);
  });
});
