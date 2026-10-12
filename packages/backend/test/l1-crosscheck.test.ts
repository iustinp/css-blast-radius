import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type CbrConfig } from "../src/config.js";
import { Store } from "../src/index/store.js";
import { SiteIndex } from "../src/index/siteIndex.js";
import { Capturer, serveSite } from "../src/capture/capture.js";
import { L1Pool } from "../src/l1/pool.js";
import { analyzeComplex } from "../src/css/selectors.js";
import { SETTLE_SCRIPT } from "../src/capture/inPage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSiteDir = path.resolve(__dirname, "../../../fixtures/site");

const skipBrowser = !!process.env.CBR_NO_BROWSER;

describe.skipIf(skipBrowser)("L1 matcher vs Chromium cross-check (§6.5, §16)", () => {
  let tempDir: string;
  let ws: string;
  let dataDir: string;
  let cfg: CbrConfig;
  let store: Store;
  let idx: SiteIndex;
  let pool: L1Pool;
  let browser: Browser;

  const testSelectors = [
    // Descendant
    "div.card span.title",
    // Child
    "div.card > span.title",
    // Adjacent sibling
    "div#hero + button.btn",
    // General sibling
    "div#hero ~ div.card",
    // :not()
    "button:not(.btn-primary)",
    // :is()
    ":is(button, div).btn",
    // :where()
    ":where(button, a).btn",
    // Attribute exact
    '[id="hero"]',
    // Attribute prefix
    '[class^="btn"]',
    // Attribute suffix
    '[class$="primary"]',
    // Attribute substring
    '[class*="primary"]',
    // :nth-child
    "body > *:nth-child(2)",
    // :nth-child(An+B)
    "body > *:nth-child(2n+1)",
    // :first-child
    "body > *:first-child",
    // :last-child
    "body > *:last-child",
    // :first-of-type
    "body > div:first-of-type",
    // :has()
    "div:has(span.title)",
    // Pseudo-element (relaxed)
    "button.btn::before",
    // Compound class
    "button.btn.btn-primary",
    // Tag and class
    "button.btn",
    // Universal + ID
    "*#hero",
    // Non-matching selector
    ".completely-nonexistent-class",
  ];

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-l1-test-"));
    ws = path.join(tempDir, "site");
    dataDir = path.join(tempDir, "data");

    fs.cpSync(fixtureSiteDir, ws, { recursive: true });

    cfg = loadConfig(ws, { dataDir });
    store = new Store(cfg.dataDir);

    const capturer = new Capturer(cfg, store);
    await capturer.run({});

    idx = SiteIndex.load(store)!;
    expect(idx).toBeDefined();

    pool = new L1Pool({ blobDir: store.blobDir, workers: 0 });
    await pool.warm(idx);

    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.close();
    if (browser) await browser.close();
    if (store) store.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies L1 matcher produces zero disagreements against Chromium across diverse selectors", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => serveSite(cfg, route));

    // Measure ground truth from Chromium for each page
    const pageUrls = idx.pages.filter((p) => p.status === "ok").map((p) => p.url);
    const chromiumGroundTruth = new Map<string, Set<string>>();

    for (const url of pageUrls) {
      const full = new URL(url, cfg.origin).href;
      await page.goto(full, { waitUntil: "load" });
      await page.evaluate(SETTLE_SCRIPT);

      for (const sel of testSelectors) {
        // Pseudo-elements cannot be selected by querySelectorAll; evaluate relaxed selector
        const complex = analyzeComplex(sel);
        const evalSel = complex.key;

        const matches = await page.evaluate((s) => {
          try {
            return document.querySelectorAll(s).length > 0;
          } catch {
            return false;
          }
        }, evalSel);

        if (matches) {
          let set = chromiumGroundTruth.get(sel);
          if (!set) chromiumGroundTruth.set(sel, (set = new Set()));
          set.add(url);
        }
      }
    }
    await page.close();
    await context.close();

    // Now evaluate each selector via L1Pool
    let disagreements = 0;
    const disagreementDetails: string[] = [];

    for (const sel of testSelectors) {
      const complex = analyzeComplex(sel);
      const key = complex.key;
      const pending = new Map([[key, idx.ok.clone()]]);
      const results = await pool.resolve(pending, idx);

      expect(results).toHaveLength(1);
      const res = results[0];

      if (res.unsupported) {
        // If unsupported, L1 marks it unsupported
        continue;
      }

      const l1MatchedUrls = res.matched.map((id) => idx.pages[id].url).sort();
      const chromiumMatchedUrls = [...(chromiumGroundTruth.get(sel) ?? new Set())].sort();

      if (JSON.stringify(l1MatchedUrls) !== JSON.stringify(chromiumMatchedUrls)) {
        disagreements++;
        disagreementDetails.push(
          `Selector: "${sel}" (key: "${key}") -> L1 matched: [${l1MatchedUrls.join(", ")}], Chromium matched: [${chromiumMatchedUrls.join(", ")}]`,
        );
      }
    }

    if (disagreements > 0) {
      console.error("Disagreements found:\n" + disagreementDetails.join("\n"));
    }
    expect(disagreements).toBe(0);
  }, 60_000);
});
