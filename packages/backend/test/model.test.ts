import { describe, expect, it } from "vitest";
import {
  hasInvalidRules,
  parseStylesheet,
  splitTopLevel,
  usageKeysFor,
  withoutInvalidRules,
} from "../src/css/model.js";

describe("usageKeysFor (§6.2)", () => {
  function sortedKeys(prop: string, value: string): string[] {
    return usageKeysFor(prop, value).sort();
  }

  describe("custom properties (declarations create vdep: and ind: keys)", () => {
    it("extracts vdep dependency for var() reference", () => {
      expect(sortedKeys("--accent", "var(--brand)")).toEqual(["vdep:--brand>--accent"]);
    });

    it("extracts multiple vdep dependencies including fallbacks", () => {
      expect(sortedKeys("--final-color", "var(--primary, var(--fallback-color, red))")).toEqual([
        "vdep:--fallback-color>--final-color",
        "vdep:--primary>--final-color",
      ]);
    });

    it("extracts ind: indirect keys from identifiers and strings", () => {
      const keys = sortedKeys("--font-stack", '"Helvetica Neue", Arial, sans-serif');
      expect(keys).toContain("ind:helvetica neue");
      expect(keys).toContain("ind:arial");
      expect(keys).toContain("ind:sans-serif");
    });

    it("combines vdep and ind keys in custom properties", () => {
      const keys = sortedKeys("--my-font", 'var(--base-font), "Fallback Sans", monospace');
      expect(keys).toContain("vdep:--base-font>--my-font");
      expect(keys).toContain("ind:fallback sans");
      expect(keys).toContain("ind:monospace");
    });
  });

  describe("standard properties var() usage", () => {
    it("extracts var: keys for single and multiple vars", () => {
      expect(sortedKeys("color", "var(--brand-color)")).toEqual(["var:--brand-color"]);
      expect(sortedKeys("background", "linear-gradient(var(--start), var(--stop))")).toEqual([
        "var:--start",
        "var:--stop",
      ]);
    });

    it("extracts nested var fallbacks", () => {
      expect(sortedKeys("color", "var(--a, var(--b, var(--c, #000)))")).toEqual([
        "var:--a",
        "var:--b",
        "var:--c",
      ]);
    });
  });

  describe("font and font-family", () => {
    it("extracts font names from font-family (quoted and unquoted)", () => {
      expect(sortedKeys("font-family", '"Open Sans", Roboto, sans-serif')).toEqual([
        "font:open sans",
        "font:roboto",
        "font:sans-serif",
      ]);
    });

    it("extracts font names from font shorthand", () => {
      expect(sortedKeys("font", 'italic bold 16px/1.5 "Brand Sans", Arial, sans-serif')).toEqual([
        "font:arial",
        "font:brand sans",
        "font:sans-serif",
      ]);
    });

    it("handles font shorthand with single family and var()", () => {
      expect(sortedKeys("font", "12px sans-serif")).toEqual(["font:sans-serif"]);
      expect(sortedKeys("font", "14px var(--custom-family), serif")).toEqual([
        "font:serif",
        "font:var(--custom-family)",
        "var:--custom-family",
      ]);
    });
  });

  describe("animations", () => {
    it("extracts animation-name identifiers", () => {
      expect(sortedKeys("animation-name", "slide-in, fade-out")).toEqual([
        "anim:fade-out",
        "anim:slide-in",
      ]);
    });

    it("extracts animation shorthand identifiers", () => {
      const keys = sortedKeys("animation", "2s ease-in 0s infinite reverse both slide-in, 1s fade-out");
      expect(keys).toContain("anim:slide-in");
      expect(keys).toContain("anim:fade-out");
      expect(keys).toContain("anim:infinite");
    });
  });

  describe("counters", () => {
    it("extracts counter names from counter-reset / increment / set", () => {
      expect(sortedKeys("counter-reset", "chapter section 1")).toEqual([
        "counter:chapter",
        "counter:section",
      ]);
      expect(sortedKeys("counter-increment", "page 2 toc")).toEqual([
        "counter:page",
        "counter:toc",
      ]);
      expect(sortedKeys("counter-set", "subchapter 0")).toEqual(["counter:subchapter"]);
    });

    it("extracts counter names from list-style and list-style-type", () => {
      expect(sortedKeys("list-style-type", "custom-counter")).toEqual(["counter:custom-counter"]);
      expect(sortedKeys("list-style", "square inside custom-bullet")).toEqual([
        "counter:custom-bullet",
        "counter:inside",
        "counter:square",
      ]);
    });

    it("extracts counter names only from counter() and counters() inside content", () => {
      expect(sortedKeys("content", '"Chapter: " counter(chapter) " (" counters(section, ".") ") "')).toEqual([
        "counter:chapter",
        "counter:section",
      ]);
      // Content without counter/counters must not produce counter keys
      expect(sortedKeys("content", '"some regular text"')).toEqual([]);
      expect(sortedKeys("content", "open-quote")).toEqual([]);
    });
  });

  describe("position-try and font-palette", () => {
    it("extracts non-dashed position-try identifiers", () => {
      expect(sortedKeys("position-try-fallbacks", "flip-block, flip-inline")).toEqual([
        "ptry:flip-block",
        "ptry:flip-inline",
      ]);
    });

    it("extracts dashed-ident position-try identifiers", () => {
      expect(sortedKeys("position-try-fallbacks", "--flip-top, --flip-bottom")).toEqual([
        "ptry:--flip-bottom",
        "ptry:--flip-top",
      ]);
      expect(sortedKeys("position-try", "--custom-try")).toEqual(["ptry:--custom-try"]);
    });

    it("extracts standard font-palette keyword identifiers", () => {
      expect(sortedKeys("font-palette", "dark")).toEqual(["palette:dark"]);
      expect(sortedKeys("font-palette", "light")).toEqual(["palette:light"]);
    });

    it("extracts dashed-ident font-palette identifiers", () => {
      expect(sortedKeys("font-palette", "--dark-palette")).toEqual(["palette:--dark-palette"]);
    });
  });
});

