// Black-box check of the compiled VS Code extension (stubbed vscode API) against
// a real server. Builds a 3-page site and a project in a temp folder, starts the
// server from packages/backend/dist on a free port, sets it up over REST, runs the
// checks, then removes everything. Needs `npm run build` and Chromium installed.
// Usage: node scripts/e2e.cjs
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

const extRoot = path.resolve(__dirname, "..");
const backendDist = path.resolve(extRoot, "../backend/dist/server/http.js");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-ext-e2e-"));
const siteDir = path.join(scratch, "site");
const workspace = path.join(scratch, "proj");
const file = path.join(workspace, "styles/main.css");
const page = (body) => `<!DOCTYPE html>\n<html>\n<head>\n  <link rel="stylesheet" href="css/main.css" />\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
const original = `.btn {
  color: blue;
  padding: 8px 16px;
}

.btn.btn-primary {
  color: white;
  background: navy;
}

.card .title {
  font-weight: bold;
}

#hero {
  color: darkred;
}

@media (min-width: 800px) {
  .btn {
    padding: 12px 24px;
  }
}
`;
for (const [name, text] of Object.entries({
  "index.html": page(`  <div id="hero">Welcome</div>\n  <button class="btn btn-primary">Sign up</button>\n  <div class="card"><span class="title">Card title</span></div>`),
  "about.html": page(`  <button class="btn">Learn more</button>\n  <div class="card"><span class="title">Another card</span></div>`),
  "contact.html": page("  <p>No shared classes here.</p>"),
  "css/main.css": original,
  "styles/main.css": original,
})) {
  const target = name.startsWith("styles/") ? path.join(workspace, name) : path.join(siteDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
process.env.TMPDIR = scratch;
let server = "";
let homeId = "";
let backend;
const settings = { server, autoStartServer: false, diffBase: "", codeLens: false, cursorCount: true, warnLostPages: 10 };
const events = {};
const commands = new Map();
const panels = [];
const notices = [];
const shown = []; // showTextDocument calls
const clipboard = [];
const outputs = [];
const docs = [];
const editors = [];
const state = new Map();
let activeEditor;
let pickedIds = [];
const quickPicks = [];
let scope = "unset";

class EventEmitter {
  constructor() {
    this.handlers = new Set();
    this.event = (handler) => {
      this.handlers.add(handler);
      return { dispose: () => this.handlers.delete(handler) };
    };
  }
  fire(value) {
    for (const handler of [...this.handlers]) handler(value);
  }
  dispose() { this.handlers.clear(); }
}
for (const name of ["open", "change", "save", "close", "visible", "selection", "active", "config"]) events[name] = new EventEmitter();
class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) Object.assign(this, { start: a, end: b });
    else Object.assign(this, { start: new Position(a, b), end: new Position(c, d) });
  }
}
class MarkdownString {
  constructor(value = "") { this.value = value; }
  appendMarkdown(value) { this.value += value; return this; }
}
class ThemeColor { constructor(id) { this.id = id; } }
class Diagnostic {
  constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
}
const statusItem = { text: "", show() {}, dispose() {} };
const noop = { dispose() {} };
const uri = (p) => ({ fsPath: p, path: p, scheme: "file", toString: () => `file://${p}` });
const decorationName = (o) => o.after ? (o.after.color.id === "editorWarning.foreground" ? "attention" : "normal")
  : o.isWholeLine ? (o.overviewRulerColor.id.includes("Warning") ? "liveWarnLine" : "liveLine")
  : String(o.gutterIconPath.fsPath).includes("warning") ? "liveWarnMark" : "liveMark";
