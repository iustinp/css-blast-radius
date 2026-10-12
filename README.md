# CSS Blast Radius

See how many pages of your site a CSS edit reaches, while you type — so a change
meant for one page doesn't quietly alter a hundred others. Design:
[`css-blast-radius-tool-architecture.md`](./css-blast-radius-tool-architecture.md).

Every page is captured once in headless Chromium. At capture time each site
selector is evaluated natively, and each page is stored as a compact
"hibernated" element tree. After that, a live edit is answered from memory in
four levels:

| Level | Answer | When | Measured (401-page fixture) |
|---|---|---|---|
| **L0** | Page count (`exact` / `possible` / `unknown`) | every keystroke | bench p95 **6.9 ms** in-process; keystroke → status bar **~17 ms** end to end |
| **L1** | Page list, refined counts per rule | right after | bench p95 **9.2 ms** (max 104 ms) |
| **L2** | Before/after render of one page (box diff, screenshots) | on request | ~0.2–0.5 s |
| **L3** | Same check on the live page | on request | ~0.7 s |

Every page gets its own verdict, so copied pages that drift from their
template are still counted. `0` is only shown with a reason.

## Packages

- **`packages/backend`**: the daemon and CLI.
  - Chromium capture (Playwright) with a SQLite + blob store.
  - CSS model and diff: rules, selectors, custom properties, `@keyframes` / `@font-face` / `@layer` and other definitions.
  - L0 bitmap engine, L1 worker pool (css-select over the hibernated trees), L2/L3 renderer.
  - Diff bases: `HEAD`, `saved`, `session`, `production`.
  - JSON-RPC 2.0 over NDJSON on a Unix socket (mode 0600).
- **`packages/vscode-extension`**: a thin client.
  - Starts or attaches to the daemon and syncs open CSS buffers incrementally.
  - Surfaces: end-of-line counts, status-bar session total, Problems (lost pages), CodeLens, hover, and a page-list panel with L1/L2/L3 detail.
- **`fixtures/generate-large-site.mjs`**: deterministic generator for a large test site (default 400 pages plus index). Includes templates, copy pages that drift from them, legacy CSS, media/container queries, custom properties and animations.
- **`fixtures/site`**: a 3-page site used by unit tests.

## Try it

```bash
npm install
npm exec --workspace packages/backend -- playwright-core install chromium
npm run build

# A 401-page site in a git repo (the default diff base is HEAD):
node fixtures/generate-large-site.mjs /tmp/cbr-ws
git -C /tmp/cbr-ws init -q && git -C /tmp/cbr-ws add -A && git -C /tmp/cbr-ws commit -qm site

# Capture it once (~35–45 s for 401 pages), then query or serve:
node packages/backend/dist/cli.js capture --workspace /tmp/cbr-ws --data /tmp/cbr-data
node packages/backend/dist/cli.js impact  --workspace /tmp/cbr-ws --data /tmp/cbr-data --pages
node packages/backend/dist/cli.js daemon  --workspace /tmp/cbr-ws --data /tmp/cbr-data
```

`impact` reports the blast radius of the working tree against the diff base.
Edit `/tmp/cbr-ws/css/components.css` first to see a non-zero answer.

**VS Code:**
1. Press F5 in this repo to open an Extension Development Host, then open `/tmp/cbr-ws` in it.
2. Set `cssBlastRadius.dataDir` to `/tmp/cbr-data`, or run **CSS Blast Radius: Capture Site**.
3. Edit any rule in `css/`.

Other commands: **Show Pages**, **Change Diff Base**, **Restart Daemon**.

Settings:
- `siteRoot`, `baseUrl`, `dataDir`, `diffBase`, `warnLostPages`, `codeLens`.
- `nodePath`: the daemon runs on system Node ≥ 20, not the editor's runtime, because `better-sqlite3` is a native module.
- `daemonPath`.

**`cbr.config.json`** (optional, in the workspace root):
- `root`: site folder; defaults to the workspace.
- `baseUrl`: for a served site.
- `urls`: defaults to every `*.html`.
- `profiles`: `"desktop"`, `"mobile"` or custom viewports.
- `recipes`: click/hover/fill steps captured as extra states.
- `stylesheets`: `{ urlPrefix, dir }` mappings.
- `capture`: `{ concurrency, timeoutMs, fidelitySample, matcherSample }`.
- `dataDir`.

## Tests

```bash
npm test                                         # backend (113) + extension (9) unit tests
npm run bench --workspace packages/backend       # L0/L1 latency gates (100 / 250 ms p95)
npm run smoke --workspace packages/backend       # daemon over the socket, L0–L3 (20 checks)
node packages/vscode-extension/scripts/e2e.cjs   # extension vs. real daemon, stubbed vscode API (11 checks)
```

Bench, smoke and e2e need the captured `/tmp/cbr-ws` + `/tmp/cbr-data` from
above. Set `CBR_NO_BROWSER=1` to skip the Chromium-backed unit tests. The L1
cross-check test compares the css-select matcher against Chromium on the
fixture; it currently finds 0 disagreements.

## Status

Implemented: the architecture doc's §16 steps 1–5, plus diff bases and
stylesheet mapping from step 6.

Not yet implemented:
- Production sync / CI refresh.
- Shared team index.
- Source maps and build adapters (Sass, PostCSS, CSS-in-JS).
- `.vsix` packaging.

Known limitations:
- **Not captured:** Shadow DOM and iframes, and pages added after the last capture (re-run capture).
- **Selectors:** `:state()` and `:local-link` are treated as interaction states, so they count as `possible`. A new selector using `:dir()` stays `possible` until L2, because the L1 matcher (css-select) can't evaluate it; captured selectors are exact.
- **Definitions:** uses of a definition (`@keyframes`, `@font-face`, `@property`, …) are counted as exact.
- **Broken CSS:** a saved file is read the way browsers read it: a statement that doesn't parse, or a rule with an invalid selector, counts as removed (and is flagged in Problems). While typing, the broken part keeps its last valid version, so the rest of the file is still analyzed.
- **Custom properties at L2:** the render diff compares the properties that consume the variable in the page's stylesheets. If nothing there consumes it (inline styles, scripts), it compares a default property set and reports `inconclusive` rather than `unchanged`.
- **`session` diff base:** when the site has too much CSS to snapshot at session start, files left out are compared with their content when first opened, and the answer says so.
- **Daemon and editor:**
  - No blob garbage collection.
  - Multi-root workspaces use the first folder.
  - **Restart Daemon** also stops a daemon started from the CLI.
