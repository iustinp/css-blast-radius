import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type CbrConfig } from "../src/config.js";
import { Store } from "../src/index/store.js";
import { SiteIndex } from "../src/index/siteIndex.js";
import { Capturer, isBlocked } from "../src/capture/capture.js";
import { buildConfig, validateSettings } from "../src/server/settings.js";

const skipBrowser = !!process.env.CBR_NO_BROWSER;

// A page that changes between two tasks of the capture (deterministically: right after its
// stylesheets are read), and a script the site config blocks.
const PAGE = `<!doctype html>
<html><head><link rel="stylesheet" href="/css/site.css"></head>
<body>
  <main>
    <div class="slide"><p class="label">One</p></div>
    <div class="slide"><p class="label">Two</p></div>
    <div class="slide"><p class="label">Three</p></div>
  </main>
  <script>
    // the page changes right after each read of its stylesheets (as a rotating carousel or a
    // lazy decoration would at some point): the next task sees another active slide
    let i = 0;
    const slides = document.querySelectorAll('.slide');
    const rotate = () => {
      i += 1;
      slides.forEach((s, j) => s.classList.toggle('active', j === i % slides.length));
      document.body.classList.toggle('odd', i % 2 === 1);
    };
    const sheets = Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets');
    Object.defineProperty(document, 'styleSheets', {
      get() { setTimeout(rotate, 0); return sheets.get.call(document); },
    });
  </script>
  <script src="/js/pow-captcha.js"></script>
</body></html>`;

const CSS = `
.slide.active .label { color: red; }
.slide:not(.active) .label { color: gray; }
main > .slide.active > .label { font-weight: bold; }
body.odd main .label { text-decoration: underline; }
body:not(.odd) .slide .label { letter-spacing: 1px; }
body.captcha-ran main { outline: 1px solid; }
`;

describe("capture.block patterns", () => {
  const cfg = { capture: { block: ["/altcha/", "pow-captcha\\.js$", "("] } } as unknown as CbrConfig;

  it("matches request URLs case-insensitively", () => {
    expect(isBlocked(cfg, "https://example.com/etc/altcha/altcha.js")).toBe(true);
    expect(isBlocked(cfg, "https://example.com/js/POW-CAPTCHA.js")).toBe(true);
    expect(isBlocked(cfg, "https://example.com/js/site.js")).toBe(false);
  });

  it("ignores an invalid pattern instead of failing", () => {
    expect(isBlocked({ capture: { block: ["("] } } as unknown as CbrConfig, "https://example.com/(")).toBe(false);
  });

  it("blocks nothing without patterns", () => {
    expect(isBlocked({ capture: {} } as unknown as CbrConfig, "https://example.com/altcha/")).toBe(false);
  });

  it("are kept from the server settings", () => {
    const s = validateSettings({ siteUrl: "example.com", devices: ["desktop"], block: [" /altcha/ ", ""] });
    expect(s.block).toEqual(["/altcha/"]);
    expect(buildConfig(s, "/tmp/data").capture.block).toEqual(["/altcha/"]);
    expect(validateSettings({ siteUrl: "example.com", devices: ["desktop"] }).block).toBeUndefined();
  });

  it("refuses an invalid pattern in the server settings", () => {
    expect(() => validateSettings({ siteUrl: "example.com", devices: ["desktop"], block: ["("] })).toThrow(/valid pattern/);
  });
});

describe.skipIf(skipBrowser)("capture on a page that changes while it is captured", () => {
  let tempDir: string;
  let store: Store;
  let idx: SiteIndex;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-churn-test-"));
    const ws = path.join(tempDir, "site");
    fs.mkdirSync(path.join(ws, "css"), { recursive: true });
    fs.mkdirSync(path.join(ws, "js"), { recursive: true });
    fs.writeFileSync(path.join(ws, "index.html"), PAGE);
    fs.writeFileSync(path.join(ws, "css", "site.css"), CSS);
    fs.writeFileSync(path.join(ws, "js", "pow-captcha.js"), "document.body.classList.add('captcha-ran');");
    fs.writeFileSync(
      path.join(ws, "cbr.config.json"),
      JSON.stringify({ urls: ["/index.html"], capture: { matcherSample: 1, block: ["pow-captcha\\.js$"] } }),
    );
    const config = loadConfig(ws, { dataDir: path.join(tempDir, "data") });
    store = new Store(config.dataDir);
    await new Capturer(config, store).run({});
    idx = SiteIndex.load(store)!;
  }, 120_000);

  afterAll(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("checks the selectors against the tree they were evaluated on: no disagreement", () => {
    const disagree = idx.matcherChecks.reduce((n, c) => n + c.disagree, 0);
    expect(idx.matcherChecks.length).toBeGreaterThan(0);
    expect(disagree).toBe(0);
    expect([...idx.unsupportedFeatures]).toEqual([]);
  });

  it("does not load a blocked script", () => {
    const [page] = idx.pages;
    expect(Object.keys(page.assets).some((u) => u.includes("pow-captcha"))).toBe(false);
    expect(Object.keys(page.assets).some((u) => u.includes("site.css"))).toBe(true);
  });
});
