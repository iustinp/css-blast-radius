// Loads a captured L2 shell into a Chromium tab: the navigation is answered
// with the shell HTML (scripts blocked by CSP), subresources come from the
// asset store as captured, and everything else is aborted. Nothing touches
// the network or the current files on disk.

import type { Page } from "playwright-core";
import type { Store } from "../index/store.js";
import { SETTLE_SCRIPT } from "../capture/inPage.js";

export function assetKey(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

export async function openShell(
  page: Page,
  store: Store,
  opts: { url: string; html: string; assets: Record<string, string>; timeoutMs?: number },
): Promise<void> {
  const navUrl = assetKey(opts.url);
  await page.route("**/*", async (route) => {
    const req = route.request();
    const u = assetKey(req.url());
    if (req.isNavigationRequest() && u === navUrl) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'none'" },
        body: opts.html,
      });
      return;
    }
    const a = opts.assets[u];
    if (a) {
      const [hash, ...ct] = a.split(" ");
      try {
        await route.fulfill({ status: 200, headers: { "content-type": ct.join(" ") || "application/octet-stream" }, body: store.getBlob(hash) });
        return;
      } catch {
        /* missing blob: abort below */
      }
    }
    await route.abort();
  });
  await page.goto(navUrl, { waitUntil: "load", timeout: opts.timeoutMs ?? 15_000 });
  await page.evaluate(SETTLE_SCRIPT);
}
