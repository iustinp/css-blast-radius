import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net, { type Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, type Daemon } from "../src/rpc/server.js";
import { ERR } from "../src/rpc/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSiteDir = path.resolve(__dirname, "../../../fixtures/site");

describe("RPC server and daemon socket protocol (§10.4, §11)", () => {
  let tempDir: string;
  let ws: string;
  let socketPath: string;
  let daemon: Daemon;
  let client: Socket;
  let clientBuffer = "";
  let reqId = 0;
  const pendingRequests = new Map<number, (res: any) => void>();

  function sendRpc(method: string, params?: unknown): Promise<any> {
    const id = ++reqId;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve) => {
      pendingRequests.set(id, resolve);
      client.write(JSON.stringify(msg) + "\n");
    });
  }

  function sendRaw(text: string): Promise<any> {
    return new Promise((resolve) => {
      // For malformed json or notifications without id, listen to next response
      const handler = (data: any) => {
        resolve(data);
      };
      pendingRequests.set(-999, handler);
      client.write(text + "\n");
    });
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbr-rpc-"));
    ws = path.join(tempDir, "site");
    fs.cpSync(fixtureSiteDir, ws, { recursive: true });

    // Keep socket path short (macOS domain socket limit is ~104 chars)
    socketPath = path.join(tempDir, "s.sock");

    daemon = await startDaemon({
      workspaceRoot: ws,
      socketPath,
      watch: false,
      l1Workers: 0,
    });

    client = net.connect(socketPath);
    await new Promise((r) => client.once("connect", r));

    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      clientBuffer += chunk;
      let idx: number;
      while ((idx = clientBuffer.indexOf("\n")) >= 0) {
        const line = clientBuffer.slice(0, idx);
        clientBuffer = clientBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null && pendingRequests.has(msg.id)) {
          const fn = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          fn(msg);
        } else if (pendingRequests.has(-999)) {
          const fn = pendingRequests.get(-999)!;
          pendingRequests.delete(-999);
          fn(msg);
        }
      }
    });
  });

  afterAll(async () => {
    if (client && !client.destroyed) {
      client.destroy();
    }
    if (daemon) {
      await daemon.close();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates socket file with mode 0600", () => {
    expect(fs.existsSync(socketPath)).toBe(true);
    const stat = fs.statSync(socketPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("handles initialize request and returns protocolMajor 1", async () => {
    const res = await sendRpc("initialize", {});
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
    expect(res.result.protocolMajor).toBe(1);
    expect(res.result.serviceVersion).toBeDefined();
    expect(res.result.capabilities).toBeDefined();
    expect(res.result.capabilities.levels).toEqual([0, 1, 2, 3]);
  });

  it("handles document/open and document/change over NDJSON", async () => {
    const mainCss = path.join(ws, "css", "main.css");
    const text = fs.readFileSync(mainCss, "utf8");

    // document/open
    const openRes = await sendRpc("document/open", { path: mainCss, text, version: 1 });
    expect(openRes.error).toBeUndefined();
    expect(openRes.result).toBeDefined();
    expect(openRes.result.answer).toBeDefined();
    expect(openRes.result.answer.file).toBe(mainCss);
    expect(openRes.result.session).toBeDefined();

    // document/change
    const changedText = text + "\n.rpc-added { color: red; }\n";
    const changeRes = await sendRpc("document/change", {
      path: mainCss,
      version: 2,
      changes: [{ text: changedText }],
    });
    expect(changeRes.error).toBeUndefined();
    expect(changeRes.result).toBeDefined();
    expect(changeRes.result.answer.editRevision).toBeGreaterThan(openRes.result.answer.editRevision);
  });

  it("returns -32601 (method not found) for unknown methods", async () => {
    const res = await sendRpc("unknown/nonexistentMethod", { foo: "bar" });
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(ERR.methodNotFound); // -32601
    expect(res.error.message).toContain("unknown method");
  });

  it("returns -32700 (parse error) for malformed JSON line", async () => {
    const res = await sendRaw("{ malformed json line without quotes }");
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(ERR.parse); // -32700
    expect(res.error.message).toBe("parse error");
  });

  it("rejects starting a second daemon on the same live socket", async () => {
    await expect(
      startDaemon({
        workspaceRoot: ws,
        socketPath,
        watch: false,
        l1Workers: 0,
      }),
    ).rejects.toThrow(/another daemon is listening/);
  });

  it("replaces a stale socket file when no listener is running", async () => {
    // Create a stale socket file (e.g. left behind by an ungracefully killed daemon)
    const staleSocketPath = path.join(tempDir, "stale.sock");
    fs.writeFileSync(staleSocketPath, "stale content");
    expect(fs.existsSync(staleSocketPath)).toBe(true);

    // Starting a daemon on this stale socket path must succeed and replace it
    const staleDaemon = await startDaemon({
      workspaceRoot: ws,
      socketPath: staleSocketPath,
      watch: false,
      l1Workers: 0,
    });
    expect(staleDaemon).toBeDefined();
    expect(fs.existsSync(staleSocketPath)).toBe(true);

    await staleDaemon.close();
    expect(fs.existsSync(staleSocketPath)).toBe(false);
  });

  it("daemon.close() unlinks the socket file and cleans up", async () => {
    client.destroy();
    await daemon.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
