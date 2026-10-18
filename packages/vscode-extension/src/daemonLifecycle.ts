// A workspace session on the shared, long-lived local server.

import * as vscode from "vscode";
import * as cp from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DaemonClient } from "./daemonClient";
import { PROTOCOL_MAJOR, type InitializeResult } from "./protocol";
import { isLocalServer, serverOrigin } from "./urls";

/** The backend next to this extension (development), else the one recorded when the .vsix was packaged. */
function defaultServerPath(): string {
  const beside = path.resolve(__dirname, "../../backend/dist/cli.js");
  if (fs.existsSync(beside)) return beside;
  try {
    const stamped = JSON.parse(fs.readFileSync(path.join(__dirname, "server-path.json"), "utf8")).cli;
    if (typeof stamped === "string" && stamped) return stamped;
  } catch {
    /* not packaged */
  }
  return beside;
}

export type ConnectionState = "STARTING" | "CONNECTED" | "DISCONNECTED" | "FAILED";

export class DaemonLifecycle implements vscode.Disposable {
  readonly client = new DaemonClient();
  readonly output = vscode.window.createOutputChannel("CSS Blast Radius");
  state: ConnectionState = "STARTING";
  stateDetail = "";
  init?: InitializeResult;
  private disposed = false;
  private retryMs = 500;
  private reconnectTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private lastSpawn = 0;
  private readonly onAttachedEmitter = new vscode.EventEmitter<InitializeResult>();
  private readonly onStateEmitter = new vscode.EventEmitter<ConnectionState>();
  readonly onAttached = this.onAttachedEmitter.event;
  readonly onState = this.onStateEmitter.event;

  /** This window (a reload is a new one): the server starts a new "This session" for it. */
  private readonly windowId = randomUUID();

  constructor(private readonly workspaceRoot: string, private readonly linkedGroups: () => string[]) {
    this.client.onClose(() => {
      if (this.disposed) return;
      this.setState("DISCONNECTED", "Server disconnected; reconnecting…");
      this.scheduleReconnect();
    });
  }

  get serverUrl(): string {
    return this.init?.serverUrl || this.settings().server;
  }

  private setState(s: ConnectionState, detail = ""): void {
    this.state = s;
    this.stateDetail = detail;
    this.onStateEmitter.fire(s);
  }

  private settings() {
    const c = vscode.workspace.getConfiguration("cssBlastRadius", vscode.Uri.file(this.workspaceRoot));
    return {
      server: c.get<string>("server") || "http://127.0.0.1:4317",
      autoStart: c.get<boolean>("autoStartServer") ?? true,
      serverPath: c.get<string>("serverPath") || c.get<string>("daemonPath") || defaultServerPath(),
      nodePath: c.get<string>("nodePath") || "node",
    };
  }

  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.disposed || this.client.connected) return;
    this.setState("STARTING", "Connecting to the server…");
    const settings = this.settings();
    let url: URL;
    try {
      url = serverOrigin(settings.server);
    } catch (err: any) {
      this.setState("FAILED", err.message);
      return;
    }
    let error = await this.tryAttach(settings.server);
    if (!error) return;
    if (settings.autoStart && isLocalServer(url) && (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      if (Date.now() - this.lastSpawn > 15_000) {
        this.lastSpawn = Date.now();
        if (!fs.existsSync(settings.serverPath)) {
          const detail = `Server not found at ${settings.serverPath}. Run "npm run serve" in the css-blast-radius folder, or set CSS Blast Radius: Server Path.`;
          this.output.appendLine(detail);
          this.setState("FAILED", detail);
          this.scheduleReconnect();
          return;
        } else {
          this.output.appendLine(`Starting server: ${settings.nodePath} ${settings.serverPath} serve --port ${url.port || "80"}`);
          try {
            const proc = cp.spawn(settings.nodePath, [settings.serverPath, "serve", "--port", url.port || "80"], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
            });
            proc.on("error", (e) => this.output.appendLine(`Server start failed: ${e.message}`));
            proc.unref();
          } catch (e: any) {
            this.output.appendLine(`Server start failed: ${e?.message ?? e}`);
          }
        }
      }
      const until = Date.now() + 10_000;
      let delay = 100;
      while (!this.disposed && Date.now() < until) {
        await new Promise((r) => setTimeout(r, delay));
        error = await this.tryAttach(settings.server);
        if (!error) return;
        delay = Math.min(Math.round(delay * 1.5), 900);
      }
    }
    if (this.disposed) return;
    this.output.appendLine(`Server unavailable: ${error.message}`);
    this.setState("FAILED", `Server unavailable at ${settings.server}: ${error.message}`);
    this.scheduleReconnect();
  }

  private async tryAttach(server: string): Promise<Error | undefined> {
    try {
      await this.client.connect(server, 1500);
    } catch (err: any) {
      return err instanceof Error ? err : new Error(String(err));
    }
    if (this.disposed) {
      this.client.dispose();
      return new Error("Extension deactivated");
    }
    try {
      const init = await this.client.call<InitializeResult>("initialize", { workspaceRoot: this.workspaceRoot, client: "vscode", windowId: this.windowId, groups: this.linkedGroups() }, 10_000);
      if (init.protocolMajor !== PROTOCOL_MAJOR) throw new Error(`Incompatible server (protocol ${init.protocolMajor}, need ${PROTOCOL_MAJOR}).`);
      this.init = init;
      this.retryMs = 500;
      clearTimeout(this.reconnectTimer);
      this.setState("CONNECTED");
      this.output.appendLine(`Connected to ${server} (${init.serviceVersion})`);
      this.onAttachedEmitter.fire(init);
      return undefined;
    } catch (err: any) {
      this.output.appendLine(`Initialize failed: ${err?.message ?? err}`);
      this.client.dispose();
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
      void this.start();
    }, this.retryMs);
  }

  async reconnect(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    this.client.dispose();
    this.init = undefined;
    this.retryMs = 500;
    await this.start();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    this.client.dispose();
    this.onAttachedEmitter.dispose();
    this.onStateEmitter.dispose();
    this.output.dispose();
  }
}
