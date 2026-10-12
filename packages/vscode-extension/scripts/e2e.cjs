// End-to-end check of the compiled extension against a real daemon, with a
// stubbed `vscode` API. Black-box: it observes the status bar, decorations,
// Problems, CodeLens, hover and the panel's webview messages.
//
//   npm run build (backend + extension), capture the workspace, then:
//   node scripts/e2e.cjs [workspace=/tmp/cbr-ws] [dataDir=/tmp/cbr-data]
//
// The workspace must be a clean git checkout of the generated fixture site.

"use strict";
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const ws = path.resolve(process.argv[2] ?? "/tmp/cbr-ws");
const data = path.resolve(process.argv[3] ?? "/tmp/cbr-data");
const extRoot = path.resolve(__dirname, "..");
const settings = { daemonPath: path.resolve(extRoot, "../backend/dist/cli.js"), dataDir: data, codeLens: true, warnLostPages: 10 };

// ------------------------------------------------------------------ stub

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => {
      this.listeners.add(fn);
      return { dispose: () => this.listeners.delete(fn) };
    };
  }
  fire(e) {
    for (const f of [...this.listeners]) f(e);
  }
  dispose() {
    this.listeners.clear();
  }
}
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) Object.assign(this, { start: a, end: b });
    else Object.assign(this, { start: new Position(a, b), end: new Position(c, d) });
  }
}
class MarkdownString {
  constructor(v = "") {
    this.value = v;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
}
class CodeLens {
  constructor(range, command) {
    Object.assign(this, { range, command });
  }
}
class Hover {
  constructor(contents) {
    this.contents = contents;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity });
  }
}
const disposable = { dispose() {} };
const ev = { open: new EventEmitter(), change: new EventEmitter(), save: new EventEmitter(), close: new EventEmitter(), visible: new EventEmitter(), config: new EventEmitter() };
const docs = [];
const editors = [];
const diagnostics = new Map();
const statusItem = { show() {}, dispose() {}, text: "" };
const decorationTypes = [];
const commands = new Map();
const messages = [];
const providers = {};
const panel = { posted: [], handler: undefined, created: 0 };
let quickPick;

const vscode = {
  EventEmitter,
  Position,
  Range,
  MarkdownString,
  CodeLens,
  Hover,
  ThemeColor,
  ThemeIcon: ThemeColor,
  Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Beside: -2 },
  ProgressLocation: { Notification: 15 },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file", toString: () => "file://" + p }),
    joinPath: (u, ...parts) => ({ fsPath: path.join(u.fsPath, ...parts), scheme: "file" }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws } }],
    onDidOpenTextDocument: ev.open.event,
    onDidChangeTextDocument: ev.change.event,
    onDidSaveTextDocument: ev.save.event,
    onDidCloseTextDocument: ev.close.event,
    onDidChangeConfiguration: ev.config.event,
    get textDocuments() {
      return docs;
    },
    getConfiguration: () => ({ get: (k) => settings[k] }),
    asRelativePath: (p) => path.relative(ws, typeof p === "string" ? p : p.fsPath),
  },
  window: {
    createOutputChannel: () => ({ append() {}, appendLine: (s) => process.env.E2E_VERBOSE && console.log("  [ext]", s), show() {}, dispose() {} }),
    createTextEditorDecorationType: (o) => {
      const t = { o, name: decorationTypes.length === 0 ? "normal" : "attention", dispose() {} };
      decorationTypes.push(t);
      return t;
    },
    createStatusBarItem: () => statusItem,
    get visibleTextEditors() {
      return editors;
    },
    onDidChangeVisibleTextEditors: ev.visible.event,
    showInformationMessage: async (m) => void messages.push(m),
    showWarningMessage: async (m) => void messages.push(m),
    showErrorMessage: async (m) => void messages.push(m),
    showQuickPick: async (items) => (await items).find((i) => i.base === quickPick),
    withProgress: async (_o, fn) => fn({ report() {} }),
    createWebviewPanel: () => {
      panel.created++;
      return {
        webview: {
          html: "",
          cspSource: "vscode-resource:",
          asWebviewUri: (u) => u.fsPath,
          postMessage: async (m) => {
            panel.posted.push(m);
            return true;
          },
          onDidReceiveMessage: (fn) => {
            panel.handler = fn;
            return disposable;
          },
        },
        onDidDispose: () => disposable,
        reveal() {},
        dispose() {},
      };
    },
  },
  languages: {
    createDiagnosticCollection: () => ({ set: (u, d) => diagnostics.set(u.fsPath, d), delete: (u) => diagnostics.delete(u.fsPath), dispose() {} }),
    registerCodeLensProvider: (_s, p) => ((providers.lens = p), disposable),
    registerHoverProvider: (_s, p) => ((providers.hover = p), disposable),
  },
  commands: {
    registerCommand: (id, fn) => (commands.set(id, fn), disposable),
    executeCommand: async (id, ...a) => commands.get(id)?.(...a),
  },
};

