// JSON-RPC 2.0 client over the daemon's Unix socket / named pipe (NDJSON).

import * as net from "node:net";

export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer?: NodeJS.Timeout };

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

  connect(socketPath: string, timeoutMs = 2000): Promise<void> {
    this.dispose();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`daemon connect timed out: ${socketPath}`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.buffer = "";
        resolve();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.handleData(chunk));
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.failPending(new Error("daemon connection closed"));
        for (const h of this.closedHandlers) h();
      });
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
        if (msg.error) p.reject(new RpcCallError(msg.error.code, msg.error.message ?? "daemon error", msg.error.data));
        else p.resolve(msg.result);
      } else if (typeof msg.method === "string") {
        for (const h of this.notificationHandlers) h(msg.method, msg.params);
      }
    }
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("not connected to the daemon"));
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
    this.failPending(new Error("daemon connection closed"));
  }
}
