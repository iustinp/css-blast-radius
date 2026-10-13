// JSON-RPC 2.0 over the server's HTTP-upgraded NDJSON socket.

import * as http from "node:http";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { serverOrigin } from "./urls";

export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout };

export class DaemonClient {
  private socket?: net.Socket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<(method: string, params: any) => void>();
  private readonly closedHandlers = new Set<() => void>();

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  connect(serverUrl: string, timeoutMs = 2000): Promise<void> {
    const url = serverOrigin(serverUrl);
    this.dispose();
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: url.hostname,
        port: url.port || 80,
        path: "/rpc",
        headers: { Connection: "Upgrade", Upgrade: "cbr-rpc" },
      });
      const timer = setTimeout(() => req.destroy(new Error("Server connection timed out")), timeoutMs);
      const fail = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      req.once("error", fail);
      req.once("response", (res) => {
        res.resume();
        req.destroy();
        fail(new Error(`Server did not upgrade the connection (HTTP ${res.statusCode})`));
      });
      req.once("upgrade", (res, socket, head) => {
        clearTimeout(timer);
        if (res.statusCode !== 101 || res.headers.upgrade?.toLowerCase() !== "cbr-rpc") {
          socket.destroy();
          reject(new Error("Server returned an unexpected upgrade response"));
          return;
        }
        this.socket = socket;
        this.buffer = "";
        const decoder = new StringDecoder("utf8");
        socket.on("data", (chunk: Buffer) => this.handleData(decoder.write(chunk)));
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
          if (this.socket !== socket) return;
          this.socket = undefined;
          this.failPending(new Error("Server connection closed"));
          for (const h of this.closedHandlers) h();
        });
        if (head.length) this.handleData(decoder.write(head));
        resolve();
      });
      req.end();
    });
  }

  onNotification(handler: (method: string, params: any) => void): void {
    this.notificationHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closedHandlers.add(handler);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcCallError(msg.error.code, msg.error.message ?? "Server error", msg.error.data));
        else p.resolve(msg.result);
      } else if (typeof msg.method === "string") {
        for (const h of this.notificationHandlers) h(msg.method, msg.params);
      }
    }
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("Not connected to the server"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  dispose(): void {
    const s = this.socket;
    this.socket = undefined;
    s?.destroy();
    this.failPending(new Error("Server connection closed"));
  }
}
