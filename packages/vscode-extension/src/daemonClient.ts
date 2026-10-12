// Thin JSON-RPC 2.0 client for the extension host <-> local daemon
// transport (Unix domain socket on macOS/Linux, named pipe on Windows).
// See packages/backend/src/rpc/protocol.ts for the wire format this mirrors.

import * as net from "node:net";

export type NotificationHandler = (method: string, params: unknown) => void;

export class DaemonClient {
  private socket?: net.Socket;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private notificationHandlers = new Set<NotificationHandler>();
  private closedHandlers = new Set<() => void>();

  connect(socketPath: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`daemon connect timed out: ${socketPath}`));
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("data", (chunk) => this.handleData(chunk));
      socket.on("close", () => {
        this.socket = undefined;
        for (const h of this.closedHandlers) h();
      });
    });
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closedHandlers.add(handler);
  }

  private handleData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
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
      if ("id" in msg) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if ("error" in msg) pending.reject(new Error(msg.error?.message ?? "daemon error"));
        else pending.resolve(msg.result);
      } else if ("method" in msg) {
        for (const h of this.notificationHandlers) h(msg.method, msg.params);
      }
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.socket) return Promise.reject(new Error("not connected to daemon"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  dispose(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
