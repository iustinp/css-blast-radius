#!/usr/bin/env node
// css-blast-radius CLI.
//
//   css-blast-radius daemon  --workspace <dir> [--socket <path>] [site options]
//   css-blast-radius capture --workspace <dir> [--urls /a.html,/b.html] [site options]
//   css-blast-radius impact  --workspace <dir> [--diff-base HEAD|saved|production] [--pages] [site options]
//
// Site options: --site <dir> (static site root), --base-url <url>, --data <dir>.
// Without a subcommand, `--root <dir>` starts the daemon (older extensions).

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "./rpc/server.js";
import { Session } from "./daemon/session.js";
import { DIFF_BASES, type DiffBaseKind } from "./daemon/diffBase.js";
import { loadConfig } from "./config.js";
import { Store } from "./index/store.js";
import { Capturer } from "./capture/capture.js";
import type { Count } from "./engine/contract.js";

const USAGE = `usage:
  css-blast-radius daemon  --workspace <dir> [--socket <path>] [--l1-workers <n>]
  css-blast-radius capture --workspace <dir> [--urls <path,...>] [--concurrency <n>]
  css-blast-radius impact  --workspace <dir> [--diff-base ${DIFF_BASES.join("|")}] [--pages]
site options: --site <dir>  --base-url <url>  --data <dir>`;

function parseArgs(argv: string[]): { cmd?: string; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  let cmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), "true");
    } else if (!cmd) cmd = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return { cmd, flags };
}

export function defaultSocketPath(workspaceRoot: string): string {
  const h = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\css-blast-radius-${h}` : path.join(os.tmpdir(), `css-blast-radius-${h}.sock`);
}

function fmt(c: Count): string {
  const parts = [`${c.exact} exact`];
  if (c.possible) parts.push(`${c.possible} possible`);
  if (c.unknown) parts.push(`${c.unknown} unknown`);
  return parts.join(", ");
}

async function main(): Promise<number> {
  const { cmd: rawCmd, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || rawCmd === "help") {
    console.log(USAGE);
    return 0;
  }
  const cmd = rawCmd ?? (flags.has("root") || flags.has("workspace") ? "daemon" : undefined);
  const workspaceRoot = path.resolve(flags.get("workspace") ?? flags.get("root") ?? process.cwd());
  const site = {
    siteRoot: flags.get("site"),
    baseUrl: flags.get("base-url"),
    dataDir: flags.get("data"),
  };
  const diffBase = flags.get("diff-base") as DiffBaseKind | undefined;
  if (diffBase && !DIFF_BASES.includes(diffBase)) throw new Error(`--diff-base must be one of ${DIFF_BASES.join(", ")}`);

  switch (cmd) {
    case "daemon": {
      const socketPath = flags.get("socket") ?? defaultSocketPath(workspaceRoot);
      const l1 = flags.get("l1-workers");
      const daemon = await startDaemon({
        workspaceRoot,
        ...site,
        diffBase,
        l1Workers: l1 === undefined ? undefined : Number(l1),
        socketPath,
        log: (m) => process.stderr.write(`[css-blast-radius] ${m}\n`),
      });
      const st = daemon.session.status();
      process.stderr.write(`[css-blast-radius] listening on ${socketPath} (${st.health}, ${st.pages} pages)\n`);
      const stop = () => void daemon.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // The extension owns the daemon: exit when it goes away.
      if (flags.has("exit-with-parent")) process.stdin.on("end", stop).resume();
      return new Promise<number>(() => {});
    }
    case "capture": {
      const cfg = loadConfig(workspaceRoot, site);
      const conc = flags.get("concurrency");
      if (conc) cfg.capture.concurrency = Number(conc);
      const store = new Store(cfg.dataDir);
      const urls = flags.get("urls")?.split(",").map((u) => u.trim()).filter(Boolean);
      const res = await new Capturer(cfg, store).run({
        urls,
        onProgress: (p) => {
          if (!p.ok) process.stderr.write(`failed: ${p.url}\n`);
          if (p.done === p.total || p.done % 50 === 0) process.stderr.write(`${p.done}/${p.total}\n`);
        },
      });
      store.close();
      console.log(`revision ${res.revision}: ${res.pages} pages (${res.captured} captured, ${res.failed} failed) in ${(res.durationMs / 1000).toFixed(1)} s → ${cfg.dataDir}`);
      return res.failed ? 2 : 0;
    }
    case "impact": {
      const session = await Session.create({ workspaceRoot, ...site, diffBase, watch: false, l1Workers: 0 });
      try {
        const st = session.status();
        if (!st.ready) {
          console.error(`no index: run \`css-blast-radius capture --workspace ${workspaceRoot}\` first`);
          return 3;
        }
        await session.l1Idle(30_000);
        const total = session.sessionTotal();
        if (!total.files.length) {
          console.log(`no CSS changes vs ${total.diffBase}`);
          return 0;
        }
        for (const f of total.files) console.log(`${f.file}: ${fmt(f.pages)} (${f.changes} changes)`);
        console.log(`total: ${fmt(total.total)} of ${st.pages} pages vs ${total.diffBase}${total.reasons.length ? ` — ${total.reasons.join("; ")}` : ""}`);
        if (flags.has("pages")) {
          const pages = await session.getPages({ limit: 100_000 });
          for (const p of pages.pages) console.log(`  ${p.set.padEnd(8)} ${p.url}`);
        }
        return 0;
      } finally {
        await session.dispose();
      }
    }
    default:
      console.error(USAGE);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  },
);
