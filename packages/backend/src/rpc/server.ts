// The per-workspace daemon: JSON-RPC 2.0 over a Unix domain socket (Windows:
// a named pipe path, which node:net handles transparently). Framing is NDJSON:
// one JSON value per line. The local server (server/http.ts) serves the same
// methods to many projects over one HTTP port.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { Session, type SessionOptions } from "../daemon/session.js";
import { DIFF_BASES } from "../daemon/diffBase.js";
import { ERR, PROTOCOL_MAJOR, PROTOCOL_MINOR, RpcError, SCHEMA_VERSION, SERVICE_VERSION, type InitializeResult } from "./protocol.js";
import { serveRpc, type RpcPeer } from "./connection.js";
import { SERIAL, SESSION_NOTIFICATIONS, sessionMethod } from "./methods.js";

export interface DaemonOptions extends SessionOptions {
  socketPath: string;
  log?: (msg: string) => void;
}

export interface Daemon {
  session: Session;
  server: net.Server;
  close(): Promise<void>;
}

async function socketInUse(p: string): Promise<boolean> {
  return new Promise((res) => {
    const c = net.connect(p);
    c.once("connect", () => {
      c.destroy();
      res(true);
    });
    c.once("error", () => res(false));
  });
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const log = opts.log ?? (() => {});
  const isPipe = opts.socketPath.startsWith("\\\\");
  if (!isPipe && fs.existsSync(opts.socketPath)) {
    if (await socketInUse(opts.socketPath)) throw new Error(`another daemon is listening on ${opts.socketPath}`);
    fs.unlinkSync(opts.socketPath);
  }
  if (!isPipe) fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true, mode: 0o700 });

  const session = await Session.create(opts);
  const clients = new Set<RpcPeer>();
  for (const [event, method] of SESSION_NOTIFICATIONS) session.on(event, (p) => clients.forEach((c) => c.notify(method, p)));

  let serial: Promise<unknown> = Promise.resolve();
  let closing = false;
  const started = Date.now();

  async function dispatch(method: string, p: any): Promise<unknown> {
    const handled = sessionMethod(session, method, p);
    if (handled) return handled;
    switch (method) {
      case "initialize": {
        const r: InitializeResult = {
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: PROTOCOL_MINOR,
          serviceVersion: SERVICE_VERSION,
          schemaVersion: SCHEMA_VERSION,
          mode: "local",
          repository: { workspaceRoot: session.cfg.workspaceRoot, siteRoot: session.cfg.siteRoot, baseUrl: session.cfg.baseUrl },
          capabilities: { levels: [0, 1, 2, 3], capture: true, diffBases: DIFF_BASES },
          status: session.status(),
        };
        return r;
      }
      case "server/health":
        return { health: session.status().health, uptimeMs: Date.now() - started, pid: process.pid };
      case "index/capture":
        return session.startCapture(p ?? {});
      case "server/shutdown":
        setImmediate(() => void daemon.close().then(() => process.exit(0)));
        return { ok: true };
      default:
        throw new RpcError(ERR.methodNotFound, `unknown method: ${method}`);
    }
  }

  const server = net.createServer((socket) => {
    const peer = serveRpc(socket, {
      dispatch,
      serialize: (method, run) => (SERIAL.has(method) ? (serial = serial.then(run, run)) : run()),
      log,
      onClose: (x) => clients.delete(x),
    });
    clients.add(peer);
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(opts.socketPath, () => {
      server.off("error", rej);
      res();
    });
  });
  if (!isPipe) fs.chmodSync(opts.socketPath, 0o600);

  const daemon: Daemon = {
    session,
    server,
    async close() {
      if (closing) return;
      closing = true;
      for (const c of clients) c.close();
      await new Promise<void>((r) => server.close(() => r()));
      await session.dispose();
      if (!isPipe && fs.existsSync(opts.socketPath)) fs.unlinkSync(opts.socketPath);
    },
  };
  return daemon;
}
