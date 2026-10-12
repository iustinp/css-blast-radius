# CSS Blast Radius — v1 implementation

A local-only prototype of the architecture described in
[`css-blast-radius-tool-architecture.md`](./css-blast-radius-tool-architecture.md):
a backend engine that crawls a static HTML site, indexes CSS selector usage
across every page, and answers live "how many pages/elements does this CSS
change affect" queries as you edit — plus a VS Code extension thin client
that surfaces those answers via CodeLens, hover, the Problems panel, and a
drilldown webview.

## Packages

- **`packages/backend`** — the engine. Runs as a local daemon (or, per the
  architecture doc, could later back a shared index service): crawls a site
  root, builds an in-memory + SQLite-backed index, watches CSS files, and
  exposes a JSON-RPC 2.0 API over a Unix domain socket / Windows named pipe.
- **`packages/vscode-extension`** — the thin IDE client. Owns document
  lifecycle events, daemon discovery/launch/health, and UI surfacing only;
  it never crawls, parses CSSOM, or touches a browser.
- **`fixtures/site`** — a tiny 3-page demo site with shared CSS, used by the
  backend's test suite and for manual end-to-end runs.

## Running it

```bash
npm install
npm run build

# Start the daemon directly against the fixture site:
node packages/backend/dist/cli.js --root fixtures/site --socket /tmp/css-blast-radius.sock
```

To try the VS Code extension: open this repo in VS Code, set
`cssBlastRadius.siteRoot` to `fixtures/site` in workspace settings, press
F5 to launch an Extension Development Host, open
`fixtures/site/css/main.css`, and edit a rule — a CodeLens with the live
impact count should appear above it, and hovering shows the full answer
contract.

## Tests

```bash
npm run test --workspace packages/backend
```

7 tests cover: crawling/clustering, exact match counts on modified rules,
zero-match reason codes, loss/fallback detection on removed rules,
unlinked-stylesheet reason codes, and cascade-win sampling.

## What's implemented vs. the architecture doc

> **Direction change.** The architecture doc describes the target design.
> Pages are captured once in Chromium, in the background, and every site
> selector is evaluated on them natively at capture time. Live queries then
> become set operations on in-memory page bitmaps, which gives four levels:
> an **instant page count while typing (L0)**, a **fast page list (L1)**, a
> **before/after browser check of one requested page (L2)** and an optional
> **live-page check (L3)**. Counts are split into `exact` / `possible` /
> `unknown` pages, and `0` is only shown with a reason. This prototype
> predates that design: it implements the daemon/protocol/client plumbing
> but uses jsdom with a heuristic cascade. See the doc's **§16
> "Implementation plan (from the current prototype)"** for the ordered
> steps; the notes below describe the prototype as it stands.

**Planned speed contract:** warm L0 aims for a first visible answer within
100 ms of a keystroke, debounce included, measured end to end; L1 aims for a
first response within 250 ms. These are targets, not measured prototype
performance. A selector the index hasn't seen yet shows an upper bound
(`Up to 340 pages`) that is refined in the background instead of delaying
the count. A matching page is not necessarily a visually changed page; that
is what the L2 check answers.

This is a working v1 prototype that implements the **local-only mode** end to end:
crawling and indexing a static site, live lookup on every edit, the
prototype's answer contract (`matches` / `applies` / `inheritsInto`,
confidence tags, reason codes, loss reporting — the doc replaces it with
page counts, §8), the JSON-RPC protocol with an `initialize` handshake,
daemon lifecycle (launch/attach/health/backoff), file-watching ownership
(editor buffer vs. disk, with dedup on save), and the VS Code
CodeLens/hover/diagnostics/webview surfaces.

**Deliberately out of scope for this pass** (the architecture doc's §17
lists what stays out of the target design itself; these are
implementation-level follow-ups, not scope disagreements):

- **Shared/team index service and hosted mode.** The protocol and data
  model were designed to support `SHARED_INDEX` / `VERIFY_PENDING` basis
  values and a remote endpoint, but no shared-service process, auth, or
  base-revision-selection logic is implemented — v1 ships local-only.
- **Real headless-browser capture.** Pages are parsed with jsdom instead of
  Playwright/Chromium; there is no script execution, no real layout/paint,
  and no browser-verified before/after comparison. Selectors are matched
  against static HTML, while cascade "applies" resolution is a
  specificity/order heuristic rather than a browser-verified winner, and `@media`/`@supports`/
  `@container` activation is never evaluated (always downgraded to
  `PARTIAL` with `condition-not-evaluated`).
- **Hot bitmap/match caches and compact on-disk element trees.** The SQLite
  store persists index-revision/page metadata for `index/getStatus`, but live
  queries re-run against the in-memory corpus. Fine at fixture/demo scale;
  the planned cached L0/L1 paths are not implemented.
- **NDJSON transport instead of LSP-style `Content-Length` framing.** Same
  JSON-RPC 2.0 message shapes, simpler framing.
- **Level-based RPC methods** (`analysis/getPages`; `analysis/getDrilldown`
  for L1 elements and L2 measurements; `analysis/openLive`;
  `session/setDiffBase`; the `analysis/refined` notification) **and
  custom-property (`--var`) fan-out queries.** The daemon advertises
  `analysis/verifyExactly` and `analysis/getDrilldown` but handles neither,
  and the extension's "verify exactly" command just re-runs the full
  analysis; the doc folds `verifyExactly` into `getDrilldown` (L2). The
  var-decl/var-use graph is parsed and diffed but not yet wired into
  `analyzeChange`'s selector fan-out.
- **The L0–L3 model itself** — edit-type classification, selector
  relaxation, page bitmaps, incremental `document/change` (the extension
  sends the full text on every change), deploy/CMS sync. None of it is
  implemented yet. In particular, `skeletonHash` ignores attribute values,
  so it is **not** sound for match-equivalence. The doc never treats
  templates or clusters as a correctness unit: every page gets its own
  verdict (§5.4). Clusters are only recorded, never used, and queries
  still run against every linking page instead of bitmaps.
- **While-typing surfaces.** The prototype shows counts in CodeLens, which
  VS Code refreshes no sooner than 250 ms after an edit. The doc moves the
  L0 count to an end-of-line decoration and a status-bar total, and keeps
  CodeLens for settled counts (§7.1).
- **Compiled-CSS build adapters, faithful Shadow DOM/iframe replay, packaged
  `.vsix`/binary distribution.** Not implemented. Unsupported replay and
  pipelines must be reported explicitly as those capabilities are added.
