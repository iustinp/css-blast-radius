#!/usr/bin/env node
import { startDaemon } from "./rpc/server.js";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

async function main() {
  const siteRoot = arg("root");
  const socketPath = arg("socket", "/tmp/css-blast-radius.sock")!;
  if (!siteRoot) {
    console.error("Usage: css-blast-radius-daemon --root <siteDir> [--socket <path>]");
    process.exit(1);
  }
  const server = await startDaemon({ siteRoot, socketPath });
  console.log(`[css-blast-radius] daemon listening on ${socketPath}, watching ${siteRoot}`);

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
