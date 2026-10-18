// Which page groups each editor project is linked to. Kept with the server's
// data (links.json, keyed by the project's folder), so nothing is written
// into the project itself.

import { join, resolve } from "node:path";
import { readJson, writeJson } from "./settings.js";

export class Links {
  private readonly file: string;
  private readonly projects: Record<string, string[]>;

  constructor(dataDir: string) {
    this.file = join(dataDir, "links.json");
    this.projects = readJson<{ projects?: Record<string, string[]> }>(this.file, {}).projects ?? {};
  }

  get(root: string): string[] {
    const ids = this.projects[resolve(root)];
    return Array.isArray(ids) ? ids.map(String) : [];
  }

  set(root: string, ids: string[]): void {
    const key = resolve(root);
    const next = [...new Set(ids.map(String))];
    if (next.length) this.projects[key] = next;
    else delete this.projects[key];
    writeJson(this.file, { projects: this.projects });
  }
}