const load = Module._load;
Module._load = function (req, ...rest) {
  return req === "vscode" ? vscode : load.call(this, req, ...rest);
};

// ------------------------------------------------------------ documents

function makeDoc(file) {
  let lines = fs.readFileSync(file, "utf8").split("\n");
  const doc = {
    uri: vscode.Uri.file(file),
    languageId: "css",
    getText: () => lines.join("\n"),
    get lineCount() {
      return lines.length;
    },
    lineAt: (n) => ({ range: { end: new Position(n, lines[n].length) }, text: lines[n] }),
    find: (needle) => {
      const i = lines.findIndex((l) => l.includes(needle));
      if (i < 0) throw new Error(`not found: ${needle}`);
      return new Position(i, lines[i].indexOf(needle));
    },
    /** Replace [start, end) with text and fire the change like VS Code does. */
    edit(start, end, text) {
      const before = lines.slice(0, start.line);
      const head = lines[start.line].slice(0, start.character);
      const tail = lines[end.line].slice(end.character);
      const mid = (head + text + tail).split("\n");
      lines = [...before, ...mid, ...lines.slice(end.line + 1)];
      ev.change.fire({ document: doc, contentChanges: [{ range: new Range(start, end), text }] });
    },
  };
  return doc;
}

function showEditor(doc) {
  const ed = { document: doc, decorations: { normal: [], attention: [] }, setDecorations: (t, opts) => (ed.decorations[t.name] = opts) };
  editors.push(ed);
  ev.visible.fire(editors);
  return ed;
}

