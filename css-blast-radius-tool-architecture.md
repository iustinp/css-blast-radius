# CSS Blast Radius — Architecture

> **Status:** target design. The prototype in `packages/` implements only a
> small local slice of it — see `README.md` and §16. Figures marked **≈** are
> estimates to benchmark, not measurements.

## The problem

On a large site (thousands of pages), a developer editing shared CSS cannot
see how far a change reaches. Today they guess, grep for class names, or find
out in QA or production. Many of our pages are 1:1 copies of external pages,
so they don't follow their nominal templates: every page has to be judged on
its own.

The goal: **while you type**, see how many pages your change reaches; **on
request**, which pages; **on request**, what exactly changes on one of them.
Precise enough to trust, fast enough not to notice. It runs locally, against
a shared team server or against a hosted one, with VS Code as the first
client.

## 1. The idea in 60 seconds

A developer opens `src/styles/card.css` and changes one line:

```css
.card { padding: 16px; }   /* → */   .card { padding: 24px; }
```

| Level | When | What they see | Where it comes from |
|---|---|---|---|
| **L0** | While typing (≤ 100 ms) | `312 pages` at the end of the line; `Your edits: 312 pages` in the status bar | An in-memory set of the pages where `.card` matches, computed in advance |
| **L1** | On click (≤ 250 ms) | The 312 pages, grouped by URL, searchable | The same set, turned into URLs |
| **L2** | On picking a page (seconds) | "14 elements changed: `padding` 16px → 24px; 3 elements moved down 16px", plus before/after images | That page's saved copy, opened in a headless browser and measured before and after the edit |
| **L3** | Optionally (seconds) | The same comparison on the real, live page | A full live page load, with scripts and any login or clicks needed |

The trick: the expensive part — loading every page in a real browser —
already happened in the background, during **capture** (§5). While you type,
the tool only does arithmetic on small in-memory sets of page IDs. A browser
opens only when you ask about a specific page.

Other edits work the same way:

- Change the selector (`.card` → `.card, .tile`): `+41 pages` — the pages the
  rule starts reaching. Deleting the rule shows `−312 pages`.
- Type a selector the site has never used: `Up to 340 pages` appears at once,
  and turns into the exact `212 pages` a moment later.
- Reformat or add a comment: `no effective change`.

## 2. Speed budget — the rule everything else follows

| Level | Answers | Allowed while answering | Never | Target |
|---|---|---|---|---|
| **L0** count | "How many pages?" | Parsing the edited rule; lookups and set operations on in-memory bitmaps | Reading page data from disk, network calls, browsers | First answer ≤ 100 ms after a keystroke (warm index) |
| **L1** list | "Which pages?" | Reading cached sets; matching a new selector against compact saved page trees in worker threads | Browsers | First results ≤ 250 ms; large uncached queries stream with progress |
| **L2** page detail | "What changes on this page?" | One headless browser tab per requested page | Rendering pages nobody asked for | Seconds, on request |
| **L3** live check | "Does the real page agree?" | A full live page load | — | Seconds, on request |

**The rule:** anything that needs work *per page* while the user types
belongs either in capture (background) or in L2/L3 (on request) — never in
L0/L1. Every section below follows it. The targets are design goals, not
measured prototype numbers.

## 3. Glossary

| Term | Meaning |
|---|---|
| **Page** | One URL of the monitored site. Counts are always in pages. |
| **Profile** | A viewport/device setting used for capture, e.g. `desktop`, `mobile`. |
| **Recipe** | Optional scripted steps that put a page into a state (open a menu, log in). |
| **Capture state** | One page under one profile and recipe — the unit that is captured and stored. A page can have several. |
| **Capture** | Loading a page in headless Chromium, in the background, and storing what the tool needs (§5). |
| **Index revision** | An immutable snapshot of all captured data. Deploys and content changes produce new ones (§9). |
| **Overlay** | Your edited CSS, applied on top of an index revision without changing it. |
| **Edit revision** | A counter that goes up on every relevant edit, in any file. Every answer names its index and edit revision, so numbers from different moments are never mixed. |
| **Site selector** | A selector that appears in the site's deployed CSS. Its matches are computed during capture. |
| **Relaxed selector** | A selector with its interaction-state parts removed, so it can be checked against a snapshot (§6.3). |
| **Bitmap** | A compressed set of page IDs (roaring bitmap). Count, union and intersection take microseconds. |
| **Match** | The selector selects at least one element of the page, in at least one captured state. |
| **Exact / possible / unknown** | The three parts of every count: pages proven to match, pages not ruled out yet, pages without usable data (§8). |

## 4. Why page counts can be both instant and sound

**A CSS rule can only affect a page if its selector matches something on that
page.** Pages are separate documents. Inheritance and layout spread a change
to other elements *of the same page*, never to another page. So for an
ordinary rule R:

> pages affected by editing R ⊆ (pages linking R's stylesheet) ∩ (pages
> where R's old selector matches ∪ pages where its new selector matches)

The right-hand side is two or three bitmap operations — as long as the
selectors' matches are already known. They usually are: during capture,
Chromium evaluates every selector of the site's CSS on every page (§5.3).
Most edits change declarations (`padding`, `color`), not selectors, so the
answer is a cache hit.

Three refinements complete the picture:

1. **Global definitions** — `@font-face`, `@keyframes`, custom properties,
   `@layer` order and similar — reach pages through the rules that use them.
   Their page sets are precomputed as well (§6.2).
2. **Interaction states** such as `:hover` are absent from a snapshot, so
   those parts are removed before matching (§6.3). Removing a condition can
   only add pages, never lose one.
3. **Matching is not changing.** A matched rule can be overridden by a more
   specific one. L2 answers that by measuring; L0 doesn't guess.

So a count means: **the pages this change can reach, in the captured
states.** A page outside the set is guaranteed unaffected in those states; a
page inside it *may* change, and L2 tells whether it does. States that were
never captured — for example a class that JavaScript adds after a click — are
flagged rather than assumed safe (§6.4).

## 5. Capture: the "hibernated" pages (background)

Keeping thousands of live browser tabs is not affordable. Instead, every
capture state is loaded once, measured, and stored as layers in RAM and on
disk. A browser is needed again only for L2/L3.

### 5.1 What gets captured

- Every monitored page, for each **profile** (default: desktop and mobile).
- In a **pristine** state — nothing clicked or dismissed. Dismissing the
  cookie banner first would make `.cookie-banner` look unused.
- Plus optional **recipes** for states that matter (menu open, modal open,
  logged in). A state that was never captured is invisible to the tool and is
  reported as such, never assumed safe.
- Under a fixed **capture policy** — what to wait for, clock, animations,
  scroll position — so results are repeatable.

### 5.2 What is stored per capture state

| Layer | Contents | Kept in | Used by |
|---|---|---|---|
| **L0 index** | Page bitmaps per site selector, per token (tag, class, id, attribute), per stylesheet and per global name (font, keyframes, custom property…) | RAM | Counts while typing |
| **L1 tree** | Compact element tree: tags, ids, classes, attributes with values, parent/sibling order, plus facts selectors depend on (document mode, language, direction, emptiness) | Disk, memory-mapped; small RAM cache | Page lists; matching new selectors |
| **L2 shell** | The rendered DOM serialized without scripts, stylesheets in order, form and canvas state, references to deduplicated assets (fonts, images) | Disk + shared asset store | Browser comparison of one page |
| **L3 recipe** | URL, profile, recipe steps, credential reference | Metadata | Live check |

- **L1 is not an approximation.** It keeps everything selector matching
  needs. When a needed fact is missing, matching answers *unknown*, never
  *no match*.
- **L2 keeps rendering inputs, not just a picture:** original attributes,
  text, intrinsic image sizes, fonts, stylesheet order and content. Page
  scripts never run when a shell is replayed; only the tool's own
  state-restore code does.
- Shadow roots, iframes and anything else that cannot be replayed faithfully
  are marked *partial* (L2) or *live-only* (L3).
- Chromium cannot freeze a live tab to disk cheaply; these layers *are* the
  hibernation.

### 5.3 The capture pipeline

The page is loaded anyway, so all the expensive work happens then:

1. **Load** the page with Playwright/Chromium under the capture policy and
   run its recipe, if any. Record timeouts and missing resources explicitly.
2. **Evaluate every site selector natively.** One `page.evaluate` call runs
   `document.querySelector(s) !== null` for each relaxed selector (§6.3) of
   every stylesheet the page links: ≈ 5,000 selectors × 10–50 µs ≈
   0.05–0.25 s per page. This is Chromium's own selector engine, so `:has()`,
   `:nth-child(… of S)`, `:dir()`, namespaces and quirks-mode case rules come
   for free, with no extra page load.
3. **Extract** the L1 tree and the L2 shell from the same loaded page; store
   assets by content hash.
4. **Record dependencies:** linked stylesheets in order; `var()`, font and
   animation names used in inline `style` attributes; and class names that
   scripts added during load or recipe steps, collected by a
   `MutationObserver` installed before page scripts run (used in §6.4).
5. **Cross-check the L1 matcher** (§6.5) against the native results of step
   2. A missed match would break soundness, so on every page it re-checks
   the selectors Chromium matched — cheap (≈ tens of ms), since matching
   stops at the first hit. Extra matches only cost precision and are checked
   on a sample. Any disagreement marks that selector feature *unsupported*
   in L1, which then answers *possible* instead of a wrong *no*.
6. **Check replay fidelity:** replay the L2 shell and compare it with the
   live capture (layout boxes, screenshot). Record limitations.
7. **Publish:** build the new revision's L0 bitmaps, then switch atomically.
   Queries already running keep their revision.

A failed capture stays in the inventory as *unknown*; it never silently
disappears from counts.

### 5.4 Templates are never a correctness unit

- **Every page gets its own verdict.** Bitmaps contain pages that were each
  evaluated — never "the template matched, so all its pages did".
- **Match results** may be shared between two capture states only when their
  L1 trees and selector-relevant facts are identical (same hash) — typically
  a page's desktop and mobile captures.
- **Render results** may be shared only when, additionally, stylesheets,
  assets, profile and browser version are identical.
- Templates and URL groups are fine for *display* and *scheduling*, never for
  skipping a page.
- Storage starts simple: compressed whole snapshots plus content-addressed
  assets. Subtree (Merkle) deduplication and novelty-first scheduling are
  later optimizations, only if measurements justify them.

## 6. Live query: from keystroke to answer

### 6.1 Every keystroke

1. VS Code sends only the **changed ranges** of the document to the local
   daemon (incremental sync, as in LSP).
2. The daemon **re-parses only the edited rule block** with an
   error-tolerant, spec-compliant CSS parser and compares it with the same
   rule in the diff base (§7.2). Formatting and comments compare equal.
3. It bumps the **edit revision**, classifies the change (§6.2) and answers
   from the L0 bitmaps.
4. The extension shows the number immediately (§7.1). A short debounce
   (≈ 30–50 ms) merges bursts of typing; it is part of the 100 ms budget,
   not added to it.

While a rule doesn't parse (a half-typed `.card >`), the last valid count
stays visible, marked *editing*. If it is still invalid on save, it is
reported for what it is: browsers drop the whole rule, so it counts as a
deletion.

### 6.2 L0: the count, by kind of edit

Every row is intersected with the pages that link the edited stylesheet.

| Edit | Pages counted | Precision |
|---|---|---|
| Declarations only (`padding: 16px → 24px`) | The rule's selector bitmap | Exact — cache hit |
| Formatting or comments only | None: `no effective change` | Exact |
| Selector changed — including a nesting parent or an `@scope` boundary, which changes the selector of every rule inside | Old ∪ new selector bitmaps, shown as `+gained / −lost` | Exact once the new selector is known (§6.5) |
| Rule added | New selector bitmap | Same as above |
| Rule deleted | Old selector bitmap, shown as losses | Exact |
| Rules reordered | Union of the moved rules' bitmaps | Exact |
| `@media`, `@supports` or `@container` condition changed | Union of the bitmaps of the rules inside | Exact |
| Custom property (`--brand: …`) | Pages matching the declaring rule ∩ pages using `--brand` — directly or through other variables, in rules, keyframes, inline styles or `@container style()` | Exact for `:root` variables; otherwise an upper bound that L1 refines |
| Named definition (`@font-face`, `@keyframes`, `@counter-style`, `@property`, `@position-try`, container names) | Pages where a rule or inline style uses that name | Exact (precomputed) |
| `@layer` order, `@import`, `@namespace` | Union of the bitmaps of every rule whose priority or meaning changes | Exact |
| Anything not recognized | All pages linking the stylesheet | Upper bound, with a reason |

**New selectors** are not cached yet. L0 answers instantly with a token-based
upper bound: `.card > a[href]` can only match pages that contain class
`card`, tag `a` and attribute `href`, so the count is the intersection of
those three token bitmaps — `Up to 340 pages`. A background L1 job (§6.5)
then computes the exact set, typically within a few hundred milliseconds,
and the display changes to `212 pages`. The next keystroke cancels the job.

**Opening a file pre-warms it.** When a stylesheet is opened, the daemon
computes L1 matches in the background for those of its selectors that are not
cached yet (for example rules that were never deployed). Usually every
selector of the open file is cached before the first keystroke.

**Conditions are shown, not evaluated.** `@media`, `@supports` and
`@container` decide *when* a rule applies, not which pages it can reach. The
count ignores them and lists them next to the number
(`312 pages · max-width: 600px`). L2 evaluates them for the captured
profiles.

### 6.3 Selectors a snapshot can't evaluate: relax, never negate

Some selector parts depend on things a snapshot doesn't have: `:hover`,
`:focus`, `:active`, `:checked`, `:visited`, `:target`, `:open`,
`:popover-open`, `:valid`, `:placeholder-shown`, `:defined`, `:state()`,
media playback states, and so on. Evaluated on a snapshot, they would produce
a wrong **zero** — nothing is hovered in a snapshot.

So each selector gets a **relaxed** form, built with one rule:

> **Drop the part that can't be evaluated. If it sits inside `:not()`, or
> inside anything that counts its argument such as `:nth-child(… of S)`, drop
> that whole construct.**

Removing a condition can only make a selector match *more* elements, so the
relaxed selector may over-count but never misses a page. Treating the part as
"true" instead would be wrong inside `:not()`: `.card:not(:hover)` would turn
into `.card:not(*)`, match nothing, and exclude every page.

| Original | Relaxed | Why |
|---|---|---|
| `.btn:hover` | `.btn` | Interaction state dropped |
| `.card:not(:hover) .title` | `.card .title` | The whole `:not()` goes |
| `.menu:has(a:focus)` | `.menu:has(a)` | `:has()`, `:is()` and `:where()` keep their relaxed argument |
| `li:nth-child(2 of .item:hover)` | `li` | Counting construct dropped whole |
| `.card::before` | `.card` | A pseudo-element counts as its originating element |
| `:hover` | `*` | Nothing left, so anything matches |

If nothing was dropped, the result is exact. If something was, the count is
still the honest answer to "where can this rule apply?", and the UI names the
condition (`312 pages · on :hover`). Selector syntax the parser doesn't know
is treated as `*`: all pages linking the stylesheet, as an upper bound with a
reason.

### 6.4 Zero is a claim — always explain it

`0 pages` is the most dangerous number the tool can show, because it invites
deleting CSS. A zero appears only when it is proven within the captured
scope, and always with its reason:

- `no-effective-change` — only formatting or comments changed;
- `selector-never-matches` — evaluated on every captured page;
- `stylesheet-not-linked` — no captured page loads this file.

The common trap is **state added by JavaScript.** `.dropdown.is-open` matches
nothing in a pristine capture, because `is-open` appears only after a click.
L0 detects this for free: `is-open` never occurs in the token dictionary of
any captured page (or occurs only among the script-added classes recorded in
§5.3). It shows `0 captured pages · .is-open never seen (added by JS?) · up
to 120 pages without it` — the second number is the selector relaxed further
by dropping the never-seen tokens.

Stale data, failed captures, unsupported syntax, a pending CSS build or an
unmapped stylesheet never produce a zero. They produce *possible* or
*unknown* pages, with a reason (§8).

### 6.5 L1: the page list

- **Cached selector** (the usual case): the bitmap *is* the list. Page IDs
  become URLs, paginated and grouped by URL prefix or template for
  readability. Grouping is for display only.
- **New selector:** start from the L0 upper bound, then match the compact L1
  trees of those candidate pages in worker threads. Matching runs right to
  left, as browsers do, and stops at the first matching element per page.
  Results stream in, and the count ticks from `Up to 340` to the exact
  number.
  - ≈ 2,000 candidate pages × 50–200 µs ≈ 0.1–0.4 s on one core, ≈ 50 ms on
    8 workers. To be benchmarked.
  - Start with an existing JS selector engine over the compact tree (e.g.
    `css-select` with a custom adapter); move to a native one (e.g. Servo's
    `selectors` crate via napi) only if measurements demand it.
- **The matcher is checked against Chromium** during capture (§5.3, step 5).
  A selector feature that ever disagrees is marked unsupported, and queries
  using it return *possible* pages instead of a wrong *no*. The fast matcher
  therefore never silently excludes a page Chromium would match.
- **Element detail on demand:** for one page, the matching elements — and,
  optionally, how many descendants inherit from them. Computed only when the
  user expands that page.
- Results are cached, within a size limit, by relaxed selector and index
  revision, so asking again is instant.

### 6.6 L2: what actually changes on one page

Only on explicit request, for the pages the user picked:

1. Load the page's L2 shell into a pooled headless Chromium tab — scripts
   off, network limited to the asset store.
2. Set the mapped stylesheet (§7.3) to the **base** CSS with CDP
   `CSS.setStyleSheetText`, settle animations under the capture policy and
   **measure** with `DOMSnapshot.captureSnapshot`: computed values for the
   edited properties (expanded to longhands, plus properties that use edited
   custom properties) and every element's layout box.
3. Set the **edited** CSS in the same tab, settle, and measure again.
4. **Diff:** changed elements with `old → new` values; elements that moved or
   resized, including ones the rule never matched but layout pushed; and, if
   requested, before/after screenshots (`Page.captureScreenshot`) with a pixel
   diff.
5. Stream the results to the panel and return the tab to the pool.

Measuring both versions in the same tab means there are no stored baselines
to invalidate, and both sides share the same fonts, images and timing. It
also resolves "matches but doesn't change": the rule may be overridden on
this page, and L2 says so.

A failed or unfaithful replay is *inconclusive*, never "no change".
`:hover` and `:focus` variants can later be measured with
`CSS.forcePseudoState`. (A `MutationObserver` cannot detect any of this: CSS
changes don't mutate the DOM.) Rendering the whole site is never a side
effect of editing; it is an explicit batch job, e.g. in CI.

**Assess impact** is the one batch the panel offers: a button above the page
list runs this step (no screenshots, every device) on each listed page, in
the background, at most three at a time and always behind diff-viewer
requests. Meanwhile the list stays usable but dimmed and the button shows
progress. Once done, `analysis/getPages` ranks the list: pages that look
different first (most changed elements, then most moved), then inconclusive,
then not yet assessed, then unchanged; the panel shades rows deeper blue for
more changed elements. Results belong to one index revision, edit
revision and set of picked edits: the next edit stops the job and drops
them; the last 8 sets of picked edits keep theirs, so picking back is free.

**Picked edits.** The panel lets the developer pick some of their edits
(`session/setSelection`); the page list, Assess impact and the diff viewer
then apply only those, so each edit's effect can be seen on its own. Edits
have ids that stay the same while typing (a hash of the rule they change).
To apply a subset, the server diffs the base and edited text line by line
(lines tagged with their innermost rule, so look-alike lines in different
rules don't pair up), keeps the hunks owned by the picked edits and
checks the result: its rules must equal the base's, minus the picked
removals, plus the picked additions, in the right order, with the right
`@import`/`@layer`/`@namespace` statements. Statements outside rules go with
those file-level edits. A hunk that mixes picked and unpicked edits on the
same lines brings the others along (so does a new `@layer x { }` block and
the layer order it changes), and the viewer says so;
if the check fails, every edit is shown, with a warning. Nothing picked
gives an empty list and an empty diff.

### 6.7 L3: the live page

Load the real URL (production, staging or a local dev server), run the
recipe, apply the base and edited CSS, and compare as in L2. This catches
what shells cannot: scripts reacting to layout, lazy-loaded content, logged-in
views. Record the deployment and content version seen; if the live site has
changed since capture, say so.

### 6.8 Never mix moments

Every answer carries its `indexRevision` and `editRevision`. A page list,
page detail or refined count always belongs to the same pair as the count it
expands; anything computed for an older pair is discarded when a newer edit
arrives. This is a cheap version check, not extra work.

## 7. What the developer sees (VS Code)

### 7.1 Surfaces, chosen for speed

VS Code waits at least 250 ms after a change before asking CodeLens providers
again (its `codelensController` debounces with `min: 250`), so CodeLens alone
cannot meet the L0 budget. Decorations and the status bar update immediately.

| Surface | Shows | Why |
|---|---|---|
| Count next to the cursor, on the line being edited | `312 pages`, `+5 / −2 pages`, `Up to 340 pages`; with other edits in the file, this edit first, then all of them: `2 pages, 56 total (6 edits)` | Updates at once (`setDecorations`), before saving: the L0 surface |
| Status bar item | `Your edits: 340 pages`, or `Link page groups` when none are linked; click opens the panel | Always visible, updates at once |
| Hover | The full answer: exact/possible/unknown, conditions, reasons, index age, page links | On demand |
| Page panel (Alt+B, or click the count) | L1 list grouped by linked page group; each page opens the diff. Edit chips (All edits → file → edit) pick which edits the list, Assess impact and the diff apply. **Assess impact** ranks it by visual change (§6.6) | On demand |
| Diff tab (webview embedding the server's `/diff` page; also opens in a browser) | L2: the whole page, before/after on one canvas, changed zones outlined; Space flips, N jumps to the next change; `Check on the live page` (L3) | On demand; refreshes itself as you keep typing |
| Outside-editor notice | "CSS changed outside the editor: 12 → 40 pages" after a pull, branch switch or another tool | Edits that never went through the editor |
| CodeLens above each rule (off by default) | The settled count, e.g. `312 pages · show` | Fine once typing pauses |
| Problems | Only important negatives: a rule removed from many pages, a rule that is still invalid on save, a stale or missing index | Avoids noise |

How numbers read:

- `312 pages` — exact.
- `312 pages (+14 possible)` — exact, plus pages not resolved yet.
- `Up to 340 pages` — upper bound while a new selector is being resolved.
- `+5 / −2 pages` — a selector change: pages the rule starts / stops
  reaching. The hover shows the full union.
- `0 pages · selector never matches` — a proven zero, always with its reason.
- `· stale` — the index is older than the markup in your workspace or in
  production.

### 7.2 "This rule" versus "my edits"

- **Per rule** (decoration, CodeLens): *how many pages does this rule reach?*
  That is just its selector's bitmap. It doesn't depend on history and is
  useful before editing anything.
- **Session total** (status bar): *how many pages can my edits reach?* The
  union over every changed rule, in every file, compared with a **diff
  base**. The panel shows the bases as tabs, broadest first (All = production,
  Uncommitted = `HEAD`, This session = session start, Unsaved = last save);
  one base is active per project session, and it drives the cursor count, the
  status bar, the list and the visual diff. A window opens on
  `cssBlastRadius.diffBase` (default `HEAD`; `session` without git) and keeps
  its tab across reconnects:
  - production — **the live site as last scanned**: "what would
    deploying this reach?" Needs no git. In a git repository, only **the
    branch's own changes** count: each file is diffed against its version
    where the branch left the deployed branch (`merge-base HEAD origin/main`;
    `origin/HEAD`'s target when set, else `main`/`master`), and changes the
    live copy already has (e.g. squash-merged earlier) are dropped. Newer
    commits of the deployed branch that the branch lacks are therefore not
    "my edits"; the panel and hover say how many there are
    ("main has 7 newer commits not in your branch"). The visual diff swaps in
    the live copy before and the live copy with the branch's changes merged
    in after (`git merge-file`, as a merge would); if the same lines changed
    on both sides it compares the branch's own versions and warns. The
    branch point is re-read on commits, checkouts and fetches.
    `setDiffBase {mainChanges: true}` (the panel's "Show main's N newer
    commits" box, offered when `behind > 0`) compares with the live copy
    as is instead, so the deployed branch's newer changes count as undone;
    `SessionTotal.branch.mainShown` says which;
  - `HEAD` — your uncommitted changes (saved or not);
  - session start — a snapshot of the CSS on disk, taken when the session
    is created and again when a new editor window (`initialize {windowId}`)
    is the only one attached: a reload starts over, a second window doesn't,
    nor does a reconnect of any window attached since the start
    (`InitializeResult.sessionStarted`). The window then
    reopens its files with `document/open {atStart: true}`, so unsaved text
    it restores counts as the start;
  - last save — unsaved typing only.
- **Scope:** counts cover only the pages of the page groups linked to the
  project (§10.5) that are active. Nothing linked means `0` with reason
  `no-linked-groups`, and the status bar asks to link groups.

### 7.3 Repository files versus deployed stylesheets

The index knows stylesheets by their deployed URL (`/assets/app.3f2a1c.css`);
the developer edits `src/styles/card.css`. The daemon links the two using, in
order of preference:

1. source maps of the deployed CSS, which list the original files;
2. a build manifest (e.g. Vite or webpack `manifest.json`);
3. configured path patterns;
4. **file names** (implemented first): hashes, version numbers and `.min`
   are ignored, so `src/css/main.css` matches `/assets/main.3f9a2c.min.css`;
   ties are broken by matching folder names. The setup page lists every
   site stylesheet with the project file it matched;
5. content hashes, for plain unbundled CSS.

When the file is bundled, L2 builds the "base" and "edited" versions of the
deployed stylesheet by splicing the file's part through the source map, or by
running the build adapter (§7.4). If the base version of the file differs
from what the index captured, the UI says so. An unmapped file still gets
counts — over all captured pages instead of only the pages that link it —
marked as an upper bound with reason `stylesheet-not-mapped`.

### 7.4 Compiled CSS (Sass, Tailwind, CSS Modules…)

Browsers see compiled output, so a build adapter compiles the edited source
and maps output rules back to it through source maps.

- Builds run asynchronously. Until the output for the current edit exists, L0
  shows an upper bound — all pages linking the output file, or fewer when the
  previous build's source map narrows it — marked `waiting for build`. It
  never presents the old output as current.
- Plain CSS needs no adapter and ships first. A pipeline without an adapter
  is reported as unavailable for its files, not approximated.
- CSS Modules: the captured DOM contains the hashed class names; the source
  map links them to the authored ones. Tailwind: utilities are ordinary site
  selectors, and a config change is handled by diffing the regenerated
  output.

## 8. Answer contract: what every number means

Each count has three disjoint parts, so the UI can be honest without being
vague:

| Part | Meaning | Shown as |
|---|---|---|
| `exact` | Pages proven to match, in the captured states | `312 pages` |
| `possible` | Pages not ruled out yet: new selector still resolving, unsupported feature, never-seen token, unmapped file | `(+14 possible)`, or `Up to …` while `exact` is still unknown |
| `unknown` | Pages without usable data: capture failed, page added since the last capture | `· 3 unknown` |

The true count lies between `exact` and `exact + possible`; `unknown` pages
are outside the tool's current coverage. L2/L3 add a fourth number:

| Part | Meaning | Shown as |
|---|---|---|
| `changed` | Inspected pages where a measured style, layout or pixel difference was found, plus inspected/pending/failed counts | `4 of 5 inspected pages changed` |

Rules:

1. **Pages, not states.** A page counts once even if it matches on desktop
   and on mobile. State counts are available separately.
2. **Zero needs proof.** `0` is shown only when `exact`, `possible` and
   `unknown` are all zero, the answer is complete, the index is fresh, and a
   reason code says why. This is a tested invariant.
3. **Losing a rule is not visible damage.** Pages of a deleted rule are
   "pages that lose this rule"; whether anything looks different (another rule
   may supply the same value) is an L2 question.
4. **Conditions stay visible:** `@media`/`@container` conditions and dropped
   interaction states are listed next to the count.
5. **Matching is not changing.** `exact` means the rule reaches the page;
   only `changed` (L2/L3) means something measurably changed. The `level` of
   an answer is the deepest work done for it — L2 on five pages says nothing
   about the other 307.

An L0 answer, abridged:

```json
{
  "queryId": "q-1842",
  "level": 0,
  "indexRevision": "rev-1042",
  "editRevision": 57,
  "rule": { "file": "src/styles/card.css", "line": 12, "selector": ".card:hover" },
  "pages": { "exact": 312, "possible": 0, "unknown": 3, "complete": true },
  "gained": null,
  "lost": null,
  "conditions": [":hover dropped (interaction state)"],
  "reasons": ["capture-failed:3"],
  "basis": "LOCAL_INDEX",
  "freshness": { "capturedAt": "…", "stale": false }
}
```

`basis` is one of `LOCAL_INDEX | SHARED_INDEX | LOCAL_RENDER |
SHARED_RENDER | LIVE_LOAD`. The hover and panel also show coverage: page
inventory, profiles, recipes and known limitations.

## 9. Keeping up with production

The index has to follow the real site, including CMS content that changes
without a deploy.

### 9.1 Triggers

- **Post-deploy CI step or deploy webhook** — sends the deployment ID, commit
  and changed paths (§9.4).
- **CMS publish webhook** — sends the changed pages or content IDs.
- **Scheduled low-rate sweep** — catches anything not signalled, such as
  third-party content.

### 9.2 What to recapture

| Change | Action |
|---|---|
| CSS only | No page loads are needed for L0/L1: evaluate the new site selectors on the stored L1 trees (in Chromium on stored shells for features the L1 matcher doesn't support) and rebuild the dependency sets. Point L2 shells at the new stylesheets. Then recapture the affected pages in the background, because scripts can react to CSS (`ResizeObserver`, `matchMedia`). |
| Templates, components, content | Recapture every affected page. If the affected set is unknown, widen it; never let one unchanged page vouch for others. |
| JS, assets, anything unknown | Recapture the pages that load them. HTML hashes and ETags are hints, not proof. |

Compare the L1 tree, the L2 shell and the asset hashes **separately**: a
text edit can leave L1 identical (counts unaffected) while changing L2
(layout); an image can change with no DOM change at all. Rebuild only what
changed. New URLs are discovered (sitemap, crawl, CMS), removed ones leave the
inventory, and failed recaptures stay visible as *unknown*.

### 9.3 Revisions

- Each sync produces an immutable **index revision**, labelled with
  deployment ID, commit, content revision and capture settings. A CMS update
  under the same commit is still a new revision.
- The new revision, including its L0 bitmaps, is built next to the current
  one and then published atomically. Queries keep the revision they started
  with.
- Unchanged snapshots and assets are shared between revisions. Old revisions
  are kept while in use, then garbage-collected.
- A capture during a rolling deploy can see mixed versions. Detect it (version
  headers, asset hashes), then retry or mark those pages *unknown*.
- Daemons receive `index/revisionSwitched` and download only the changed L0
  data (§10.3).

### 9.4 The CI job (sketch)

```yaml
# After a successful production deploy
- name: Notify CSS Blast Radius
  run: |
    curl -fsS -X POST "$CBR_URL/api/deployments" \
      -H "Authorization: Bearer $CBR_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"deploymentId\":\"$DEPLOY_ID\",\"commit\":\"$GITHUB_SHA\",\"siteUrl\":\"$SITE_URL\",\"changedPaths\":$CHANGED_PATHS_JSON}"
```

The service classifies the changed paths (§9.2), recaptures the chosen
pages, publishes the revision and notifies daemons.

**Bonus, later: PR checks.** Most of a PR check needs no preview deployment:
the PR's CSS diff against the production index gives the counts (L0/L1), and
L2 renders stored shells with the PR's CSS for before/after images. Post a
check such as "this PR reaches 37 pages; 12 inspected pages changed". Only
PRs that also change markup or scripts need a capture of their preview
deployment.

## 10. Deployment topology

### 10.1 The extension is always a thin client

The VS Code extension never crawls, stores indexes, runs browsers or parses
CSS for analysis. It forwards document events, shows results and manages the
daemon. Everything else lives in one backend engine with two roles:

- **Local daemon** (always present): the editor protocol, unsaved edits,
  file watching, the in-memory L0 index, L1 matching, and optionally local
  capture and L2 tabs. It is implemented as the **local server** (§10.5): one
  per site, shared by every project and VS Code window on the machine, with
  one analysis session per project.
- **Index service** (optional, shared): canonical captures and revisions for a
  team, deploy-triggered recapture, L2/L3 jobs at scale.

```
VS Code extension ──JSON-RPC over /rpc──▶ local server ──HTTPS + push──▶ index service (optional)
browser (setup page, diff viewer) ──REST + SSE──▶ local server
```

The extension only ever talks to the local daemon. It has one protocol in
every mode, unsaved edits stay on the machine, and L0 never waits for the
network.

### 10.2 Modes

| Mode | Who captures | Good for |
|---|---|---|
| Local only | The local daemon | Solo use, small sites, offline or locked-down environments |
| Shared team | A shared index service; daemons replicate its hot data | Large sites, where capture should be paid once per team |
| Hosted, single-tenant | As shared, behind organization auth on the Internet | Teams without their own infrastructure — not a multi-tenant SaaS in v1 |

Rejected: extension → remote service directly. It would send unsaved edits
over the network, put auth and browser concerns into the extension, and make
L0 depend on network latency.

### 10.3 Shared mode without slowing L0

- On attach, the daemon downloads the revision's **L0 data** (bitmaps, token
  dictionary, dependency sets) — ≈ tens of MB for 10,000 pages — and from then
  on only deltas, on `index/revisionSwitched`.
- **L1 trees** are fetched on demand and cached; trees of pages that link the
  open stylesheets can be prefetched.
- **L2** runs in local tabs on downloaded shells, or as a job on the service.
- **Edits stay on the machine.** Only an explicitly requested L2/L3 job on the
  service receives the edited CSS — never the worktree.
- **Base revision:** the one the developer selected, else the latest
  production revision compatible with the repository (same site, profiles and
  capture policy). Revision, age and freshness are always visible.
- **Concurrency:** revisions are immutable once ready, so any number of
  developers can query one. Service-side render jobs are deduplicated by
  revision, capture state, CSS content hashes and browser environment;
  cancelling only removes one developer's interest in a job.
- **Auth:** the daemon holds an organization credential (bearer token, mTLS…);
  authorization is per repository; repository identity is explicit
  (configured ID or VCS origin), never guessed from paths.

### 10.4 Daemon lifecycle and packaging

- The extension connects to the local server at `cssBlastRadius.server`
  (default `http://127.0.0.1:4317`) and starts it when the connection is
  refused. The server outlives VS Code and is never shut down by the
  extension, because other windows share it. `server/health` is cheap. If the
  connection drops, the extension reconnects with backoff, re-sends its open
  documents and marks results stale meanwhile.
- Browser problems block capture and L2/L3 only; L0/L1 on a ready index keep
  working. One "degraded" status, not a flood of errors.
- Shipped as a Marketplace extension (thin client) plus a backend package or
  binary (daemon or service). Chromium/Playwright belong to the backend,
  never to the extension.
- The extension manages only the local daemon; admins run the shared service
  (container, systemd, Kubernetes…).

### 10.5 The local server: setup page and page groups

`css-blast-radius serve` runs one HTTP port per site (default 4317):

| Path | Who uses it | What |
|---|---|---|
| `/` | Browser | **Setup page**: site address (live URL or local folder), devices, page groups, scan progress, stylesheet matches, connected projects |
| `/api/…`, `/api/events` | Setup page, diff viewer | REST plus Server-Sent Events (`state`, throttled to ~4/s during scans; `edit` when a project's edits change) |
| `/diff?s=…&url=…` | Diff tab in VS Code, or a browser | L2/L3 before/after viewer for one page |
| `/rpc` (HTTP upgrade) | VS Code extension | JSON-RPC (§11) |

**Page groups** are what a developer watches: named lists of pages from a
sitemap (with an optional filter such as `/blog/*`), a CSV file or pasted
addresses. A group can be:

- **paused**: not counted and not rescanned, to save resources when nobody
  works on that part of the site; resuming queues its never-scanned pages;
- **rescanned**: sitemap groups re-read the sitemap first, so new pages join
  and removed pages leave; excluded pages stay out;
- **deleted**: soft delete, undoable for 5 minutes.

A page can be in several groups; it is scanned once. Scans run in one serial,
deduplicated queue. They are partial (only the requested pages, the rest
carried forward) unless the site or devices changed, or the user asks for
**Rescan all**, which also drops pages no longer in any active group. Each
scan publishes a new index revision (§9.3), and every project session
switches to it without interrupting counts.

**Linked groups.** Each project lists the group IDs it works on in
`.vscode/settings.json` (`cssBlastRadius.groups`), so the choice is shared
with the team. The extension asks on first open. Counts cover only pages of
linked, active groups (§7.2). Pausing, renaming or deleting a group reaches
every connected editor at once (`groups/changed`).

## 11. Protocol

Versioned **JSON-RPC 2.0**, one JSON message per line. Locally over the
server's `/rpc` HTTP upgrade (§10.5), which accepts only loopback requests
without a browser `Origin`; the CLI daemon also serves it over a Unix domain
socket (mode 0600). Daemon → service: HTTPS for requests and a WebSocket for
notifications, with the same vocabulary.

**Handshake.** `initialize` returns protocol major/minor, service and schema
versions, capabilities (available levels, index readiness), mode
(`local | shared`), repository identity, base index revision and health
(`READY | DEGRADED | BLOCKED`). A major mismatch refuses loudly; a minor
mismatch falls back to the shared capabilities; incompatible storage is
migrated or refused, never read silently.

| Method | Level | Purpose |
|---|---|---|
| `initialize` | — | Bind the connection to a project (`workspaceRoot`) and its linked groups; returns `sessionId`, `serverUrl` and the groups |
| `groups/list`, `session/setGroups` | — | List page groups; change the linked groups. Counts cover only linked, active groups |
| `document/open`, `document/change`, `document/save`, `document/close` | — | Editor events. `change` carries incremental ranges (full text for small files) and returns the L0 answer |
| `analysis/queryImpacts` | 0 | Counts for a rule, a file or the session |
| `analysis/getPages` | 1 | Paginated page list, with progress; ranked by visual impact once assessed |
| `analysis/getChange` | — | One edit's whole rule for the panel's edit card: its declarations in file order, each marked part of the edit, unchanged or removed (with the old value), and the line and column to jump to (protocol minor 4) |
| `analysis/assess` | 2 | Check every page of a list visually in the background ("Assess impact"); progress via `analysis/assessProgress` |
| `analysis/getDrilldown` | 1–2 | One page: matching elements (L1); before/after measurements when requested (L2) |
| `analysis/openLive` | 3 | Live check of a capture state |
| `session/setDiffBase` | — | Production (the live site as last scanned), `HEAD`, last save or session start; `mainChanges` also counts the deployed branch's newer commits |
| `session/setSelection` | — | The edits picked in the panel (per file: all, or some change ids; `null`: every edit). Page lists without a path, Assess impact and the diff viewer follow it (§6.6) |
| `index/capture` | — | Rescan some pages, or the linked active groups |
| `index/getStatus`, `server/health` | — | Readiness, coverage, freshness |

**Notifications:** `analysis/publishImpact` (new answer), `analysis/refined`
(an answer became more precise, e.g. `Up to 340` → `212`),
`analysis/drilldownProgress` (streamed L2/L3 results),
`analysis/assessProgress` (Assess impact: pages done, finished or stopped by an edit),
`analysis/resultSuperseded`, `analysis/externalChange` (CSS changed on disk
outside the editor and moved the total; carries the total `before`, so the
notice reads "now 40 pages affected (was 12 pages)". The extension treats an
open file as reloaded only when it was clean before and after the change, so
undoing back to the saved text doesn't count), `groups/changed`,
`index/statusChanged`, `index/revisionSwitched`, `server/degraded`,
`server/restarting`.

Every request and notification carries `queryId`, `indexRevision` and
`editRevision` (§6.8). The page panel webview goes through the extension
host. The diff tab embeds the server's `/diff` page, which reads the
session's current edits from the server by `sessionId`; editor buffers are
never sent from the browser.

## 12. File watching and invalidation

Two sources report changes, with clear ownership:

- **Open files:** VS Code document events are authoritative. The daemon marks
  the path as editor-owned and ignores file-system events for it, unless the
  content hash differs (an external overwrite).
- **Closed files:** the daemon's file watcher is authoritative (branch
  switches, builds, generated files, synced changes).
- **On save:** `document/save` carries the content hash and version; the
  matching file-system event is dropped as a duplicate.

**Changes other than CSS.** If HTML, templates or scripts change in the
workspace, the captured DOM may no longer describe the developer's version.
Answers stay attributed to the captured revision and are marked `stale` until
a local or shared recapture; a CSS overlay cannot fake missing markup.
Changes that only affect L2 inputs (text, images, fonts) invalidate L2
results, not counts. Recapture always runs in the background — honest
staleness beats numbers that only look continuous.

## 13. Security and data sensitivity

- Captures of logged-in pages can contain personal data. Use dedicated test
  accounts. Their credentials live in an OS keychain or secret manager,
  referenced by `auth_ref` — never in the index.
- Shared snapshots contain site content, so access is scoped per repository,
  like the code.
- Shell replay runs with scripts disabled and network access limited to the
  asset store, so a replay never calls production APIs or analytics.
- L3 live loads hit real environments: prefer staging, rate-limit them and
  label them clearly.
- The local socket or pipe is user-only. Unsaved edits stay local unless an
  L2/L3 job is explicitly sent to the shared service.
- The local server binds to `127.0.0.1` by default and has no login yet. It
  rejects requests whose `Host` isn't loopback (DNS rebinding), writes that
  aren't same-origin JSON (CSRF), `/rpc` upgrades that carry a browser
  `Origin`, and request bodies over 32 MB. Binding it elsewhere prints a
  warning; hosting it for a team needs the organization auth of §10.3.

## 14. Sizing (estimates to benchmark)

For 10,000 pages × 2 profiles and ≈ 10,000 unique site selectors:

| Item | Estimate | Note |
|---|---|---|
| One selector bitmap | ≤ 2.5 KB raw (2 × 10,000 bits) | Roaring compression makes most far smaller |
| All selector bitmaps | ≤ 25 MB raw | Fits in RAM |
| Token and dependency bitmaps | ≈ tens of MB | Fits in RAM |
| Union, intersection, count | Microseconds | L0 cost ≈ parsing one rule + local IPC |
| L1 trees | ≈ 50–150 KB raw per state → ≈ 1–3 GB on disk | Memory-mapped; identical desktop/mobile trees stored once |
| L2 shells | ≈ 100–500 KB of HTML per state, plus shared assets | Disk |
| First full capture | ≈ 10,000 × 2 × 2.5 s ÷ 8 tabs ≈ 1.7 h | Background, once; later syncs are incremental |
| Resolving a new selector (L1) | ≈ 50 ms for 2,000 candidate pages on 8 workers | Streams when larger |

The worst case for L0 — a global edit that reaches every page — costs the
same as any other edit: one bitmap. Only explicit L2/L3 requests scale with
the number of pages inspected.

## 15. Data model

Storage-agnostic: SQLite plus a blob store locally, any durable store
remotely.

```
repo(id, vcs_origin, default_branch)
index_revision(id, repo_id, deployment_id, commit_sha, content_revision,
               profiles, recipes, capture_policy_hash, matcher_version,
               schema_version, built_at, status)
page(id, repo_id, url, first_seen_rev, last_seen_rev)          -- the counting unit
capture_state(id, index_revision_id, page_id, profile, recipe_id,
              l1_hash, l2_manifest_hash, status, captured_at, limitations)
recipe(id, name, steps, auth_ref)
blob(hash, kind[l1_tree|l2_shell|replay_state], storage_ref)  -- shared across revisions
asset(hash, mime, size, storage_ref)
capture_resource(capture_state_id, url, kind, hash, order_index, scope)

-- L0, loaded into RAM. "bitmaps" = one page-ID bitmap per profile/recipe.
token_posting(index_revision_id, kind[tag|class|id|attr|attr_value], token, bitmaps)
runtime_token(index_revision_id, token, bitmaps)              -- classes added by scripts (§5.3)
selector_match(index_revision_id, relaxed_selector_key, matcher_version,
               bitmaps, unknown_bitmap)
dependency_set(index_revision_id, kind[stylesheet|var|font|keyframes|counter_style|
               property|layer|container_name|position_try], name, bitmaps)
var_edge(index_revision_id, from_var, to_var)                 -- --a: var(--b)
stylesheet_map(repo_id, source_path, deployed_url,
               method[sourcemap|manifest|config|hash], base_hash)

-- Sessions and jobs (local daemon unless noted)
edit_session(id, repo_id, client_version, edit_revision, diff_base, started_at)
overlay_document(session_id, path, doc_version, content_hash, dirty, editor_owned)
render_job(id, index_revision_id, capture_state_id, base_css_hash,
           edited_css_hash, environment_hash, status, result_ref)  -- deduplicated when shared
matcher_check(matcher_version, feature, status[supported|unsupported], evidence_ref)
```

- **Counting:** each `bitmaps` value holds one page-ID bitmap per profile or
  recipe. A page counts once if any of its states matches; per-state counts
  come from the individual bitmaps.
- `selector_match` is keyed by the normalized relaxed selector, with nested
  CSS desugared (`&` → `:is(parent)`). Every rule with that selector shares
  one entry, and declaration edits never invalidate it.
- No render baselines are stored: L2 measures base and edited CSS in the same
  tab.

## 16. Implementation plan (from the current prototype)

The prototype already has the daemon, JSON-RPC over a local socket, the
editor lifecycle and the VS Code surfaces. It indexes a static fixture site
with jsdom and estimates the cascade heuristically. Each step ships something
usable and keeps L0/L1 independent of browsers.

**Status:** steps 1–5 are built. From step 6, the diff bases and file-name
stylesheet matching are built. Step 6a (the local server) is built. Build
adapters and steps 7–8 are not.

1. **Answer contract and timing.** `exact / possible / unknown` page counts,
   the zero rule, and `level`, `queryId`, `indexRevision` and `editRevision`
   on every message; latency measured from keystroke to decoration.
   *Gate:* contract tests pass; no zero without a reason code.
2. **Instant L0 on the fixture site.** Incremental `document/change`,
   single-rule reparsing and diffing, edit classification (§6.2), selector
   relaxation (§6.3), token and selector bitmaps (built by the existing jsdom
   indexer for now), end-of-line decoration and status-bar total.
   *Gate:* warm L0 ≤ 100 ms at p95, end to end; no disk, network or browser
   access on the path.
3. **Chromium capture.** Playwright capture of real copied pages under a
   capture policy; native evaluation of all relaxed site selectors (§5.3);
   compact L1 trees; L2 shells with deduplicated assets; replay checks;
   failed captures tracked. jsdom leaves the query path.
   *Gate:* replay checks pass on a sample of real copied pages, including
   pages that deviate from their template.
4. **Fast L1.** Page lists from bitmaps; compact-tree matcher in workers with
   streaming; background resolution of new selectors; pre-warming on file
   open; matcher cross-check against Chromium.
   *Gate:* first L1 response ≤ 250 ms at p95, warm; no disagreement with
   Chromium on supported features.
5. **L2 and L3 detail.** Browser pool; same-tab base/edited measurement over
   CDP; changed elements, moved boxes, optional screenshots; live check. The
   heuristic cascade (`cascade.ts`) stops feeding answers.
   *Gate:* overridden fixture edits report "matches, no change"; real changes
   are detected.
6. **Diff base, stylesheet mapping, build adapters.** `session/setDiffBase`;
   source-map, manifest, config and hash mapping; asynchronous adapters for
   Sass first, then Tailwind and CSS Modules.

   6a. **Local server and setup page** (§10.5). One port per site for the
   setup page, page groups (sitemap, CSV, pasted), linked groups per project,
   the scan queue, the diff viewer and the editor connection. The production
   diff base and file-name matching become the defaults, so a project needs
   no git or configuration. In the editor: the count next to the cursor, the
   page panel, the diff tab and the outside-editor notice.
   *Gate:* a project goes from an empty server to counts in VS Code using
   only the setup page and one "link groups" choice.
7. **Production sync and CI.** Deploy and CMS webhooks, the post-deploy CI
   job, targeted recapture, atomic publishing, page inventory with added,
   removed and failed pages.
   *Gate:* a sync never interrupts counts; text-only changes refresh L2
   without touching L1.
8. **Shared mode and scale.** Index service, L0 replication with deltas,
   on-demand L1/L2 fetches, auth. Benchmark warm and cold L0/L1 on thousands
   of real pages, including global edits and complex new selectors. Subtree
   deduplication, novelty-first scheduling or extra caching only where
   measurements call for them. PR checks are the follow-up bonus (§9.4).

**Gates that always apply:** no browser, disk or network access on warm L0;
L0/L1 targets measured end to end; the fast matcher never excludes a page
Chromium matches; failed or unknown work never shows as zero; no answer mixes
index or edit revisions.

## 17. Not in v1 (stated, never silently ignored)

- **Extension → remote service directly** — always via the local server.
- **Multi-tenant SaaS** — signup, billing, quotas, cross-tenant isolation.
  Hosted mode is single-tenant per organization.
- **Local markup changes on top of a shared index** — local HTML, template or
  JS changes mark answers `stale` until a recapture; they are not simulated.
- **Uncaptured states** — they exist only as recipes; otherwise they are
  flagged (`state-not-captured`, `token-never-seen`), never assumed
  unaffected.
- **Viewports other than the captured profiles** — counts ignore media
  conditions, so a rule inside `@media (max-width: 600px)` still counts its
  pages, but L2 measures only the captured profiles.
- **Interaction states in L2** — `:hover` and `:focus` are relaxed in L0/L1;
  L2 measures the captured state. Forcing states over CDP comes later.
- **Scripts in L2 shells** — static by design; L3 runs scripts.
- **Build pipelines without an adapter** — unavailable for their files until
  one exists.
- **Cross-origin stylesheets and iframes, stylesheets inside shadow roots** —
  flagged, not indexed.
- **PR preview checks** — the planned follow-up to the CI job.
- **Subtree (Merkle) storage and novelty-first scheduling** — later
  optimizations.
- **Team annotations or review workflows** — v1 shares index data only.
- **Editors other than VS Code** — the protocol is editor-neutral, but only
  the VS Code client ships in v1.

## Appendix: why this doesn't exist yet

- **Chrome DevTools CSS Overview and Coverage** — one page at a time.
- **Live CSS editors (VisBug, Magic CSS, …)** — instant feedback, but only for
  the page that is open.
- **Visual regression tools (Percy, Chromatic, BackstopJS)** — many pages,
  but in CI after a commit, with no count while typing.

None combine a precomputed cross-page index, instant and sound exclusion
while editing, on-demand browser checks of only the pages you ask about, a
thin IDE client, and numbers that say exactly what they mean.
