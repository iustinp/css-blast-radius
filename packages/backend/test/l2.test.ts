import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type CbrConfig } from "../src/config.js";
import { Store } from "../src/index/store.js";
import { SiteIndex } from "../src/index/siteIndex.js";
import { Capturer } from "../src/capture/capture.js";
import { Renderer } from "../src/l2/render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSiteDir = path.resolve(__dirname, "../../../fixtures/site");

const skipBrowser = !!process.env.CBR_NO_BROWSER;

describe.skipIf(skipBrowser)("L2 renderer on fixture site (§6.6, §16)", () => {
  let tempDir: string;
  let ws: string;
  let dataDir: string;
  let cfg: CbrConfig;
  let store: Store;
  let idx: SiteIndex;
  let renderer: Renderer;
  let baseCssText: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-l2-test-"));
    ws = path.join(tempDir, "site");
    dataDir = path.join(tempDir, "data");

    fs.cpSync(fixtureSiteDir, ws, { recursive: true });

    cfg = loadConfig(ws, { dataDir });
    store = new Store(cfg.dataDir);

    const capturer = new Capturer(cfg, store);
    await capturer.run({});

    idx = SiteIndex.load(store)!;
    expect(idx).toBeDefined();

    renderer = new Renderer(cfg, store);
    baseCssText = fs.readFileSync(path.join(ws, "css", "main.css"), "utf8");
  }, 120_000);

  afterAll(async () => {
    if (renderer) await renderer.close();
    if (store) store.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports 'changed' with >= 1 changed element for a padding edit on a used selector", async () => {
    const pageIndex = idx.pages[idx.byUrl.get("/about.html")!];
    const variant = idx.variants[0];

    // On desktop viewport (1280px), @media (min-width: 800px) sets padding: 12px 24px
    const editedCss = baseCssText.replace(
      "padding: 12px 24px;",
      "padding: 40px 80px;",
    );

    const result = await renderer.measure({
      page: pageIndex,
      variant,
      mode: "shell",
      sheetKeys: ["/css/main.css"],
      baseText: baseCssText,
      editedText: editedCss,
      props: ["padding"],
    });

    expect(result.status).toBe("changed");
    expect(result.changedElements).toBeGreaterThanOrEqual(1);
    expect(result.elements.some((e) => e.kind === "changed" || e.kind === "resized" || e.kind === "moved")).toBe(true);
  }, 60_000);

  it("reports 'unchanged' for a no-op edit", async () => {
    const pageIndex = idx.pages[idx.byUrl.get("/about.html")!];
    const variant = idx.variants[0];

    const result = await renderer.measure({
      page: pageIndex,
      variant,
      mode: "shell",
      sheetKeys: ["/css/main.css"],
      baseText: baseCssText,
      editedText: baseCssText,
      props: ["padding", "color"],
    });

    expect(result.status).toBe("unchanged");
    expect(result.changedElements).toBe(0);
    expect(result.movedElements).toBe(0);
  }, 60_000);

  it("reports 'unchanged' for an edit overridden by a later more-specific declaration", async () => {
    // On index.html, the only button is <button class="btn btn-primary">
    // .btn has color: blue, but .btn.btn-primary has color: white
    // Editing .btn's color to green is overridden by .btn.btn-primary's color: white
    const pageIndex = idx.pages[idx.byUrl.get("/index.html")!];
    const variant = idx.variants[0];

    const editedCss = baseCssText.replace(
      ".btn {\n  color: blue;",
      ".btn {\n  color: green;",
    );

    const result = await renderer.measure({
      page: pageIndex,
      variant,
      mode: "shell",
      sheetKeys: ["/css/main.css"],
      baseText: baseCssText,
      editedText: editedCss,
      props: ["color"],
    });

    expect(result.status).toBe("unchanged");
    expect(result.changedElements).toBe(0);
  }, 60_000);

  it("does not report untouched ::before/::after as removed and added when the sheet is swapped", async () => {
    const pageIndex = idx.pages[idx.byUrl.get("/about.html")!];
    const variant = idx.variants[0];
    // A tall page: the full-page screenshot between the two measurements rebuilds them.
    const pseudo =
      "\nbody { min-height: 3000px; }\n@media (min-width: 800px) {\n  .card .title::before { content: '» '; }\n  .card::after { content: '.'; }\n}\n";
    const editedCss = baseCssText.replace("padding: 12px 24px;", "padding: 40px 80px;");

    const result = await renderer.measure({
      page: pageIndex,
      variant,
      mode: "shell",
      sheetKeys: ["/css/main.css"],
      baseText: baseCssText + pseudo,
      editedText: editedCss + pseudo,
      props: ["padding"],
      screenshots: true,
    });

    expect(result.status).toBe("changed");
    expect(result.elements.filter((e) => e.kind === "appeared" || e.kind === "disappeared")).toEqual([]);
    expect(result.zones.map((z) => z.label)).toEqual([expect.stringContaining("button.btn")]);
  }, 60_000);

  it("outlines the edited element, not the parents that only grew", async () => {
    const pageIndex = idx.pages[idx.byUrl.get("/about.html")!];
    const base = baseCssText + "\n.card .title { display: block; }\n";
    const edited = baseCssText + "\n.card .title { display: block; margin: 40px; }\n";

    const result = await renderer.measure({
      page: pageIndex,
      variant: idx.variants[0],
      mode: "shell",
      sheetKeys: ["/css/main.css"],
      baseText: base,
      editedText: edited,
      // Several picked edits compare sizes too: the card, body and html grow.
      props: ["margin", "width", "height"],
      screenshots: true,
    });

    expect(result.status).toBe("changed");
    expect(result.elements.map((e) => e.path)).toEqual(expect.arrayContaining(["body > div.card"]));
    expect(result.zones.map((z) => z.label)).toEqual(["body > div.card > span.title"]);

    // Alignment points: the title's text sits 40px lower and further right after the edit.
    const a = result.anchors!;
    expect(a.length % 8).toBe(0);
    expect(result.anchorLeaves).toBeGreaterThan(0);
    const shifted = [];
    for (let i = 0; i < result.anchorLeaves! * 8; i += 8) if (a[i + 5] - a[i + 1] === 40 && a[i + 4] - a[i] === 40) shifted.push(i);
    expect(shifted.length).toBeGreaterThan(0);
  }, 60_000);

  it("outlines an edited element whose size changed, not what it holds", async () => {
    const pageIndex = idx.pages[idx.byUrl.get("/about.html")!];
    const base = baseCssText + "\n.card { width: 300px; }\n.card .title { display: block; }\n";
    const edited = baseCssText + "\n.card { width: 200px; }\n.card .title { display: block; }\n";
    const req = {
      page: pageIndex,
      variant: idx.variants[0],
      mode: "shell" as const,
      sheetKeys: ["/css/main.css"],
      baseText: base,
      editedText: edited,
      props: ["width", "height"],
    };

    const plain = await renderer.measure(req);
    expect(plain.zones.map((z) => z.label)).toEqual(["body > div.card > span.title"]);

    const result = await renderer.measure({ ...req, targets: [{ selector: ".card", props: ["width"] }] });
    expect(result.zones.map((z) => z.label)).toEqual(["body > div.card"]);
  }, 60_000);

  it("reports 'inconclusive' when the page does not load the edited stylesheet", async () => {
    const pageIndex = idx.pages[idx.byUrl.get("/index.html")!];
    const variant = idx.variants[0];

    const result = await renderer.measure({
      page: pageIndex,
      variant,
      mode: "shell",
      sheetKeys: ["/css/unloaded-nonexistent.css"],
      baseText: baseCssText,
      editedText: baseCssText + "\n.new { color: red; }",
      props: ["color"],
    });

    expect(result.status).toBe("inconclusive");
    expect(result.reason).toContain("not loaded");
  }, 60_000);

  describe("script edits (§17, J3a): each side loaded fresh", () => {
    const onReady = (body: string) => `\ndocument.addEventListener("DOMContentLoaded", () => { ${body} });\n`;
    const app = () => fs.readFileSync(path.join(ws, "js", "app.js"), "utf8");
    const run = (url: string, baseText: string, editedText: string, extra: { screenshots?: boolean; paths?: string[] } = {}) =>
      renderer.measure({
        page: idx.pages[idx.byUrl.get(url)!],
        variant: idx.variants[0],
        mode: "live",
        props: [],
        scripts: [{ paths: extra.paths ?? ["/js/app.js"], baseText, editedText }],
        screenshots: extra.screenshots,
      });

    it("shows the text and attributes an edited script changes, and nothing where its code doesn't run", async () => {
      const base = app();
      const edited = base + onReady('if (location.pathname.endsWith("/about.html")) { const t = document.querySelector(".title"); t.textContent = "Edited"; t.dataset.state = "on"; }');
      const about = await run("/about.html", base, edited, { screenshots: true });
      expect(about.status).toBe("changed");
      expect(about.mode).toBe("live");
      expect(about.zones.map((z) => z.label)).toEqual(["body > div.card > span.title"]);
      expect(about.zones[0].props).toEqual(
        expect.arrayContaining([
          { prop: "text", before: "Another card", after: "Edited" },
          { prop: "[data-state]", before: "(none)", after: "on" },
        ]),
      );
      expect(about.screenshots?.before).toBeTruthy();
      expect(about.anchors?.length).toBeGreaterThan(0);
      expect(about.errors).toBeUndefined();

      const index = await run("/index.html", base, edited);
      expect(index.status).toBe("unchanged");
      expect(index.changedElements + index.movedElements).toBe(0);
    }, 60_000);

    it("lists the errors an edit adds, and leaves out what changes by itself between loads", async () => {
      const base = app() + onReady('document.querySelector(".btn").textContent = String(performance.now());');
      const edited = base + onReady('document.querySelector(".title").textContent = "Edited"; null.boom;');
      const r = await run("/about.html", base, edited);
      expect(r.status).toBe("changed");
      expect(r.errors?.added).toEqual([expect.stringContaining("Cannot read properties of null")]);
      expect(r.errors?.fixed).toEqual([]);
      expect(r.zones.map((z) => z.label)).toEqual(["body > div.card > span.title"]);
      expect(r.warnings.some((w) => /by itself between loads/.test(w))).toBe(true);

      const fixedBack = await run("/about.html", edited, base);
      expect(fixedBack.errors?.fixed).toEqual([expect.stringContaining("Cannot read properties of null")]);
    }, 90_000);

    it("starts every load at the same time with the same random numbers", async () => {
      const base = app() + onReady('document.querySelector(".title").textContent = [Math.random(), crypto.randomUUID(), new Date().getFullYear()].join(" ");');
      const r = await run("/about.html", base, base + "\n// no-op\n");
      expect(r.status).toBe("unchanged");
      expect(r.warnings).toEqual([]);
    }, 60_000);

    it("reports 'inconclusive' when the page doesn't load the edited script", async () => {
      const r = await run("/about.html", "x = 1;", "x = 2;", { paths: ["/js/not-loaded.js"] });
      expect(r.status).toBe("inconclusive");
      expect(r.reason).toMatch(/didn't load the edited files/);
    }, 60_000);
  });
});
