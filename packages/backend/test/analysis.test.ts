import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawlSite } from "../src/crawl/crawler.js";
import { analyzeChange } from "../src/daemon/analysis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "../../../fixtures/site");
const CSS_PATH = path.join(SITE_ROOT, "css/main.css");

describe("crawlSite", () => {
  it("captures all pages and links stylesheets", async () => {
    const corpus = await crawlSite(SITE_ROOT);
    expect(corpus.pages.size).toBe(3);
    expect(corpus.cssFiles.has(CSS_PATH)).toBe(true);
  });

  it("computes distinct skeleton hashes for structurally different pages", async () => {
    const corpus = await crawlSite(SITE_ROOT);
    const hashes = new Set([...corpus.pages.values()].map((p) => p.skeletonHash));
    expect(hashes.size).toBeGreaterThan(1);
  });
});

describe("analyzeChange", () => {
  it("reports exact match counts for a modified rule", async () => {
    const corpus = await crawlSite(SITE_ROOT);
    const oldText = corpus.cssFiles.get(CSS_PATH)!.text;
    const newText = oldText.replace(".btn {\n  color: blue;", ".btn {\n  color: green;");

    const answer = analyzeChange({ corpus, cssFilePath: CSS_PATH, oldText, newText, epoch: 1 });
    const btnChange = answer.selectors.find((s) => s.selector === ".btn" && s.kind === "modified");

    expect(btnChange).toBeDefined();
    // .btn matches on index.html (via .btn.btn-primary) and about.html => 2 elements total
    expect(btnChange!.matches).toBe(2);
    expect(btnChange!.matchedPages.length).toBe(2);
    expect(btnChange!.confidence).not.toBe("STALE");
  });

  it("flags added selectors with zero matches and a reason code", async () => {
    const corpus = await crawlSite(SITE_ROOT);
    const oldText = corpus.cssFiles.get(CSS_PATH)!.text;
    const newText = oldText + "\n.never-used-anywhere { color: red; }\n";

    const answer = analyzeChange({ corpus, cssFilePath: CSS_PATH, oldText, newText, epoch: 2 });
    const added = answer.selectors.find((s) => s.selector === ".never-used-anywhere");

    expect(added).toBeDefined();
    expect(added!.matches).toBe(0);
    expect(added!.reasonCodes).toContain("selector-never-matched");
  });

  it("reports losses with fallback detection for removed rules", async () => {
    const corpus = await crawlSite(SITE_ROOT);
    const oldText = corpus.cssFiles.get(CSS_PATH)!.text;
    const newText = oldText.replace(/#hero \{[^}]*\}\n\n/, "");

    const answer = analyzeChange({ corpus, cssFilePath: CSS_PATH, oldText, newText, epoch: 3 });
    const removed = answer.selectors.find((s) => s.selector === "#hero" && s.kind === "removed");

    expect(removed).toBeDefined();
    expect(removed!.losses.length).toBeGreaterThan(0);
    expect(removed!.losses[0].hasFallbackRule).toBe(false);
  });

  it("reports zero matches with stylesheet-not-linked-on-page for an unlinked file", async () => {
    const corpus = await crawlSite(SITE_ROOT);
    const answer = analyzeChange({
      corpus,
      cssFilePath: path.join(SITE_ROOT, "css/unlinked.css"),
      oldText: "",
      newText: ".foo { color: red; }",
      epoch: 4,
    });
    const added = answer.selectors.find((s) => s.selector === ".foo");
    expect(added!.reasonCodes).toContain("stylesheet-not-linked-on-page");
  });

  it("samples cascade wins for a rule that is overridden by a more specific rule", async () => {
    const corpus = await crawlSite(SITE_ROOT);
    const oldText = corpus.cssFiles.get(CSS_PATH)!.text;
    const newText = oldText.replace(".btn {\n  color: blue;", ".btn {\n  color: purple;");

    const answer = analyzeChange({ corpus, cssFilePath: CSS_PATH, oldText, newText, epoch: 5 });
    const btnChange = answer.selectors.find((s) => s.selector === ".btn" && s.kind === "modified");
    const colorSample = btnChange!.applies.find((a) => a.property === "color");

    // On index.html, the button also matches .btn.btn-primary (higher specificity),
    // which should win for `color`; on about.html, .btn is the only match and wins.
    expect(colorSample).toBeDefined();
    expect(colorSample!.sampledCount).toBe(2);
    expect(colorSample!.winCount).toBe(1);
  });
});
