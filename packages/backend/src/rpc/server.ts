// JSON-RPC 2.0 over a Unix domain socket (Windows: a named pipe path, which
// node:net handles transparently). Framing is NDJSON: one JSON value per line.

import net, { type Socket } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { Session, type SessionOptions } from "../daemon/session.js";
import { DIFF_BASES } from "../daemon/diffBase.js";
import {
  ERR,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  RpcError,
  SCHEMA_VERSION,
  SERVICE_VERSION,
  type InitializeResult,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./protocol.js";

export interface DaemonOptions extends SessionOptions {
  socketPath: string;
  log?: (msg: string) => void;
}

export interface Daemon {
  session: Session;
  server: net.Server;
  close(): Promise<void>;
}

const MAX_LINE = 64 * 1024 * 1024;

/** Methods that change document/session state run strictly in arrival order. */
const SERIAL = new Set(["document/open", "document/change", "document/save", "document/close", "session/setDiffBase"]);

function send(socket: Socket, message: unknown): void {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
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
  const clients = new Set<Socket>();
  const notify = (method: string, params: unknown) => {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    for (const c of clients) send(c, msg);
  };
  session.on("refined", (p) => notify("analysis/refined", p));
  session.on("publish", (p) => notify("analysis/publishImpact", p));
  session.on("status", (p) => notify("index/statusChanged", p));
  session.on("revision", (p) => notify("index/revisionSwitched", p));
  session.on("captureProgress", (p) => notify("index/captureProgress", p));
  session.on("degraded", (p) => notify("server/degraded", p));

  let serial: Promise<unknown> = Promise.resolve();
  let closing = false;
  const started = Date.now();

  async function dispatch(method: string, p: any): Promise<unknown> {
    const need = (k: string) => {
      if (p?.[k] === undefined) throw new RpcError(ERR.invalidParams, `missing parameter: ${k}`);
      return p[k];
    };
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
      case "workspace/attach":
      case "index/getStatus":
        return session.status();
      case "server/health":
        return { health: session.status().health, uptimeMs: Date.now() - started, pid: process.pid };
      case "document/open":
        return session.open(need("path"), need("text"), p.version ?? 0);
      case "document/change":
        return session.change(need("path"), need("version"), need("changes"));
      case "document/save":
        return session.save(need("path"), p.text);
      case "document/close":
        return session.close(need("path"));
      case "session/setDiffBase":
        return session.setDiffBase(need("base"));
      case "analysis/queryImpacts":
        switch (p?.scope ?? "file") {
          case "session":
            return session.sessionTotal();
          case "rules":
            return session.ruleCounts(need("path"));
          case "file":
            return session.fileAnswer(need("path"));
          default:
            throw new RpcError(ERR.invalidParams, `unknown scope: ${p.scope}`);
        }
      case "analysis/getPages":
        return session.getPages(p ?? {});
      case "analysis/getDrilldown":
        need("path");
        need("url");
        return session.drilldown({ ...p, level: p.level === 2 ? 2 : 1 });
      case "analysis/openLive":
        need("path");
        need("url");
        return session.openLive(p);
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
    clients.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        log("client sent an oversized message; closing the connection");
        socket.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) handle(line);
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));

    function handle(line: string): void {
      let msg: JsonRpcRequest | JsonRpcNotification;
      try {
        msg = JSON.parse(line);
      } catch {
        send(socket, { jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "parse error" } });
        return;
      }
      if (!msg || typeof msg.method !== "string") {
        send(socket, { jsonrpc: "2.0", id: (msg as any)?.id ?? null, error: { code: ERR.invalidRequest, message: "invalid request" } });
        return;
      }
      const isRequest = "id" in msg && msg.id !== undefined && msg.id !== null;
      const run = () => dispatch(msg.method, msg.params);
      const p = SERIAL.has(msg.method) ? (serial = serial.then(run, run)) : run();
      p.then(
        (result) => {
          if (isRequest) send(socket, { jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result });
        },
        (err: any) => {
          const code = typeof err?.code === "number" ? err.code : ERR.internal;
          if (code === ERR.internal) log(`${msg.method} failed: ${err?.stack ?? err}`);
          if (isRequest) send(socket, { jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, error: { code, message: String(err?.message ?? err), data: err?.data } });
        },
      );
    }
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
      for (const c of clients) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await session.dispose();
      if (!isPipe && fs.existsSync(opts.socketPath)) fs.unlinkSync(opts.socketPath);
    },
  };
  return daemon;
}
