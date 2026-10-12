#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/daemon/session.js";

// Parse CLI flags
const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const workspace = path.resolve(getArg("--workspace", "/tmp/cbr-ws"));
const dataDir = path.resolve(getArg("--data", "/tmp/cbr-data"));

// Validate workspace and captured index
const hasWorkspace = fs.existsSync(workspace);
const hasData = fs.existsSync(dataDir) && fs.existsSync(path.join(dataDir, "index.sqlite"));

if (!hasWorkspace || !hasData) {
  console.error("Benchmark prerequisites missing!");
  console.error(`  --workspace: ${workspace} (${hasWorkspace ? "found" : "NOT FOUND"})`);
  console.error(`  --data:      ${dataDir} (${hasData ? "found" : "NOT FOUND"})`);
  console.error("\nTo generate the fixture site and capture it, run:");
  console.error(`  node fixtures/generate-large-site.mjs /tmp/cbr-ws`);
  console.error(`  npx tsx src/cli.ts capture --workspace /tmp/cbr-ws --data /tmp/cbr-data`);
  process.exit(1);
}

console.log("=== CSS Blast Radius Performance Benchmark ===");
console.log(`Workspace: ${workspace}`);
console.log(`Data Dir:  ${dataDir}`);

const session = await Session.create({
  workspaceRoot: workspace,
  dataDir,
  watch: false,
  l1Workers: 2,
});

const status = session.status();
console.log(`Index Revision: ${status.indexRevision}, Total Pages: ${status.pages} (OK: ${status.okPages})\n`);

const compFile = path.join(workspace, "css", "components.css");
if (!fs.existsSync(compFile)) {
  console.error(`Stylesheet not found: ${compFile}`);
  await session.dispose();
  process.exit(1);
}

const baseText = fs.readFileSync(compFile, "utf8");
let version = 1;

// Open document
await session.open(compFile, baseText, version);

// Warm-up run
for (let i = 0; i < 5; i++) {
  const dummy = baseText.replace(".promo-banner {", `.promo-banner {\n  margin-top: ${i}px;`);
  await session.change(compFile, ++version, [{ text: dummy }]);
}

// -------------------------------------------------------------
// 1. Measure L0 keystroke latency (≥200 simulated keystrokes)
// -------------------------------------------------------------
console.log("Measuring warm L0 keystroke latency (210 keystrokes)...");
const l0Times: number[] = [];

// Edit 1: 70 simulated keystrokes editing declarations in .promo-banner
for (let k = 0; k < 70; k++) {
  const text = baseText.replace(".promo-banner {", `.promo-banner {\n  margin-top: ${k}px;\n  padding: ${10 + (k % 20)}px;`);
  const t0 = performance.now();
  await session.change(compFile, ++version, [{ text }]);
  const ms = performance.now() - t0;
  l0Times.push(ms);
}

// Edit 2: 70 simulated keystrokes editing declarations in .card
for (let k = 0; k < 70; k++) {
  const text = baseText.replace(".card {", `.card {\n  box-shadow: 0 0 ${k % 15}px rgba(0, 0, 0, 0.1);\n  border-radius: ${k % 8}px;`);
  const t0 = performance.now();
  await session.change(compFile, ++version, [{ text }]);
  const ms = performance.now() - t0;
  l0Times.push(ms);
}

// Edit 3: 70 simulated keystrokes editing color & variables in .button / .dropdown
for (let k = 0; k < 70; k++) {
  const text = baseText.replace(".dropdown {", `.dropdown {\n  outline: ${k % 4}px solid rgb(${k * 3 % 255}, 10, 20);`);
  const t0 = performance.now();
  await session.change(compFile, ++version, [{ text }]);
  const ms = performance.now() - t0;
  l0Times.push(ms);
}

// -------------------------------------------------------------
// 2. Measure L1 refinement latency (time from change to l1Idle)
// -------------------------------------------------------------
console.log("Measuring L1 refinement latency on complex selectors...");
const complexEdits = [
  ".promo-banner .card { outline: 1px solid red; }",
  ".card .price { color: red; }",
  "main > section:nth-child(2n+1) .card:has(img) { color: red; }",
  ".card:not(.card--featured) h3 { color: red; }",
  "html:lang(en) .promo-banner { color: red; }",
  "div.dropdown.is-open .dropdown__menu { color: red; }",
  "header.site-header > .container nav a { color: red; }",
  ".card .card__badge:first-child { color: red; }",
];

const l1Times: number[] = [];

// Repeat each complex edit 3 times to get multiple measurements
for (let cycle = 0; cycle < 3; cycle++) {
  for (const edit of complexEdits) {
    const text = baseText + `\n/* cycle ${cycle} */\n` + edit + "\n";
    const t0 = performance.now();
    await session.change(compFile, ++version, [{ text }]);
    await session.l1Idle(15_000);
    const ms = performance.now() - t0;
    l1Times.push(ms);
  }
}

// -------------------------------------------------------------
// Calculate statistics
// -------------------------------------------------------------
function stats(arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const p50 = s[Math.floor(n * 0.50)];
  const p95 = s[Math.floor(n * 0.95)];
  const max = s[n - 1];
  const min = s[0];
  const mean = s.reduce((a, b) => a + b, 0) / n;
  return { n, p50, p95, max, min, mean };
}

const l0 = stats(l0Times);
const l1 = stats(l1Times);

console.log("\n=================== BENCHMARK RESULTS ===================");
console.log(`L0 Keystroke Latency (${l0.n} samples):`);
console.log(`  p50:  ${l0.p50.toFixed(2)} ms`);
console.log(`  p95:  ${l0.p95.toFixed(2)} ms`);
console.log(`  max:  ${l0.max.toFixed(2)} ms`);
console.log(`  Gate: p95 <= 100.00 ms -> ${l0.p95 <= 100 ? "PASS ✓" : "FAIL ✗"}`);

console.log(`\nL1 Refinement Latency (${l1.n} samples):`);
console.log(`  p50:  ${l1.p50.toFixed(2)} ms`);
console.log(`  p95:  ${l1.p95.toFixed(2)} ms`);
console.log(`  max:  ${l1.max.toFixed(2)} ms`);
console.log(`  Gate: p95 <= 250.00 ms -> ${l1.p95 <= 250 ? "PASS ✓" : "FAIL ✗"}`);
console.log("=========================================================\n");

await session.dispose();

const l0Passed = l0.p95 <= 100;
const l1Passed = l1.p95 <= 250;

if (!l0Passed || !l1Passed) {
  console.error("Benchmark gates failed!");
  process.exit(1);
} else {
  console.log("All performance gates PASSED!");
  process.exit(0);
}
