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

## How to use it

CSS Blast Radius has three parts:

- a **local server**, one per website;
- a **setup page** in your browser, where you say which pages to watch;
- the **VS Code extension**, which shows the impact while you type.

### 1. Install and start the server

```bash
npm install
npm exec --workspace packages/backend -- playwright-core install chromium
npm run build
npm run serve            # same as: node packages/backend/dist/cli.js serve
```

It prints `Set up your site: http://127.0.0.1:4317`. Leave it running.

The VS Code extension also starts the server by itself if it isn't running.

Options:
- `--port 4317`
- `--data ~/.css-blast-radius`: where scans are kept.
- `--host 127.0.0.1`: there's no login yet, so expose it beyond your machine only on a trusted network.

### 2. Set up the site (browser, once)

Open <http://127.0.0.1:4317>.

1. **Site address**: the live site (`https://www.example.com`) or a folder on this computer with the built HTML (`/Users/me/site/dist`).
2. **Devices**: desktop, mobile and/or tablet. Every page is scanned on each one.
3. **Add group**: a named list of pages, from either:
   - a **sitemap**, optionally filtered, e.g. `/blog/*`;
   - a **CSV file** (the column of URLs is found automatically);
   - **pasted** addresses or paths.

   Leave **Scan now** on. Scanning takes about 0.1 s per page per device, in the background.

From the same page you can:
- **Pause** a group you aren't working on: it stops counting and isn't rescanned. **Resume** it to bring it back.
- **Rescan** a group after a deploy. Sitemap groups also pick up new pages and drop removed ones.
- **Delete** a group (you can undo for 5 minutes).
- Open a group to see each page's status. Rescan failed pages, or exclude a page so a sitemap rescan doesn't bring it back.
- Check **Stylesheets on the site** to see which of your project files each site stylesheet was matched to.

### 3. Link your project in VS Code (once per project)

1. Install the extension. For development: press F5 in this repo to open an Extension Development Host.
2. Open your project.
3. Click **Link page groups** in the status bar (or run **CSS Blast Radius: Link Page Groups**) and pick the groups you work on.

The choice is saved in `.vscode/settings.json` (`cssBlastRadius.groups`), so the team shares it.

Your CSS files are matched to the site's stylesheets **by file name**. Hashes, version numbers and `.min` are ignored, so `src/css/main.css` matches `/assets/main.3f9a2c.min.css`. No git or build setup is needed.

What your edits are compared with is **the live site, as last scanned**.

### 4. Edit CSS

- **While you type**, before saving, the number of affected pages appears next to the cursor, and the total appears in the status bar.
- **Hover** the count to see what changed and what it reaches.
- Press **Alt+B** (or click the count) to open the page list, grouped by your linked groups.
- **Click a page** to open the before/after comparison in a VS Code tab. It shows the whole page and outlines what changed:
  - **Space** flips between before and after;
  - **N** jumps to the next change;
  - **Check on the live page** loads the real page instead of the stored copy;
  - **Open in browser** opens the same view outside VS Code.
- If CSS files change outside the editor (a pull, a branch switch, another tool), a notice tells you how the total moved.

Other commands:
- **Show All Affected Pages**
- **Rescan Linked Groups**
- **Change Diff Base** (e.g. compare with the last save or with git `HEAD` instead)
- **Open Setup Page**
- **Reconnect to Server**

Settings: `cssBlastRadius.server` (default `http://127.0.0.1:4317`), `autoStartServer`, `groups`, `diffBase`, `cursorCount`, `warnLostPages`, `codeLens` (off), and `nodePath`. The server needs system Node ≥ 20, because `better-sqlite3` is a native module.

## Packages

- **`packages/backend`**: the server and CLI.
  - Chromium capture (Playwright) with a SQLite + blob store.
  - CSS model and diff: rules, selectors, custom properties, `@keyframes` / `@font-face` / `@layer` and other definitions.
  - L0 bitmap engine, L1 worker pool (css-select over the hibernated trees), L2/L3 renderer.
  - `serve`: one HTTP port for the setup page (`ui/setup.html`), the diff viewer (`ui/diff.html`), a REST API with live updates (Server-Sent Events) and the editor connection (JSON-RPC 2.0 over an upgraded HTTP request). It accepts only `localhost` requests and same-origin JSON writes.
  - The older per-workspace `daemon` (Unix socket) and `capture`/`impact` commands still work for scripts and CI.
