// JSON-RPC 2.0 server over a Unix domain socket (Windows: named pipe path
// via node:net, which supports \\.\pipe\ paths transparently). Framing is
// NDJSON: one JSON value per line.

import net, { type Socket } from "node:net";
import fs from "node:fs";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  SERVICE_VERSION,
  SCHEMA_VERSION,
  type JsonRpcRequest,
  type JsonRpcNotification,
} from "./protocol.js";
import { WorkspaceSession } from "../daemon/session.js";
import { IndexStore } from "../store/db.js";
import path from "node:path";

export interface DaemonOptions {
  socketPath: string;
  siteRoot: string;
  dbPath?: string;
}

function send(socket: Socket, message: unknown) {
  socket.write(JSON.stringify(message) + "\n");
}

export async function startDaemon(opts: DaemonOptions): Promise<net.Server> {
  const session = new WorkspaceSession(opts.siteRoot);
  const store = new IndexStore(opts.dbPath ?? path.join(opts.siteRoot, ".css-blast-radius", "index.sqlite"));

  const clients = new Set<Socket>();

  session.on("publishImpact", (answer) => {
    for (const c of clients) send(c, { jsonrpc: "2.0", method: "analysis/publishImpact", params: answer });
  });
  session.on("statusChanged", (status) => {
    for (const c of clients) send(c, { jsonrpc: "2.0", method: "index/statusChanged", params: status });
  });

  await session.attach();
  store.recordRevision(
    {
      id: `rev-${session.corpus.builtAt}`,
      repo_root: opts.siteRoot,
      built_at: session.corpus.builtAt,
      page_count: session.corpus.pages.size,
      css_file_count: session.corpus.cssFiles.size,
      cluster_count: session.corpus.clusters.size,
    },
    [...session.corpus.pages.values()].map((p) => ({
      url: p.url,
      filePath: p.filePath,
      skeletonHash: p.skeletonHash,
      clusterId: session.corpus.clusters.get(p.skeletonHash)!.id,
      hasShadow: p.hasShadowDomHint,
      hasIframe: p.hasIframe,
    })),
  );

  if (fs.existsSync(opts.socketPath)) fs.unlinkSync(opts.socketPath);
  fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true });

  const server = net.createServer((socket) => {
    clients.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        void handleMessage(line);
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));

    async function handleMessage(line: string) {
      let msg: JsonRpcRequest | JsonRpcNotification;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const isRequest = "id" in msg;
      try {
        const result = await dispatch(msg.method, msg.params);
        if (isRequest) send(socket, { jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result });
      } catch (err: any) {
        if (isRequest) {
          send(socket, {
            jsonrpc: "2.0",
            id: (msg as JsonRpcRequest).id,
            error: { code: -32000, message: String(err?.message ?? err) },
          });
        }
      }
    }
  });

  async function dispatch(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinor: PROTOCOL_MINOR,
          serviceVersion: SERVICE_VERSION,
          schemaVersion: SCHEMA_VERSION,
          capabilities: ["analysis/queryImpacts", "analysis/verifyExactly", "analysis/getDrilldown"],
          workspaceMode: "local",
          repoIdentity: opts.siteRoot,
          baseIndexRevision: store.latestRevision()?.id ?? null,
          health: "READY",
        };
      case "workspace/attach":
        return session.status();
      case "document/open":
        await session.documentOpen(params.path, params.content);
        return { ok: true };
      case "document/change":
        return session.documentChange(params.path, params.content);
      case "document/save":
        session.documentSave(params.path, params.content);
        return { ok: true };
      case "document/close":
        session.documentClose(params.path);
        return { ok: true };
      case "analysis/queryImpacts":
        return session.documentChange(params.path, params.content);
      case "index/getStatus":
        return session.status();
      case "server/health":
        return { health: "READY" };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  server.listen(opts.socketPath);
  return server;
}
