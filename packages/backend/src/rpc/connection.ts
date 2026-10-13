// One JSON-RPC 2.0 connection framed as NDJSON (one JSON value per line),
// over a Unix socket/named pipe (daemon) or an upgraded HTTP socket (server).

import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ERR, type JsonRpcNotification, type JsonRpcRequest } from "./protocol.js";

const MAX_LINE = 64 * 1024 * 1024;

export interface RpcPeer {
  notify(method: string, params: unknown): void;
  close(): void;
  readonly closed: boolean;
}

export interface ServeRpcOptions {
  /** Bytes already read past the HTTP upgrade request. */
  head?: Buffer;
  dispatch(method: string, params: any, peer: RpcPeer): Promise<unknown>;
  /** Runs state-changing methods in arrival order. */
  serialize?(method: string, run: () => Promise<unknown>): Promise<unknown>;
  log?(msg: string): void;
  onClose?(peer: RpcPeer): void;
}

export function serveRpc(socket: Duplex, opts: ServeRpcOptions): RpcPeer {
  const log = opts.log ?? (() => {});
  let closed = false;
  const send = (message: unknown) => {
    if (!closed && !socket.destroyed) socket.write(JSON.stringify(message) + "\n");
  };
  const peer: RpcPeer = {
    notify(method, params) {
      const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
      send(msg);
    },
    close() {
      socket.destroy();
    },
    get closed() {
      return closed;
    },
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    opts.onClose?.(peer);
  };

  let buffer = "";
  // One decoder for the whole stream: a character split across chunks stays whole.
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
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
  };

  function handle(line: string): void {
    let msg: JsonRpcRequest | JsonRpcNotification;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "parse error" } });
      return;
    }
    if (!msg || typeof msg.method !== "string") {
      send({ jsonrpc: "2.0", id: (msg as any)?.id ?? null, error: { code: ERR.invalidRequest, message: "invalid request" } });
      return;
    }
    const isRequest = "id" in msg && msg.id !== undefined && msg.id !== null;
    const run = () => opts.dispatch(msg.method, msg.params, peer);
    const p = opts.serialize ? opts.serialize(msg.method, run) : run();
    p.then(
      (result) => {
        if (isRequest) send({ jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result });
      },
      (err: any) => {
        const code = typeof err?.code === "number" ? err.code : ERR.internal;
        if (code === ERR.internal) log(`${msg.method} failed: ${err?.stack ?? err}`);
        if (isRequest) send({ jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, error: { code, message: String(err?.message ?? err), data: err?.data } });
      },
    );
  }

  socket.on("data", onData);
  socket.on("close", finish);
  socket.on("error", finish);
  if (opts.head?.length) onData(opts.head);
  return peer;
}
