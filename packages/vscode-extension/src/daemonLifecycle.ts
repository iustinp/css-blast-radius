// Attach to the workspace's daemon or start one (§10.4); reconnect with backoff.

import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonClient } from "./daemonClient";
import { PROTOCOL_MAJOR, type IndexStatus, type InitializeResult } from "./protocol";

export type ConnectionState = "STARTING" | "CONNECTED" | "DISCONNECTED" | "FAILED";

/** Same default as the CLI (`defaultSocketPath`), so CLI-started daemons are found too. */
export function socketPathFor(workspaceRoot: string): string {
  const h = crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\css-blast-radius-${h}` : path.join(os.tmpdir(), `css-blast-radius-${h}.sock`);
}

export class DaemonLifecycle implements vscode.Disposable {
  readonly client = new DaemonClient();
  readonly output = vscode.window.createOutputChannel("CSS Blast Radius");
  state: ConnectionState = "STARTING";
  stateDetail = "";
  init?: InitializeResult;
  private proc?: cp.ChildProcess;
  private disposed = false;
  private retryMs = 500;
  private reconnectTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private readonly socketPath: string;
  private readonly onAttachedEmitter = new vscode.EventEmitter<InitializeResult>();
  private readonly onStateEmitter = new vscode.EventEmitter<ConnectionState>();
  /** Fired after every (re)connect: the daemon may be new, so documents must be re-opened. */
  readonly onAttached = this.onAttachedEmitter.event;
  readonly onState = this.onStateEmitter.event;

  constructor(private readonly workspaceRoot: string) {
    this.socketPath = socketPathFor(workspaceRoot);
    this.client.onClose(() => {
      if (this.disposed) return;
      this.setState("DISCONNECTED", "Daemon disconnected; reconnecting…");
      this.scheduleReconnect();
    });
  }

  private setState(s: ConnectionState, detail = ""): void {
    this.state = s;
    this.stateDetail = detail;
    this.onStateEmitter.fire(s);
  }

  private settings() {
    const c = vscode.workspace.getConfiguration("cssBlastRadius");
    return {
      daemonPath: c.get<string>("daemonPath") || path.resolve(__dirname, "../../backend/dist/cli.js"),
      nodePath: c.get<string>("nodePath") || "node",
      siteRoot: c.get<string>("siteRoot") || "",
      baseUrl: c.get<string>("baseUrl") || "",
      dataDir: c.get<string>("dataDir") || "",
      diffBase: c.get<string>("diffBase") || "",
    };
  }

  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.disposed) return;
    if (await this.tryAttach()) return;
    const s = this.settings();
    if (!fs.existsSync(s.daemonPath)) {
      this.setState("FAILED", `Daemon not found at ${s.daemonPath}. Build the backend or set cssBlastRadius.daemonPath.`);
      return;
    }
    const args = [s.daemonPath, "daemon", "--workspace", this.workspaceRoot, "--socket", this.socketPath, "--exit-with-parent"];
    if (s.siteRoot) args.push("--site", s.siteRoot);
    if (s.baseUrl) args.push("--base-url", s.baseUrl);
    if (s.dataDir) args.push("--data", s.dataDir);
    if (s.diffBase) args.push("--diff-base", s.diffBase);
    this.output.appendLine(`starting: ${s.nodePath} ${args.join(" ")}`);
    let spawnError: string | undefined;
    const proc = cp.spawn(s.nodePath, args, { cwd: this.workspaceRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    proc.stdout?.on("data", (d) => this.output.append(String(d)));
    proc.stderr?.on("data", (d) => this.output.append(String(d)));
    proc.on("error", (err) => {
      spawnError = `Couldn't start the daemon with “${s.nodePath}”: ${err.message}. Set cssBlastRadius.nodePath to a Node.js ≥ 20 binary.`;
      this.output.appendLine(spawnError);
    });
    proc.on("exit", (code) => {
      this.output.appendLine(`daemon exited (${code})`);
      if (this.proc === proc) this.proc = undefined;
    });
    for (let attempt = 0; attempt < 40 && !this.disposed; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(100 * 1.5 ** attempt, 1000)));
      if (spawnError) break;
      if (await this.tryAttach()) return;
      if (!this.proc) break;
    }
    this.setState("FAILED", spawnError ?? "The daemon didn't start; see the “CSS Blast Radius” output.");
  }

  private async tryAttach(): Promise<boolean> {
    try {
      await this.client.connect(this.socketPath, 1500);
    } catch {
      return false;
    }
    try {
      const init = await this.client.call<InitializeResult>("initialize", { client: "vscode" }, 10_000);
      if (init.protocolMajor !== PROTOCOL_MAJOR) {
        this.client.dispose();
        this.setState("FAILED", `Incompatible daemon (protocol ${init.protocolMajor}, need ${PROTOCOL_MAJOR}). Restart the daemon.`);
        return true;
      }
      this.init = init;
      this.retryMs = 500;
      this.setState("CONNECTED");
      this.onAttachedEmitter.fire(init);
      return true;
    } catch (err: any) {
      this.output.appendLine(`initialize failed: ${err?.message ?? err}`);
      this.client.dispose();
      return false;
    }
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
      void this.start();
    }, this.retryMs);
  }

  async restart(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    if (this.client.connected) await this.client.call("server/shutdown", undefined, 5000).catch(() => {});
    this.proc?.kill();
    this.proc = undefined;
    this.client.dispose();
    this.setState("STARTING");
    await new Promise((r) => setTimeout(r, 300));
    await this.start();
  }

  status(): IndexStatus | undefined {
    return this.init?.status;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    this.client.dispose();
    // Closing stdin ends a daemon started with --exit-with-parent.
    this.proc?.stdin?.end();
    this.onAttachedEmitter.dispose();
    this.onStateEmitter.dispose();
    this.output.dispose();
  }
}