describe("parseStylesheet edge cases", () => {
  it("handles empty and whitespace-only stylesheets", () => {
    const empty = parseStylesheet("");
    expect(empty.rules).toEqual([]);
    expect(empty.defs).toEqual([]);
    expect(empty.imports).toEqual([]);
    expect(empty.namespaces).toEqual([]);
    expect(empty.parseError).toBeUndefined();

    const ws = parseStylesheet("   \n\t  /* comment */  \n ");
    expect(ws.rules).toEqual([]);
    expect(ws.parseError).toBeUndefined();
  });

  it("handles @layer rules (declarations, blocks, nested, and anonymous)", () => {
    const css = `
      @layer reset, framework.base, components;
      @layer framework {
        @layer base {
          .fw-base { color: blue; }
        }
      }
      @layer {
        .anon { display: block; }
      }
      @layer components {
        .btn { padding: 4px; }
      }
    `;
    const m = parseStylesheet(css);
    expect(m.layerOrder).toEqual(["reset", "framework.base", "components", "framework", "<anonymous-1>"]);
    expect(m.rules).toHaveLength(3);
    expect(m.rules[0].layer).toBe("framework.base");
    expect(m.rules[1].layer).toBe("<anonymous-1>");
    expect(m.rules[2].layer).toBe("components");
  });

  it("handles conditional @supports, @container, and @starting-style", () => {
    const css = `
      @supports (display: flex) {
        .flex { display: flex; }
      }
      @container (min-width: 500px) {
        .card { width: 50%; }
      }
      @starting-style {
        .dialog { opacity: 0; }
      }
    `;
    const m = parseStylesheet(css);
    expect(m.rules).toHaveLength(3);
    expect(m.rules[0].conditions[0].kind).toBe("supports");
    expect(m.rules[1].conditions[0].kind).toBe("container");
    expect(m.rules[2].conditions[0].kind).toBe("starting-style");
  });

  it("extracts all kinds of definitions (§6.2)", () => {
    const css = `
      @font-face { font-family: "CustomFont"; src: url("cf.woff2"); }
      @keyframes slide { from { left: 0; } to { left: 100px; } }
      @-webkit-keyframes spin { 100% { transform: rotate(360deg); } }
      @property --my-color { syntax: '<color>'; inherits: false; initial-value: red; }
      @counter-style custom-numeric { system: numeric; symbols: "0" "1"; }
      @position-try --box-top { top: anchor(bottom); }
      @font-palette-values --BrandPalette { font-family: "CustomFont"; }
      @font-feature-values "Brand Font" { @styleset { feature-on: 1; } }
    `;
    const m = parseStylesheet(css);
    const kinds = m.defs.map((d) => d.kind).sort();
    expect(kinds).toEqual([
      "counter-style",
      "font-face",
      "font-feature-values",
      "font-palette-values",
      "keyframes",
      "keyframes",
      "position-try",
      "property",
    ]);

    const usageKeys = m.defs.map((d) => d.usageKey).sort();
    expect(usageKeys).toEqual([
      "anim:slide",
      "anim:spin",
      "counter:custom-numeric",
      "font:brand font",
      "font:customfont",
      "palette:--brandpalette",
      "ptry:--box-top",
      "var:--my-color",
    ]);
  });

  it("extracts @namespace and @import", () => {
    const css = `
      @import url("base.css");
      @import "theme.css" screen;
      @namespace svg url(http://www.w3.org/2000/svg);
      @namespace "http://www.w3.org/1999/xhtml";
      .box { color: black; }
    `;
    const m = parseStylesheet(css);
    expect(m.imports).toEqual(['url("base.css")', '"theme.css" screen']);
    expect(m.namespaces).toEqual(['svg url(http://www.w3.org/2000/svg)', '"http://www.w3.org/1999/xhtml"']);
    expect(m.rules).toHaveLength(1);
  });

  it("detects invalid rules and filters them with withoutInvalidRules", () => {
    const css = `
      .valid { color: green; }
      .invalid > > .broken { color: red; }
      .another-valid { color: blue; }
    `;
    const m = parseStylesheet(css);
    expect(hasInvalidRules(m)).toBe(true);
    expect(m.rules).toHaveLength(3);
    expect(m.rules[1].invalid).toBeTruthy();

    const clean = withoutInvalidRules(m);
    expect(hasInvalidRules(clean)).toBe(false);
    expect(clean.rules).toHaveLength(2);
    expect(clean.rules.map((r) => r.selectorText)).toEqual([".valid", ".another-valid"]);
  });

  it("splitTopLevel handles strings and comments containing braces and semicolons", () => {
    const css = `
      /* { a: 1; } */
      .a { content: "}; {; "; }
      .b { color: red; }
    `;
    const chunks = splitTopLevel(css);
    expect(chunks).toHaveLength(2);
  });
});
