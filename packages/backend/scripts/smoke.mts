// End-to-end smoke test: spawn the daemon CLI, talk NDJSON over its socket.
// usage: npm run smoke -- [workspace=/tmp/cbr-ws] [dataDir=/tmp/cbr-data]
// The workspace must be a clean git checkout of a captured site.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const [ws = "/tmp/cbr-ws", data = "/tmp/cbr-data"] = process.argv.slice(2);
const sock = path.join(os.tmpdir(), "cbr-smoke.sock");
const proc = spawn("npx", ["tsx", "src/cli.ts", "daemon", "--workspace", ws, "--data", data, "--socket", sock, "--l1-workers", "2"], { stdio: ["pipe", "inherit", "inherit"] });

const t0 = Date.now();
while (!fs.existsSync(sock)) {
  if (Date.now() - t0 > 30_000) throw new Error("daemon did not start");
  await new Promise((r) => setTimeout(r, 100));
}
const c = net.connect(sock);
await new Promise((r) => c.once("connect", r));
let id = 0;
const waiting = new Map<number, (m: any) => void>();
const notes: any[] = [];
const noteWaiters: Array<{ method: string; pred: (p: any) => boolean; res: (p: any) => void }> = [];
let buf = "";
c.setEncoding("utf8");
c.on("data", (d: string) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id !== undefined && m.id !== null) waiting.get(m.id)?.(m);
    else {
      notes.push(m);
      for (const w of [...noteWaiters]) if (w.method === m.method && w.pred(m.params)) {
        noteWaiters.splice(noteWaiters.indexOf(w), 1);
        w.res(m.params);
      }
    }
  }
});
function rpc(method: string, params?: any): Promise<{ result?: any; error?: any; ms: number }> {
  const n = ++id;
  const t = performance.now();
  c.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  return new Promise((res) => waiting.set(n, (m) => res({ result: m.result, error: m.error, ms: +(performance.now() - t).toFixed(2) })));
}
function note(method: string, pred: (p: any) => boolean = () => true, timeout = 10_000): Promise<any> {
  return new Promise((res, rej) => {
    noteWaiters.push({ method, pred, res });
    setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeout);
  });
}
const cnt = (x: any) => `${x.exact}e/${x.possible}p/${x.unknown}u${x.complete ? "" : "*"}`;
let fails = 0;
function check(name: string, ok: boolean, info = "") {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`);
}

const file = path.join(ws, "css/components.css");
const text = fs.readFileSync(file, "utf8");
const lines = text.split("\n");
const promoLine = lines.findIndex((l) => l.startsWith(".promo-banner {"));
const featLine = lines.findIndex((l) => l.includes(".card--featured {"));

const init = await rpc("initialize", { client: "smoke" });
check("initialize", init.result?.protocolMajor === 1 && init.result.status.ready, `${init.result?.status.health}, ${init.result?.status.pages} pages, ${init.ms} ms`);

const open = await rpc("document/open", { path: file, text, version: 1 });
check("open unchanged → 0 with reason", open.result?.answer.total.exact === 0 && open.result.answer.changes.length === 0, `${cnt(open.result?.answer.total)} reasons=${JSON.stringify(open.result?.answer.totalReasons)} ${open.ms} ms`);

// Keystroke: add a declaration at the end of .promo-banner.
const refined1 = note("analysis/refined", (p) => p.answer.file === file && p.answer.level === 1);
const ch = await rpc("document/change", { path: file, version: 2, changes: [{ range: { start: { line: promoLine + 1, character: 0 }, end: { line: promoLine + 1, character: 0 } }, text: "  letter-spacing: 0.02em;\n" }] });
const a = ch.result?.answer;
check("keystroke L0", !!a && a.total.exact + a.total.possible >= 51, `${cnt(a.total)} changes=${a.changes.length} ${ch.ms} ms (engine ${a.timingMs} ms)`);
check("simple class is final at L0 (no L1 needed)", a.total.complete === true);
void refined1.catch(() => {});

const pages = await rpc("analysis/getPages", { path: file, limit: 5 });
check("getPages", pages.result?.total >= 51, `${pages.result?.total} pages, groups=${JSON.stringify(pages.result?.groups.slice(0, 4))} ${pages.ms} ms`);
const url = pages.result?.pages[0]?.url;

const rules = await rpc("analysis/queryImpacts", { path: file, scope: "rules" });
const promoRule = rules.result?.rules.find((r: any) => r.selector === ".promo-banner");
check("rule counts", !!promoRule, `${rules.result?.rules.length} rules, .promo-banner=${promoRule && cnt(promoRule.pages)} ${rules.ms} ms`);

const d1 = await rpc("analysis/getDrilldown", { path: file, url, level: 1 });
check("drilldown L1", d1.result?.matches?.[0]?.variants?.[0]?.count > 0, `${url}: ${JSON.stringify(d1.result?.matches?.[0]?.variants?.[0]?.elements?.slice(0, 2))} ${d1.ms} ms`);
const d2 = await rpc("analysis/getDrilldown", { path: file, url, level: 2 });
check("drilldown L2", d2.result?.render?.status === "changed", `${d2.result?.render?.status} changed=${d2.result?.render?.changedElements} moved=${d2.result?.render?.movedElements} ${d2.ms} ms ${d2.error?.message ?? ""}`);

const gap = await rpc("document/change", { path: file, version: 9, changes: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "x" }] });
check("version gap → resync", gap.error?.code === -32001, JSON.stringify(gap.error));

// Selector edit: .card--featured → .card--feat (45 pages lose the rule).
const lines2 = fs.readFileSync(file, "utf8").split("\n");
const col = lines2[featLine].indexOf(".card--featured") + ".card--feat".length;
const sel = await rpc("document/change", { path: file, version: 3, changes: [{ range: { start: { line: featLine, character: col }, end: { line: featLine, character: col + 4 } }, text: "" }] });
const ca = sel.result?.answer;
const selChange = ca?.changes.find((x: any) => x.kind === "selector");
check("selector change", !!selChange, `${cnt(ca.total)} ${JSON.stringify(selChange && { kind: selChange.kind, sel: selChange.selector, old: selChange.oldSelector, lost: selChange.lost && cnt(selChange.lost) })} ${sel.ms} ms`);

// New descendant selector: unknown to the index → possible at L0, refined by L1.
const titleLine = lines.findIndex((l) => l.trim() === ".card .title {");
const ind = lines[titleLine].indexOf(".card");
const refined2 = note("analysis/refined", (p) => p.answer.file === file && p.answer.level === 1);
const t2 = performance.now();
const desc = await rpc("document/change", { path: file, version: 4, changes: [{ range: { start: { line: titleLine, character: ind }, end: { line: titleLine, character: ind } }, text: "main " }] });
const dc = desc.result?.answer.changes.find((x: any) => x.selector?.startsWith("main .card"));
check("descendant selector L0", !!dc, `${dc && `pages ${cnt(dc.pages)} lost ${cnt(dc.lost)}`} ${desc.ms} ms`);
const r2 = await refined2.catch((e) => e);
const dc2 = r2 instanceof Error ? undefined : r2.answer.changes.find((x: any) => x.selector?.startsWith("main .card"));
check("L1 refinement", !!dc2, r2 instanceof Error ? r2.message : `pages ${cnt(dc2.pages)} lost ${cnt(dc2.lost)} after ${(performance.now() - t2).toFixed(1)} ms, rules=${r2.rules}`);

// Broken text while typing: last valid answer, editing=true.
const prev = desc.result.answer;
const brk = await rpc("document/change", { path: file, version: 5, changes: [{ range: { start: { line: promoLine, character: 0 }, end: { line: promoLine, character: 0 } }, text: ".x { color: red;\n" }] });
check("parse error keeps last answer", brk.result?.answer.editing === true && brk.result.answer.total.exact === (r2 instanceof Error ? prev : r2.answer).total.exact, `editing=${brk.result?.answer.editing} ${cnt(brk.result?.answer.total)}`);

// Closed file changed on disk → watcher → publishImpact.
const util = path.join(ws, "css/utilities.css");
const utilOrig = fs.readFileSync(util, "utf8");
const pub = note("analysis/publishImpact", (p) => p.session.files.some((f: any) => f.file === util), 8000);
fs.writeFileSync(util, utilOrig + "\n.text-center { text-align: center; letter-spacing: 1px; }\n");
const pubR = await pub.catch((e) => e);
check("closed-file watcher", !(pubR instanceof Error), pubR instanceof Error ? pubR.message : `session ${cnt(pubR.session.total)} files=${pubR.session.files.map((f: any) => path.basename(f.file)).join(",")}`);
// Committing moves HEAD: the closed file is no longer an edit.
const pub2 = note("analysis/publishImpact", (p) => !p.session.files.some((f: any) => f.file === util), 8000);
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "tmp"], { cwd: ws });
const pub2R = await pub2.catch((e) => e);
check("git commit watched", !(pub2R instanceof Error), pub2R instanceof Error ? pub2R.message : `files=${pub2R.session.files.map((f: any) => path.basename(f.file)).join(",")}`);
execFileSync("git", ["reset", "-q", "--hard", "HEAD~1"], { cwd: ws });

const sb = await rpc("session/setDiffBase", { base: "saved" });
check("diff base saved", sb.result?.diffBase === "saved", `${cnt(sb.result?.total)} ${sb.ms} ms`);

const live = await rpc("analysis/openLive", { path: file, url });
check("openLive (L3)", !!live.result?.render, `${live.result?.render?.status} ${live.ms} ms ${live.error?.message ?? ""}`);

const bad = await rpc("nope/nope");
check("unknown method", bad.error?.code === -32601);

const st = fs.statSync(sock);
check("socket mode 0600", (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));

await rpc("server/shutdown");
await new Promise((r) => proc.once("exit", r));
check("shutdown removes socket", !fs.existsSync(sock));
console.log(`notifications: ${[...new Set(notes.map((n) => n.method))].join(", ")}`);
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