// ---------------------------------------------------------------- checks

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name} (${Date.now() - t0} ms)${note ? ` — ${note}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`✗ ${name}: ${err?.message ?? err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function waitFor(cond, what, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what} (status: "${statusItem.text}")`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const token = { isCancellationRequested: false };
const decoText = (ed, kind = "normal") => ed.decorations[kind].map((d) => `${d.range.start.line + 1}: ${d.renderOptions.after.contentText}`);

// ------------------------------------------------------------------ run

async function main() {
  const { activate } = require(path.join(extRoot, "dist/extension.js"));
  const ctx = { subscriptions: [], extensionUri: { fsPath: extRoot, scheme: "file" } };
  const file = path.join(ws, "css/components.css");
  const original = fs.readFileSync(file, "utf8");
  const doc = makeDoc(file);
  let ed;
  let union = "";

  await check("activate, spawn the daemon and attach", async () => {
    activate(ctx);
    await waitFor(() => statusItem.text.includes("No CSS edits"), "the connected status");
    return statusItem.text;
  });

  await check("open a CSS file: no edits, no decorations", async () => {
    docs.push(doc);
    ed = showEditor(doc);
    ev.open.fire(doc);
    const lenses = await waitFor(async () => {
      const l = await providers.lens.provideCodeLenses(doc, token);
      return l.length ? l : undefined;
    }, "CodeLens");
    assert(decoText(ed).length === 0, `unexpected decorations ${decoText(ed)}`);
    const promo = lenses.find((l) => l.range.start.line === doc.find(".promo-banner {").line);
    assert(promo && promo.command.title === "51 pages", `promo lens: ${promo?.command.title}`);
    assert(promo.command.command === "cssBlastRadius.showPages", "promo lens is clickable");
    return `${lenses.length} lenses; .promo-banner → “${promo.command.title}”`;
  });

  const promoLine = doc.find(".promo-banner {").line;
  await check("type a declaration keystroke by keystroke: decoration + status bar", async () => {
    const text = "  outline: 1px solid red;\n";
    let pos = new Position(promoLine + 1, 0);
    const t0 = Date.now();
    for (const ch of text) {
      doc.edit(pos, pos, ch);
      pos = ch === "\n" ? new Position(pos.line + 1, 0) : new Position(pos.line, pos.character + 1);
      await new Promise((r) => setImmediate(r));
    }
    await waitFor(() => statusItem.text.includes("Your edits: 51 pages"), "51 pages in the status bar");
    const ms = Date.now() - t0;
    const d = await waitFor(() => decoText(ed).find((t) => t.includes("51 pages") && !t.includes("editing")), "the final decoration");
    return `${ms} ms after the first keystroke; “${d}”; ${statusItem.text}`;
  });

  await check("hover on the changed rule explains the count", async () => {
    const h = providers.hover.provideHover(doc, new Position(promoLine, 0));
    assert(h, "no hover");
    const md = h.contents.value;
    assert(md.includes("Declarations changed") && md.includes("**51** exact") && md.includes("`outline`"), md);
    assert(md.includes("command:cssBlastRadius.showPages?"), "no show-pages link");
    return "Declarations changed · 51 exact · outline";
  });

  await check("panel: page list, elements (L1) and render diff (L2)", async () => {
    await vscode.commands.executeCommand("cssBlastRadius.showPages", { path: file, line: promoLine + 1, title: ".promo-banner" });
    assert(panel.created === 1 && panel.handler, "panel not created");
    panel.handler({ type: "ready" });
    const pages = await waitFor(() => panel.posted.find((m) => m.type === "pages"), "the page list");
    assert(pages.result.total === 51 && pages.summary === "51 pages", `list: ${pages.result.total} / ${pages.summary}`);
    const url = pages.result.pages[0].url;
    panel.handler({ type: "page", url });
    const d1 = await waitFor(() => panel.posted.find((m) => m.type === "detail" && m.kind === "page"), "L1 detail");
    const m = d1.results[0].result.matches;
    assert(m.length && m[0].variants[0].count > 0, `no matched elements: ${JSON.stringify(d1.results[0])}`);
    panel.handler({ type: "render", url, screenshots: false });
    const d2 = await waitFor(() => panel.posted.find((m) => m.type === "detail" && m.kind === "render"), "L2 detail", 30000);
    const r = d2.results[0].result.render;
    assert(r && r.status === "changed" && r.changedElements > 0, `render: ${JSON.stringify(d2.results[0]).slice(0, 300)}`);
    return `${url}: ${m[0].variants[0].count} element(s); L2 ${r.changedElements} changed in ${d2.ms} ms`;
  });

  await check("session panel lists the session's pages", async () => {
    panel.posted.length = 0;
    await vscode.commands.executeCommand("cssBlastRadius.showPages");
    const pages = await waitFor(() => panel.posted.find((m) => m.type === "pages"), "session list");
    assert(pages.result.total === 51, `session total ${pages.result.total}`);
  });

  await check("selector rename that loses pages: attention decoration + Problems warning", async () => {
    const at = doc.find(".card--featured {");
    doc.edit(new Position(at.line, at.character), new Position(at.line, at.character + ".card--featured".length), ".card--featurd");
    const diag = await waitFor(() => (diagnostics.get(file) ?? []).find((d) => d.message.includes("no longer reaches")), "the warning");
    assert(diag.severity === vscode.DiagnosticSeverity.Warning && diag.message.includes("45"), diag.message);
    const att = decoText(ed, "attention");
    assert(att.some((t) => t.includes("−45")), `attention: ${att}`);
    // The union: some pages carry both rules.
    const n = await waitFor(() => Number(/Your edits: (\d+) pages/.exec(statusItem.text)?.[1] ?? 0) > 51 && /Your edits: \d+ pages/.exec(statusItem.text)[0], "the session union");
    union = n;
    return `“${diag.message}”; ${att.join(", ")}; ${n}`;
  });

  await check("save, then diff base “saved”: nothing left to compare", async () => {
    // VS Code writes the file, then fires the event; "saved" compares with the disk.
    fs.writeFileSync(file, doc.getText());
    ev.save.fire(doc);
    await new Promise((r) => setTimeout(r, 200));
    quickPick = "saved";
    await vscode.commands.executeCommand("cssBlastRadius.setDiffBase");
    await waitFor(() => statusItem.text.includes("No CSS edits"), "no edits vs saved");
    quickPick = "HEAD";
    await vscode.commands.executeCommand("cssBlastRadius.setDiffBase");
    await waitFor(() => statusItem.text.includes(union), "edits vs HEAD again");
    // Revert the disk (an open file is owned by the editor: nothing changes).
    fs.writeFileSync(file, original);
  });

  await check("restart the daemon: documents are re-opened, answers come back", async () => {
    await vscode.commands.executeCommand("cssBlastRadius.restartDaemon");
    await waitFor(() => statusItem.text.includes(union), "answers after restart", 30000);
    const lenses = await providers.lens.provideCodeLenses(doc, token);
    assert(lenses.length > 10, "no lenses after restart");
  });

  await check("close the file: back to the file on disk (unchanged)", async () => {
    docs.splice(docs.indexOf(doc), 1);
    editors.length = 0;
    ev.close.fire(doc);
    await waitFor(() => statusItem.text.includes("No CSS edits"), "no edits after close");
    assert(!diagnostics.get(file)?.length, "diagnostics not cleared");
  });

  await check("dispose: the daemon it started exits", async () => {
    const sock = require(path.join(extRoot, "dist/daemonLifecycle.js")).socketPathFor(ws);
    for (const s of ctx.subscriptions) s.dispose();
    await waitFor(() => !fs.existsSync(sock), "the socket to be removed", 10000);
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nALL ${results.length} PASSED`);
  if (messages.length) console.log("messages shown:", messages);
  process.exit(failed ? 1 : 0);
}

process.on("exit", () => {
  // Never leave the fixture checkout modified.
  const file = path.join(ws, "css/components.css");
  require("node:child_process").spawnSync("git", ["-C", ws, "checkout", "--", path.relative(ws, file)]);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
