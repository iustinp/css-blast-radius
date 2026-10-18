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

1. Install the extension:
   ```bash
   npm run package:extension   # builds packages/vscode-extension/css-blast-radius-0.1.0.vsix
   ```
   In VS Code: Extensions view → **…** menu → **Install from VSIX…** → pick that file, then reload the window.
   Or from a terminal: `code --install-extension packages/vscode-extension/css-blast-radius-0.1.0.vsix`.
   For development, press F5 in this repo instead (Extension Development Host).

   The packaged extension remembers where this repo's server is, so it can start it for you. If you move the repo, rebuild the `.vsix` or set **CSS Blast Radius: Server Path**.
2. Open your project.
3. Click **Link page groups** in the status bar (or run **CSS Blast Radius: Link Page Groups**) and pick the groups you work on.

The choice is saved in `.vscode/settings.json` (`cssBlastRadius.groups`), so the team shares it.

Your CSS files are matched to the site's stylesheets **by file name**. Hashes, version numbers and `.min` are ignored, so `src/css/main.css` matches `/assets/main.3f9a2c.min.css`. No git or build setup is needed.

Which of your changes count is up to the **tabs** at the top of the Blast Radius panel, broadest first:

| Tab | Counts | Compared with |
|---|---|---|
| **All** | every CSS change the live site doesn't have yet: committed, uncommitted, unsaved, or made by other tools | the live site, as last scanned |
| **Uncommitted** (the default) | changes since your last commit, saved or not | the last commit |
| **This session** | changes since this VS Code window opened (a reload starts over; unsaved typing VS Code restores counts as before) | the files when the window opened |
| **Unsaved** | typing you haven't saved yet | the last save |

The tab drives everything: the count at the cursor, the status bar, the page list and the before/after view. A new window opens on the tab set in `cssBlastRadius.diffBase` (Uncommitted unless you change it). Without git there's no Uncommitted tab and windows open on This session.

In the **All** tab, in a git repository, only **your branch's changes** count: if `main` has moved on since your branch started, its newer CSS isn't shown as your edits, and changes of yours that already reached the site (say, an earlier squash merge) aren't counted again, not even part of a rule: if you added two variables to `:root` and the site already has one of them, only the other counts. When `main` has newer commits you haven't pulled, the panel says so and offers **Show main's N newer commits you haven't pulled**: checked, those count too, as if your branch undid them (a plain comparison of your files with the live site). On `main` itself, or on a branch started after the last scan, every commit made since the scan counts too: the scan is older than where your branch starts, so your files are simply compared with it. Rescan to compare with today's site instead. The before/after view shows the live page, then the live page with your changes merged in.

### 4. Edit CSS

- **While you type**, before saving, the number of affected pages appears next to the cursor, and the total appears in the status bar. When the file has other edits too, the cursor shows the edit you're on first, then the file's total: `◀ 2 pages, 56 total (6 edits)`.
- **Hover** the count to see what changed and what it reaches.
- Press **Alt+B** (or click the count) to open the page list, grouped by your linked groups.
- **Pick which edits to look at.** Above the list, each edit is a chip, under a chip per file and an **All edits** chip. Click a chip to pick it, click again to unpick it; you can pick several. Picking a file (or All edits) picks every edit in it; unpicking one edit unpicks its file and All edits (a file with only some edits picked has a dashed outline). The page list, Assess impact and the before/after view then show only the picked edits, so you can see what each one does on its own. The panel opens with everything picked; **Show pages** in a hover picks just that edit.
- **Changed a selector?** Pick just that edit and three buttons split its pages (hover one for details): **All affected** (every page it touches, old selector or new), **Gain the rule** (only the new selector matches there, so the rule's styles appear) and **Lose the rule** (only the old one matched, so they disappear). For example, renaming `.btn-primary` to `.btn-main` gains the pages that have a `.btn-main` but no `.btn-primary`, and loses the pages with a `.btn-primary` but no `.btn-main`.
- **See an edit's whole rule.** Hover the small green ↗ button at the end of an edit chip (or tab to it) to see its rule as it is in the file: the declarations that make up the edit in green (with the old value next to a changed one), the rest in gray, removed ones struck through in red. You can select text in it, or press **Copy**.
- **Jump to the rule.** Click that green ↗ button (or **Go to rule** in the card): it opens the file at the changed line, so you can adjust it right away.
- Click **Assess impact** above the list to check every listed page with your edits applied (a few seconds for a couple dozen pages). The list then puts the pages that look different on top, most changed first, shaded deeper blue; pages with no visual change go to the bottom, unshaded. The next edit clears the ranking.
- **Click a page** to open the before/after comparison in a VS Code tab. It shows the whole page and outlines each element your edits change: the elements your edited rules style, and anything that appears, disappears or looks different. Parents that only grow or shrink around them aren't outlined, so an edit to a few list items outlines those items, not the whole page. An edit to `body` or `html` still outlines the whole page.
  - **Space** flips between before and after. It keeps the same content where it was on screen, even far down a page where your edits pushed things up or down. It lines up the text or image in the middle of the view;
  - **Click a spot** to pin it: flipping then keeps that spot in place instead. Click the pin again, or press **Esc**, to remove it;
  - **N** jumps to the next change;
  - **Check on the live page** loads the real page instead of the stored copy;
  - **Open in browser** opens the same view outside VS Code.
- If CSS files change outside the editor (a pull, a branch switch, another tool) and that moves the total, a notice says how: `now 40 pages affected (was 12 pages)`. Undoing back to the saved text isn't such a change.

### 5. See which CSS isn't on the live site yet

Whatever tab the panel shows, VS Code always marks the CSS that differs from the scanned live site, wherever it came from (your typing, another tool, a pull):

- **Files**: the Explorer and the editor tabs show a badge with the number of such edits, and the folders above them are tinted.
- **Lines**: those edits' lines get a light blue background, a dot in the gutter and a mark in the scroll bar; orange when the edit takes a rule away from at least `warnLostPages` pages. Hover a line for **Compare with the live site**.
- **Change bars**: the gutter shows bars against the live site's version, like git's; click one to see what the live site has. This adds a **Live site** entry to the Source Control view, listing the files. Where git's bars cover the same lines only one kind shows: right-click the gutter to choose which.
- **CSS Not on the Live Site**, a list in the Explorer: each file, then each edit with its page count. Click an edit to jump to it, or use the compare button next to a file.

Lines and files the live site already has aren't marked, even if your branch changed them. Turn any of these off with `cssBlastRadius.liveSite.lineHighlights`, `fileBadges` or `changeBars`.

Other commands:
- **Show All Affected Pages**
- **Rescan Linked Groups**
- **Show Which Changes** (the same as the panel's tabs: All, Uncommitted, This session, Unsaved)
- **Open Setup Page**
- **Reconnect to Server**
- **Compare with Live Site** (also in a CSS file's right-click menu)

Settings: `cssBlastRadius.server` (default `http://127.0.0.1:4317`), `autoStartServer`, `groups`, `diffBase`, `cursorCount`, `warnLostPages`, `codeLens` (off), `liveSite.lineHighlights`, `liveSite.fileBadges`, `liveSite.changeBars`, and `nodePath`. The server needs system Node ≥ 20, because `better-sqlite3` is a native module.

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
npm test                                         # backend (168) + extension (27) unit tests
npm run bench --workspace packages/backend       # L0/L1 latency gates (100 / 250 ms p95)
npm run smoke --workspace packages/backend       # daemon over the socket, L0–L3 (20 checks)
node packages/vscode-extension/scripts/e2e.cjs   # extension vs. a real server on a temp site, stubbed vscode API (15 checks)
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
