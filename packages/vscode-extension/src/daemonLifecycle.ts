// Daemon lifecycle: locate/launch a local daemon process for the current
// workspace, attach over its Unix socket / named pipe, retry with backoff
// if the daemon isn't up yet or dies, and surface a single top-level health
// status rather than per-file errors (see architecture doc "Daemon lifecycle").

import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { DaemonClient } from "./daemonClient.js";

export type HealthState = "STARTING" | "READY" | "DEGRADED" | "BLOCKED";

export class DaemonLifecycle implements vscode.Disposable {
  readonly client = new DaemonClient();
  private proc?: cp.ChildProcess;
  private health: HealthState = "STARTING";
  private readonly output: vscode.OutputChannel;
  private readonly statusItem: vscode.StatusBarItem;
  private retryDelayMs = 500;
  private disposed = false;
  private healthChangeHandlers = new Set<(h: HealthState) => void>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly siteRoot: string,
  ) {
    this.output = vscode.window.createOutputChannel("CSS Blast Radius");
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.show();
    this.setHealth("STARTING");
  }

  onHealthChange(handler: (h: HealthState) => void): void {
    this.healthChangeHandlers.add(handler);
  }

  private setHealth(h: HealthState, detail?: string) {
    this.health = h;
    const icons: Record<HealthState, string> = {
      STARTING: "$(sync~spin)",
      READY: "$(check)",
      DEGRADED: "$(warning)",
      BLOCKED: "$(error)",
    };
    this.statusItem.text = `${icons[h]} CSS Blast Radius`;
    this.statusItem.tooltip = detail ?? h;
    for (const handler of this.healthChangeHandlers) handler(h);
  }

  private socketPath(): string {
    const hash = Buffer.from(this.workspaceRoot).toString("base64url").slice(0, 24);
    return process.platform === "win32"
      ? `\\\\.\\pipe\\css-blast-radius-${hash}`
      : path.join(os.tmpdir(), `css-blast-radius-${hash}.sock`);
  }

  private resolveDaemonEntry(): string {
    const configured = vscode.workspace.getConfiguration("cssBlastRadius").get<string>("daemonPath");
    if (configured) return configured;
    // Dev/monorepo default: the backend package built alongside this extension.
    return path.resolve(__dirname, "../../backend/dist/cli.js");
  }

  async start(): Promise<void> {
    const socketPath = this.socketPath();
    const attached = await this.tryAttach(socketPath);
    if (attached) return;

    const entry = this.resolveDaemonEntry();
    if (!fs.existsSync(entry)) {
      this.setHealth("BLOCKED", `Daemon entry not found: ${entry}. Set cssBlastRadius.daemonPath.`);
      this.output.appendLine(`[lifecycle] daemon entry missing: ${entry}`);
      return;
    }

    this.output.appendLine(`[lifecycle] launching daemon: node ${entry} --root ${this.siteRoot} --socket ${socketPath}`);
    this.proc = cp.spawn(process.execPath, [entry, "--root", this.siteRoot, "--socket", socketPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (d) => this.output.append(d.toString()));
    this.proc.stderr?.on("data", (d) => this.output.append(d.toString()));
    this.proc.on("exit", (code) => {
      this.output.appendLine(`[lifecycle] daemon exited with code ${code}`);
      if (!this.disposed) this.scheduleReconnect(socketPath);
    });

    await this.retryAttach(socketPath);
  }

  private async retryAttach(socketPath: string, attempt = 0): Promise<void> {
    if (this.disposed) return;
    const ok = await this.tryAttach(socketPath);
    if (ok) return;
    if (attempt > 10) {
      this.setHealth("BLOCKED", "Daemon did not become reachable after repeated attempts.");
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** attempt, 3000)));
    return this.retryAttach(socketPath, attempt + 1);
  }

  private scheduleReconnect(socketPath: string) {
    this.setHealth("DEGRADED", "Daemon disconnected; retrying...");
    setTimeout(() => {
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5000);
      void this.start();
    }, this.retryDelayMs);
  }

  private async tryAttach(socketPath: string): Promise<boolean> {
    try {
      await this.client.connect(socketPath, 1500);
    } catch {
      return false;
    }
    this.client.onClose(() => {
      if (!this.disposed) this.scheduleReconnect(socketPath);
    });
    try {
      const init = await this.client.call<any>("initialize", {});
      if (init.protocolMajor !== 1) {
        this.setHealth("BLOCKED", `Incompatible daemon protocol major version ${init.protocolMajor}`);
        return false;
      }
      this.retryDelayMs = 500;
      this.setHealth("READY", `Attached: ${init.baseIndexRevision ?? "no index yet"}`);
      return true;
    } catch (err: any) {
      this.setHealth("BLOCKED", String(err?.message ?? err));
      return false;
    }
  }

  getHealth(): HealthState {
    return this.health;
  }

  dispose(): void {
    this.disposed = true;
    this.client.dispose();
    this.proc?.kill();
    this.statusItem.dispose();
    this.output.dispose();
  }
}
