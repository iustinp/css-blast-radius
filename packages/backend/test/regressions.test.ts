import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserModel, parseStylesheet, withoutInvalidRules, type StylesheetModel } from "../src/css/model.js";
import { diffModels } from "../src/css/diff.js";
import { Doc } from "../src/daemon/documents.js";
import { loadConfig } from "../src/config.js";
import { Store, type VariantInfo } from "../src/index/store.js";
import { IndexBuilder, SiteIndex } from "../src/index/siteIndex.js";
import { L0Engine, L1Cache } from "../src/engine/l0.js";

// Regressions from the independent review of the core build.

describe("browser view of a stylesheet", () => {
  it("dropping invalid rules keeps the usage and var indexes pointing at the right rules", () => {
    const m = withoutInvalidRules(
      parseStylesheet(`.bad > > .x { color: var(--a); }\n.ok { --b: 1px; padding: var(--c); }`),
    );
    expect(m.rules.map((r) => r.selectorText)).toEqual([".ok"]);
    expect(m.usage.get("var:--a")).toBeUndefined();
    expect(m.usage.get("var:--c")).toEqual([0]);
    expect(m.rules[m.usage.get("var:--c")![0]].selectorText).toBe(".ok");
  });

  it("a stray } drops only that statement, as browsers do", () => {
    const m = browserModel(`.a { color: red; } }\n.b { color: blue; }`);
    expect(m.parseError).toBeDefined();
    expect(m.rules.map((r) => r.selectorText)).toEqual([".a", ".b"]);
  });

  it("vars used inside @keyframes and @container style() are recorded", () => {
    const m = parseStylesheet(
      `@keyframes pulse { to { color: var(--pulse); } }\n@container style(--theme: dark) { .c { color: red; } }`,
    );
    const kf = m.defs.find((d) => d.usageKey === "anim:pulse");
    expect(kf?.uses).toContain("var:--pulse");
    expect(m.rules.find((r) => r.selectorText === ".c")?.uses).toContain("var:--theme");
  });
});

describe("Doc.current() while the text has a parse error", () => {
  const saved = `.a { color: red; }\n.b { color: blue; }\n.c { color: green; }`;

  it("an edit elsewhere in the file is still seen", () => {
    const doc = new Doc("/s.css", saved, 1, saved);
    doc.current();
    doc.change(2, [{ text: `.a { color: red; } }\n.b { color: blue; }\n.c { color: purple; }` }]);
    const cur = doc.current();
    expect(cur.editing).toBe(true);
    const c = cur.model.rules.find((r) => r.selectorText === ".c");
    expect(c?.decls.find((d) => d.prop === "color")?.value).toBe("purple");
  });

  it("an unclosed block keeps the last valid version of what it swallowed", () => {
    const doc = new Doc("/s.css", saved, 1, saved);
    doc.current();
    doc.change(2, [{ text: `.a { color: red; }\n.b { color: blue;\n.c { color: green; }` }]);
    const cur = doc.current();
    expect(cur.model.rules.map((r) => r.selectorText).sort()).toEqual([".a", ".b", ".c"]);
  });
});

describe("L0 engine on a hand-built index", () => {
  let dir: string;
  let store: Store;
  let engine: L0Engine;
  let file: string;
  const variants: VariantInfo[] = [{ id: 0, name: "desktop", profile: "desktop" }];
  const urls = ["/p0.html", "/p1.html", "/p2.html"];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-regress-"));
    fs.mkdirSync(path.join(dir, "css"));
    file = path.join(dir, "css", "site.css");
    fs.writeFileSync(file, "");
    const cfg = loadConfig(dir, { dataDir: path.join(dir, "data") });
    store = new Store(cfg.dataDir);
    const rev = store.createRevision("test", variants);
    const b = new IndexBuilder(variants, urls);
    for (const u of urls) {
      const id = b.id(u);
      b.setPage({ id, url: u, status: "ok", quirks: false, trees: {}, shells: {}, assets: {}, capturedAt: new Date().toISOString() });
      // The pages link the file with different letter case than it has on disk.
      b.addSheet("/CSS/Site.css", "h", id);
      b.addSelectorResult(":root", 0, id, 1);
      b.addSelectorResult(".a", 0, id, id === 0 ? 1 : 0);
    }
    b.addUsage("anim:pulse", b.id("/p1.html"));
    b.publish(store, rev, {});
    const index = SiteIndex.load(store, rev)!;
    engine = new L0Engine(index, cfg, new L1Cache(rev, index.size));
  });

  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyze = (before: string, after: string) => {
    const base: StylesheetModel = browserModel(before);
    const cur = browserModel(after);
    return engine.analyze(file, base, cur, diffModels(base, cur, after.split("\n").length));
  };

  it("maps the edited file to the captured stylesheet regardless of letter case", () => {
    const c = engine.candidates(file);
    expect(c.urls).toEqual(["/CSS/Site.css"]);
    expect(c.pages.count()).toBe(3);
  });

  it("a selector that is only an upper bound doesn't reuse an exact result for the same relaxed key", () => {
    const a = analyze("", `.a:hover { color: red; }\n.a:-x-unknown { color: blue; }`);
    const byLine = new Map(a.changes.map((ch, i) => [ch.line, a.sets[i]]));
    expect(byLine.get(1)!.exact.count()).toBe(1);
    expect(byLine.get(2)!.exact.count()).toBe(0);
    expect(byLine.get(2)!.possible.count()).toBe(1);
  });

  it("a custom property used only inside @keyframes reaches the pages using the animation", () => {
    const kf = `@keyframes pulse { to { color: var(--pulse); } }\n`;
    const a = analyze(`${kf}:root { --pulse: red; }`, `${kf}:root { --pulse: blue; }`);
    expect(a.totalCount.exact).toBe(1);
  });
});