const vscode = {
  EventEmitter, Position, Range, MarkdownString, ThemeColor, ThemeIcon: ThemeColor, Diagnostic,
  CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, typeof label === "string" ? { label } : { resourceUri: label }, { collapsibleState }); } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  FileDecoration: class { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } },
  OverviewRulerLane: { Center: 2 },
  scm: {
    createSourceControl: (id, label, rootUri) => {
      const sc = {
        id, label, rootUri, inputBox: {}, groups: [], disposed: false,
        createResourceGroup(groupId, groupLabel) { const g = { id: groupId, label: groupLabel, resourceStates: [], dispose() {} }; sc.groups.push(g); return g; },
        dispose() { sc.disposed = true; },
      };
      vscode.sourceControl = sc;
      return sc;
    },
  },
  Hover: class { constructor(contents) { this.contents = contents; } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { One: 1, Beside: -2 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Workspace: 2 },
  Uri: {
    file: uri,
    parse: (url) => ({ toString: () => url }),
    from: ({ scheme, path: p }) => ({ scheme, path: p, fsPath: p, toString: () => `${scheme}://${p}` }),
    joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
  },
  env: { openExternal: async () => true, clipboard: { writeText: async (text) => { clipboard.push(text); } } },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  workspace: {
    workspaceFolders: [{ uri: uri(workspace) }],
    get textDocuments() { return docs; },
    onDidOpenTextDocument: events.open.event,
    onDidChangeTextDocument: events.change.event,
    onDidSaveTextDocument: events.save.event,
    onDidCloseTextDocument: events.close.event,
    onDidChangeConfiguration: events.config.event,
    getConfiguration: () => ({
      get: (key) => settings[key],
      update: async (key, value) => {
        assert.notEqual(key, "groups", "group links are kept by the server, not in the project's settings");
        settings[key] = value;
        events.config.fire({ affectsConfiguration: (name) => name === `cssBlastRadius.${key}` });
      },
    }),
    asRelativePath: (p) => path.relative(workspace, typeof p === "string" ? p : p.fsPath),
    registerTextDocumentContentProvider: (scheme, provider) => { vscode.contentProvider = provider; return noop; },
    fs: { readFile: async (u) => fs.readFileSync(u.fsPath) },
    openTextDocument: async (u) => {
      assert.equal(u.fsPath, file, "opened another file");
      return doc;
    },
  },
  window: {
    get activeTextEditor() { return activeEditor; },
    get visibleTextEditors() { return editors; },
    showTextDocument: async (document, options) => {
      shown.push({ document, options });
      return { revealRange(range) { shown[shown.length - 1].revealed = range; } };
    },
    onDidChangeVisibleTextEditors: events.visible.event,
    onDidChangeTextEditorSelection: events.selection.event,
    onDidChangeActiveTextEditor: events.active.event,
    createOutputChannel: () => ({
      append() {}, appendLine: (line) => { outputs.push(line); if (process.env.E2E_VERBOSE) console.log("  [extension]", line); },
      show() {}, dispose() {},
    }),
    createTextEditorDecorationType: (options) => ({ name: decorationName(options), dispose() {} }),
    registerFileDecorationProvider: (provider) => { vscode.fileDecorations = provider; return noop; },
    createTreeView: (id, options) => { vscode.treeView = { id, provider: options.treeDataProvider, dispose() {} }; return vscode.treeView; },
    createStatusBarItem: () => statusItem,
    showInformationMessage: async (message) => { notices.push(message); return undefined; },
    showWarningMessage: async (message) => { notices.push(message); return undefined; },
    showErrorMessage: async (message) => { notices.push(message); return undefined; },
    showQuickPick: async (items) => {
      const options = await items;
      quickPicks.push(options);
      assert(options.some((x) => x.label.includes("Open setup page")), "missing setup link");
      return options.filter((x) => pickedIds.includes(x.id));
    },
    withProgress: async (_, run) => run({ report() {} }),
    createWebviewPanel: (viewType, title, column, options) => {
      const disposed = new EventEmitter();
      const changed = new EventEmitter();
      const received = new EventEmitter();
      const panel = {
        viewType, title, column, options, active: true, closed: false, posted: [],
        onDidDispose: disposed.event, onDidChangeViewState: changed.event,
        reveal() { panel.active = true; changed.fire({ webviewPanel: panel }); },
        dispose() { if (panel.closed) return; panel.closed = true; disposed.fire(); },
        webview: {
          html: "", cspSource: "vscode-resource:", onDidReceiveMessage: received.event,
          asWebviewUri: (resource) => ({ toString: () => resource.fsPath }),
          postMessage: async (message) => { panel.posted.push(message); return true; },
          receive: (message) => received.fire(message),
        },
      };
      panels.push(panel);
      return panel;
    },
  },
  languages: {
    createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
    registerCodeLensProvider: () => noop,
    registerHoverProvider: (_, provider) => { vscode.hoverProvider = provider; return noop; },
  },
  commands: {
    registerCommand: (id, handler) => { commands.set(id, handler); return noop; },
    executeCommand: async (id, ...args) => commands.get(id)?.(...args),
  },
};

const priorLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : priorLoad.call(this, request, ...rest);
};

function makeDoc(text) {
  let lines = text.split("\n");
  const doc = {
    uri: uri(file), languageId: "css", isDirty: false,
    getText: () => lines.join("\n"),
    get lineCount() { return lines.length; },
    lineAt: (n) => ({ range: { end: new Position(n, lines[n].length) }, text: lines[n], firstNonWhitespaceCharacterIndex: lines[n].search(/\S|$/) }),
    find: (needle) => {
      const i = lines.findIndex((line) => typeof needle === "string" ? line.includes(needle) : needle.test(line));
      assert(i >= 0, `can't find ${needle}`);
      return new Position(i, typeof needle === "string" ? lines[i].indexOf(needle) : lines[i].search(needle));
    },
    edit(start, end, insert, dirty = true) {
      const head = lines[start.line].slice(0, start.character);
      const tail = lines[end.line].slice(end.character);
      lines = [...lines.slice(0, start.line), ...(head + insert + tail).split("\n"), ...lines.slice(end.line + 1)];
      doc.isDirty = dirty;
      events.change.fire({ document: doc, contentChanges: [{ range: new Range(start, end), text: insert }] });
    },
  };
  return doc;
}

const doc = makeDoc(original);
const editor = {
  document: doc, viewColumn: 1, selections: [{ active: new Position(0, 0) }], decorations: { normal: [], attention: [] },
  get selection() { return editor.selections[0]; },
  setDecorations(type, value) { editor.decorations[type.name] = value; },
  select(pos) { editor.selections = [{ active: pos }]; events.selection.fire({ textEditor: editor }); },
};
function decoration() {
  return [...editor.decorations.normal, ...editor.decorations.attention].map((d) => d.renderOptions.after.contentText);
}
async function waitFor(test, label, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await test();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Status: ${statusItem.text}; output: ${outputs.slice(-4).join(" | ")}`);
}
async function json(url, options) {
  const response = await fetch(new URL(url, server), { ...options, signal: AbortSignal.timeout(90_000) });
  const body = await response.json();
  assert(response.ok, `${response.status} ${url}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const checks = [];
async function check(name, run) {
  try {
    await run();
    checks.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: false });
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}
const pagesPanel = () => panels.find((p) => p.viewType === "cssBlastRadius.pages" && !p.closed);
const lastPages = (p) => [...p.posted].reverse().find((m) => m.type === "pages");
const lastOf = (p, type, from = 0) => [...p.posted.slice(from)].reverse().find((m) => m.type === type);
const ctx = {
  subscriptions: [], extensionUri: uri(extRoot),
  workspaceState: { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) },
};