- **`packages/vscode-extension`**: a thin client.
  - Connects to (or starts) the server and syncs open CSS buffers incrementally.
  - Surfaces: count next to the cursor, status bar, hover, Problems (lost pages), page panel, diff tab, and an outside-editor change notice.
- **`fixtures/generate-large-site.mjs`**: deterministic generator for a large test site (default 400 pages plus index). Includes templates, copy pages that drift from them, legacy CSS, media/container queries, custom properties and animations.
- **`fixtures/site`**: a 3-page site used by unit tests.

### Command line without the server

```bash
# A 401-page site in a git repo (the diff base is HEAD):
node fixtures/generate-large-site.mjs /tmp/cbr-ws
git -C /tmp/cbr-ws init -q && git -C /tmp/cbr-ws add -A && git -C /tmp/cbr-ws commit -qm site
node packages/backend/dist/cli.js capture --workspace /tmp/cbr-ws --data /tmp/cbr-data
node packages/backend/dist/cli.js impact  --workspace /tmp/cbr-ws --data /tmp/cbr-data --pages
```

**`cbr.config.json`** (optional, in the workspace root; CLI/daemon only):
- `root`, `baseUrl`, `urls`.
- `profiles`, `recipes` (click/hover/fill steps captured as extra states).
- `stylesheets` (`{ urlPrefix, dir }` mappings).
- `capture`, `dataDir`.

## Tests

```bash
npm test                                         # backend (130) + extension (14) unit tests
npm run bench --workspace packages/backend       # L0/L1 latency gates (100 / 250 ms p95)
npm run smoke --workspace packages/backend       # daemon over the socket, L0–L3 (20 checks)
node packages/vscode-extension/scripts/e2e.cjs   # extension vs. a real server on a temp site, stubbed vscode API (10 checks)
```

`test/server.test.ts` drives the server end to end: setup, sitemap/pasted groups, scanning, linked-group counts over the editor connection, the before/after diff, live events, exclusions, undo, and the outside-editor change notice. Bench and smoke need the captured `/tmp/cbr-ws` + `/tmp/cbr-data` from above. Set `CBR_NO_BROWSER=1` to skip the Chromium-backed unit tests.

## Status

Implemented:
- The architecture doc's §16 steps 1–5, plus diff bases and stylesheet mapping from step 6.
- The local server with the setup page, page groups, linked groups per project, name-based stylesheet matching against the live site, and the before/after diff viewer.

Not yet implemented:
- CI refresh after production deploys (today: **Rescan** on the setup page).
- Login, for hosting the server for a team.
- Shared team index.
- Source maps and build adapters (Sass, PostCSS, CSS-in-JS).
- `.vsix` packaging.

Known limitations:
- **Not captured:** Shadow DOM and iframes, and pages added after the last scan (rescan the group).
- **Scans:** a page removed from every group stays in the stored index until **Rescan all**, but it isn't counted.
- **Linked groups not scanned yet:** counts show 0 with "no linked groups" until the first scan finishes.
- **Selectors:** `:state()` and `:local-link` are treated as interaction states, so they count as `possible`. A new selector using `:dir()` stays `possible` until L2, because the L1 matcher (css-select) can't evaluate it; captured selectors are exact.
- **Definitions:** uses of a definition (`@keyframes`, `@font-face`, `@property`, …) are counted as exact.
- **Broken CSS:** a saved file is read the way browsers read it: a statement that doesn't parse, or a rule with an invalid selector, counts as removed (and is flagged in Problems). While typing, the broken part keeps its last valid version, so the rest of the file is still analyzed.
- **Custom properties at L2:** the render diff compares the properties that consume the variable in the page's stylesheets. If nothing there consumes it (inline styles, scripts), it compares a default property set and reports `inconclusive` rather than `unchanged`.
- **`session` diff base:** when the site has too much CSS to snapshot at session start, files left out are compared with their content when first opened, and the answer says so.
- **Server and editor:**
  - No blob garbage collection.
  - Multi-root workspaces use the first folder.
  - One server watches one site. Run a second server with another `--port` and `--data` for another site.
