import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, type PageRow } from "../src/index/store.js";
import { IndexBuilder, SiteIndex } from "../src/index/siteIndex.js";

const VARIANTS = [{ id: 0, name: "desktop", profile: "desktop" }];
const A = "/a.html";
const B = "/b.html";

function page(b: IndexBuilder, url: string): number {
  const id = b.id(url);
  const row: PageRow = { id, url, status: "ok", quirks: false, trees: {}, shells: {}, assets: {}, capturedAt: new Date().toISOString() };
  b.setPage(row);
  return id;
}

function publish(store: Store, b: IndexBuilder, source: string): SiteIndex {
  b.publish(store, store.createRevision(source, b.variants), {});
  return SiteIndex.load(store)!;
}

// Partial recaptures (scanning in batches, auto-rescan) used to add the previous scan's
// matcher checks to their own: a disagreement stayed after its page was recaptured.
describe("matcher checks across partial recaptures", () => {
  let tempDir: string;
  let store: Store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-matcher-check-"));
    store = new Store(tempDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("replace the checks of the recaptured pages and keep the others", () => {
    const full = new IndexBuilder(VARIANTS, [A, B]);
    full.addMatcherCheck(page(full, A), "comb: ", false, "main .x on /a.html: chromium=true l1=false");
    full.addMatcherCheck(page(full, B), "comb: ", true);
    let idx = publish(store, full, "full");
    expect([...idx.unsupportedFeatures]).toEqual(["comb: "]);

    const again = new IndexBuilder(VARIANTS, [A], idx);
    again.addMatcherCheck(page(again, A), "comb: ", true);
    idx = publish(store, again, "partial");
    expect(idx.matcherChecks).toEqual([{ feature: "comb: ", agree: 2, disagree: 0, example: undefined }]);
    expect([...idx.unsupportedFeatures]).toEqual([]);

    // a disagreement on a page that isn't recaptured is kept
    const other = new IndexBuilder(VARIANTS, [B], idx);
    other.addMatcherCheck(page(other, B), "comb: ", false, "main .x on /b.html: chromium=false l1=true");
    idx = publish(store, other, "partial");
    const third = new IndexBuilder(VARIANTS, [A], idx);
    third.addMatcherCheck(page(third, A), "comb: ", true);
    idx = publish(store, third, "partial");
    expect(idx.matcherChecks[0]).toMatchObject({ agree: 1, disagree: 1 });
    expect([...idx.unsupportedFeatures]).toEqual(["comb: "]);
  });

  it("keep the totals of an older scan that didn't record pages", () => {
    const full = new IndexBuilder(VARIANTS, [A, B]);
    page(full, A);
    page(full, B);
    let idx = publish(store, full, "full");
    store.db.prepare("INSERT INTO matcher_check (rev, feature, agree, disagree, example) VALUES (?, ?, ?, ?, ?)").run(idx.revision.id, "pseudo:is", 5, 1, "x");
    idx = SiteIndex.load(store)!;
    expect([...idx.unsupportedFeatures]).toEqual(["pseudo:is"]);

    for (let i = 0; i < 2; i++) {
      const again = new IndexBuilder(VARIANTS, [A], idx);
      again.addMatcherCheck(page(again, A), "pseudo:is", true);
      idx = publish(store, again, "partial");
    }
    expect(idx.matcherChecks).toEqual([{ feature: "pseudo:is", agree: 6, disagree: 1, example: "x" }]);
  });
});