async function startBackend() {
  const { startServer } = await import(pathToFileURL(backendDist).href);
  backend = await startServer({ dataDir: path.join(scratch, "data"), port: 0, l1Workers: 0, log: () => {} });
  server = settings.server = backend.url;
  const write = (method, url, body) => json(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await write("PUT", "/api/site", { siteFolder: siteDir, devices: ["desktop"] });
  await write("POST", "/api/groups", { name: "All pages", source: { type: "paste" }, urls: ["/index.html", "/about.html", "/contact.html"], scan: false });
  homeId = (await write("POST", "/api/groups", { name: "Home & About", source: { type: "paste" }, urls: ["/index.html", "/about.html"], scan: false })).id;
  await json("/api/rescan-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await backend.app.jobs.idle();
  const scanned = (await json("/api/state")).groups.find((g) => g.id === homeId);
  assert(scanned?.ok === 2, `fixture scan failed: ${JSON.stringify(scanned)}`);
}

async function run() {
  await startBackend();
  const { activate } = require(path.join(extRoot, "dist/extension.js"));
  try {
    await check("attach: initialize returns session and server URL", async () => {
      activate(ctx);
      await waitFor(() => statusItem.text.includes("Link page groups"), "initial link state");
      const project = (await json("/api/state")).projects.find((p) => p.root === workspace);
      assert(project?.id && project.groups.length === 0, `server session not initialized with empty groups: ${JSON.stringify(project)}`);
      scope = project.id;
      assert.equal(server, backend.url);
      assert(outputs.some((line) => line.includes("Connected to")), "server not attached");
    });
    await check("unlinked: status prompts linking and page count stays zero", async () => {
      assert.match(statusItem.text, /Link page groups/);
      await vscode.commands.executeCommand("cssBlastRadius.showAllPages");
      const p = pagesPanel();
      assert(p, "panel wasn't opened on demand");
      p.webview.receive({ type: "ready" });
      const data = await waitFor(() => lastPages(p), "unlinked page list");
      assert.equal(data.result.total, 0);
      assert.equal(data.result.count.exact, 0);
    });
    await check("link picker: the server keeps the link, nothing is written into the project", async () => {
      pickedIds = [homeId];
      await vscode.commands.executeCommand("cssBlastRadius.linkGroups");
      await waitFor(async () => (await json("/api/state")).projects.find((p) => p.root === workspace)?.groups.includes(homeId), "server group link");
      assert(!fs.existsSync(path.join(workspace, ".vscode")), "a .vscode folder was created in the project");
      await vscode.commands.executeCommand("cssBlastRadius.linkGroups");
      assert.deepEqual(quickPicks.at(-1).filter((x) => x.picked).map((x) => x.id), [homeId], "the picker should show the server's link");
      assert(!statusItem.text.includes("Link page groups"), statusItem.text);
    });
    await check("typing: .btn decoration and status count update before save", async () => {
      docs.push(doc);
      editors.push(editor);
      activeEditor = editor;
      events.active.fire(editor);
      events.visible.fire(editors);
      events.open.fire(doc);
      await waitFor(() => outputs.some((s) => s.includes("Connected to")), "document open");
      const start = /\.btn\s*\{/.exec(doc.getText());
      assert(start, "fixture must include a .btn rule");
      const positionAt = (offset) => {
        const parts = doc.getText().slice(0, offset).split("\n");
        return new Position(parts.length - 1, parts[parts.length - 1].length);
      };
      const at = positionAt(start.index);
      editor.select(new Position(at.line, at.character + 2));
      const insert = "\n  outline: 2px solid red;";
      const closingOffset = doc.getText().indexOf("}", start.index + start[0].length);
      assert(closingOffset > 0, ".btn rule has no closing brace");
      const close = positionAt(closingOffset);
      let pos = new Position(close.line, close.character);
      for (const char of insert) {
        doc.edit(pos, pos, char);
        pos = char === "\n" ? new Position(pos.line + 1, 0) : new Position(pos.line, pos.character + 1);
        editor.select(new Position(at.line, at.character + 2));
        await new Promise((r) => setImmediate(r));
      }
      await waitFor(() => statusItem.text.includes("2 pages") && decoration().some((text) => text.includes("2 pages")), "two pages while unsaved");
      assert(doc.isDirty && fs.readFileSync(file, "utf8") === original, "typing wrote the file to disk");
    });
    await check("hover: changed rule has Show pages and all-pages links", async () => {
      const hover = await waitFor(() => vscode.hoverProvider.provideHover(doc, editor.selection.active), "changed-rule hover");
      assert.match(hover.contents.value, /2 pages/);
      assert.match(hover.contents.value, /command:cssBlastRadius\.showPages\?/);
      assert.match(hover.contents.value, /command:cssBlastRadius\.showAllPages\?/);
    });
    await check("live site: the typed line is highlighted, badged, listed and has a live copy", async () => {
      const at = doc.find("outline").line;
      await waitFor(() => editor.decorations.liveLine?.some((d) => d.range.start.line === at && d.range.end.line === at), "live line highlight");
      assert.deepEqual(editor.decorations.liveMark.map((d) => d.range.start.line), [at]);
      assert.equal(vscode.fileDecorations.provideFileDecoration(uri(file))?.badge, "1");
      const tree = vscode.treeView.provider;
      const files = tree.getChildren();
      assert.deepEqual(files.map((n) => n.file.file), [file]);
      const item = tree.getTreeItem(tree.getChildren(files[0])[0]);
      assert.equal(item.label, ".btn");
      assert.match(item.description, /2 pages · line \d+/);
      assert.deepEqual(vscode.sourceControl.groups[0].resourceStates.map((r) => r.resourceUri.fsPath), [file]);
      const liveCopy = vscode.sourceControl.quickDiffProvider.provideOriginalResource(uri(file));
      assert.equal(liveCopy.scheme, "cbr-live");
      assert.equal(await vscode.contentProvider.provideTextDocumentContent(liveCopy), original);
    });
    await check("panel: on-demand page list includes both pages and file chips", async () => {
      await vscode.commands.executeCommand("cssBlastRadius.showAllPages");
      const p = pagesPanel();
      const data = await waitFor(() => {
        const m = lastPages(p);
        return m?.result.pages.some((x) => x.url === "/about.html") && m;
      }, "linked page list");
      assert.deepEqual(data.result.pages.map((x) => x.url).sort(), ["/about.html", "/index.html"]);
      assert(data.result.pages.every((x) => x.groups.includes("Home & About")), "page group names missing from rows");
      assert(data.chips.some((chip) => chip.path === file && chip.changes.length), "no file/change chips");
    });
    await check("edit card: the whole rule, the typed declaration in green; Go to rule and Copy", async () => {
      const p = pagesPanel();
      const ch = lastPages(p).chips.find((c) => c.path === file).changes[0];
      assert.equal(ch.label, ".btn");
      const mark = p.posted.length;
      p.webview.receive({ type: "rule", path: file, changeId: ch.id, seq: 7 });
      const reply = await waitFor(() => lastOf(p, "rule", mark), "edit card");
      assert.equal(reply.seq, 7);
      assert(reply.detail, `no rule: ${reply.error}`);
      assert.deepEqual(reply.detail.rule.decls.map((d) => `${d.state} ${d.text}`),
        ["same color: blue", "same padding: 8px 16px", "changed outline: 2px solid red"]);
      const at = doc.find("outline");
      assert.deepEqual([reply.detail.line, reply.detail.column], [at.line + 1, at.character + 1]);
      p.webview.receive({ type: "goto", path: file, changeId: ch.id });
      const go = await waitFor(() => shown[0], "editor opened at the edit");
      assert.equal(go.document, doc);
      assert.deepEqual([go.options.selection.start.line, go.options.selection.start.character], [at.line, at.character]);
      assert.equal(go.options.viewColumn, 1, "should open where the CSS is edited, not over the panel");
      assert(go.revealed, "the whole rule should be brought into view");
      p.webview.receive({ type: "copy", text: ".btn { outline: 2px solid red; }" });
      await waitFor(() => clipboard.length === 1, "copied rule");
    });
    await check("assess: button checks every listed page and the list comes back ranked", async () => {
      const p = pagesPanel();
      assert.equal(lastPages(p).result.assessment?.pending, 2, "list should start unassessed");
      p.webview.receive({ type: "assess" });
      await waitFor(() => p.posted.some((m) => m.type === "assessProgress" && m.progress.running), "assessment started");
      const data = await waitFor(() => {
        const m = lastPages(p);
        return m?.result.assessment?.assessed === 2 && !m.result.assessment.running && m;
      }, "ranked page list");
      assert.deepEqual(data.result.pages.map((x) => x.impact?.status), ["changed", "changed"]);
      assert.equal(data.result.assessment.changed, 2);
    });
    await check("diff: iframe URL and server-rendered changed result", async () => {
      pagesPanel().webview.receive({ type: "page", url: "/about.html" });
      const diff = await waitFor(() => panels.find((p) => p.viewType === "cssBlastRadius.diff"), "diff tab");
      const escaped = `${server}/diff?s=${scope}&amp;url=%2Fabout.html&amp;embed=1`;
      assert(diff.webview.html.includes(`src="${escaped}"`), "wrong embedded diff URL");
      const result = await json(`/api/diff?s=${scope}&url=%2Fabout.html`);
      assert.equal(result.status, "changed", `page diff: ${result.status} ${result.reason || ""}`);
    });
    await check("pick: unpicking an edit empties the list and the diff, picking it again restores both", async () => {
      const p = pagesPanel();
      const id = lastPages(p).chips.find((c) => c.path === file).changes[0].id;
      const before = p.posted.length;
      const after = () => [...p.posted.slice(before)].reverse().find((m) => m.type === "pages");
      p.webview.receive({ type: "toggle", path: file, changeId: id });
      const none = await waitFor(() => after()?.pickedEdits === 0 && after(), "list with nothing picked");
      assert.equal(none.all, false);
      assert.equal(none.chips.find((c) => c.path === file).state, "none");
      assert.equal(none.result.pages.length, 0);
      const empty = await json(`/api/diff?s=${scope}&url=%2Fabout.html`);
      assert.match(empty.reason || "", /None of your edits are picked/);
      const mark = p.posted.length;
      p.webview.receive({ type: "toggle" });
      const all = await waitFor(() => {
        const m = [...p.posted.slice(mark)].reverse().find((x) => x.type === "pages");
        return m?.all && m.result.pages.length === 2 && m;
      }, "list with every edit picked");
      assert(all.chips.every((c) => c.state === "all" && c.changes.every((ch) => ch.selected)), "chips should all be picked");
      assert.equal((await json(`/api/diff?s=${scope}&url=%2Fabout.html`)).status, "changed");
    });
    await check("pause: groups/changed updates linked counts without an editor save", async () => {
      const res = await json(`/api/groups/${homeId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: false }),
      });
      assert.equal(res.active, false);
      await waitFor(() => !statusItem.text.includes("2 pages") && statusItem.text.includes("0 pages"), "count after group pause");
      assert.deepEqual((await json("/api/state")).projects.find((p) => p.root === workspace)?.groups, [homeId], "link should remain while the group is paused");
      await json(`/api/groups/${homeId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: true }),
      });
      await waitFor(() => statusItem.text.includes("2 pages"), "count after group resumes");
    });
    await check("tabs: the panel switches between All, This session and Unsaved; no Uncommitted without git", async () => {
      const p = pagesPanel();
      const tabs = await waitFor(() => lastOf(p, "tabs"), "tab row");
      assert.deepEqual(tabs.tabs.map((t) => t.name), ["All", "This session", "Unsaved"]);
      assert.equal(tabs.base, "session", "Uncommitted (the default) falls back to This session without git");
      for (const base of ["saved", "production", "session"]) {
        const mark = p.posted.length;
        p.webview.receive({ type: "tab", base });
        await waitFor(() => lastOf(p, "tabs", mark)?.base === base, `${base} tab`);
        const list = await waitFor(() => {
          const m = lastOf(p, "pages", mark);
          return m && lastOf(p, "tabs", mark).base === base && m.result.total === 2 && m;
        }, `${base} tab's page list`);
        assert(list.baseLabel, "list says what it's compared with");
        assert.equal(lastOf(p, "tabs", mark).main, undefined, "no main branch without git");
      }
    });
    await check("undo: typing undone back to the saved text isn't a change outside the editor", async () => {
      const text = doc.getText();
      const insert = "\n  outline: 2px solid red;";
      const at = text.indexOf(insert);
      assert(at > 0, "typed text not found");
      const pos = (offset) => {
        const parts = text.slice(0, offset).split("\n");
        return new Position(parts.length - 1, parts[parts.length - 1].length);
      };
      const seen = notices.length;
      doc.edit(pos(at), pos(at + insert.length), "", false);
      await waitFor(() => statusItem.text.includes("0 pages"), "count back to zero");
      await new Promise((r) => setTimeout(r, 600));
      assert.deepEqual(notices.slice(seen), [], "undo was reported as an outside change");
    });
    await check("outside editor: closed file change triggers one notice", async () => {
      docs.splice(docs.indexOf(doc), 1);
      editors.splice(editors.indexOf(editor), 1);
      activeEditor = undefined;
      events.close.fire(doc);
      await new Promise((r) => setTimeout(r, 350));
      const changed = original.replace(/(\.btn\s*\{[^}]*\bcolor\s*:\s*)blue/i, "$1red");
      assert.notEqual(changed, original, "fixture must contain color: blue");
      fs.writeFileSync(file, changed);
      const notice = await waitFor(() => notices.find((text) => text.includes("CSS changed outside the editor")), "outside-editor notification", 25_000);
      assert.equal(notice, "CSS changed outside the editor (1 file): now 2 pages affected (was 0 pages).");
    });
    await check("dispose: no shared-server shutdown", async () => {
      for (const item of [...ctx.subscriptions].reverse()) item.dispose();
      await json("/api/state");
      assert(!outputs.some((line) => /shutdown/i.test(line)), "extension attempted server shutdown");
    });
  } finally {
    for (const item of [...ctx.subscriptions].reverse()) {
      try { item.dispose(); } catch {}
    }
    await backend.close().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const failed = checks.filter((x) => !x.ok).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exitCode = 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
