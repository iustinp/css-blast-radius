// Crawl-time page capture (Phase A), implemented with jsdom instead of a
// real headless browser (see README "Known simplifications"). Capture is
// pristine and non-interactive: we parse the HTML as authored, run no
// scripts, load no external resources, and never mutate the DOM.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { JSDOM } from "jsdom";

export interface CapturedPage {
  url: string;
  filePath: string;
  dom: JSDOM;
  skeletonHash: string;
  /** Resolved absolute file paths of <link rel=stylesheet> hrefs found on this page. */
  linkedStylesheetPaths: string[];
  /** Concatenated inline <style> text, if any (kept separate from linked files). */
  inlineStyleText: string;
  hasShadowDomHint: boolean;
  hasIframe: boolean;
}

function skeletonHash(document: Document): string {
  const hash = createHash("sha256");
  function walk(node: Element) {
    const classes = Array.from(node.classList).sort().join(".");
    const attrNames = Array.from(node.attributes)
      .map((a) => a.name)
      .filter((n) => n !== "class" && n !== "id")
      .sort()
      .join(",");
    hash.update(`<${node.tagName}#${node.id}.${classes}[${attrNames}]>`);
    for (const child of Array.from(node.children)) walk(child as Element);
  }
  if (document.documentElement) walk(document.documentElement);
  return hash.digest("hex");
}

export async function capturePage(filePath: string, siteRoot: string): Promise<CapturedPage> {
  const html = await readFile(filePath, "utf8");
  const dom = new JSDOM(html, {
    url: `file://${filePath}`,
    runScripts: "outside-only", // pristine: never execute page scripts
    resources: undefined, // never fetch external resources
    pretendToBeVisual: false,
  });
  const { document } = dom.window;

  const linkedStylesheetPaths: string[] = [];
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute("href");
    if (!href || /^https?:\/\//.test(href)) continue; // cross-origin: flagged, not indexed
    linkedStylesheetPaths.push(path.resolve(path.dirname(filePath), href));
  }

  const inlineStyleText = [...document.querySelectorAll("style")]
    .map((s) => s.textContent ?? "")
    .join("\n");

  const hasShadowDomHint = html.includes("attachShadow");
  const hasIframe = document.querySelectorAll("iframe").length > 0;

  return {
    url: "/" + path.relative(siteRoot, filePath).split(path.sep).join("/"),
    filePath,
    dom,
    skeletonHash: skeletonHash(document),
    linkedStylesheetPaths,
    inlineStyleText,
    hasShadowDomHint,
    hasIframe,
  };
}
