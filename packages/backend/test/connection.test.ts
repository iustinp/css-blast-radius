import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { serveRpc } from "../src/rpc/connection.js";

class Pipe extends Duplex {
  out = "";
  _read(): void {}
  _write(chunk: Buffer, _enc: string, done: () => void): void {
    this.out += chunk.toString("utf8");
    done();
  }
}

describe("serveRpc", () => {
  it("keeps a character split across the upgrade head and the next chunk", async () => {
    const socket = new Pipe();
    const seen: string[] = [];
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { text: ".a::before{content:'é→😀'}" } }) + "\n");
    const cut = bytes.indexOf(Buffer.from("😀")) + 2;
    serveRpc(socket, {
      head: bytes.subarray(0, cut),
      dispatch: async (_m, p) => {
        seen.push(p.text);
        return p.text;
      },
    });
    socket.push(bytes.subarray(cut));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([".a::before{content:'é→😀'}"]);
    expect(JSON.parse(socket.out).result).toBe(".a::before{content:'é→😀'}");
  });
});
