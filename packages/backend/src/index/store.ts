// Persistent index storage: SQLite for rows and bitmaps, a content-addressed
// gzip blob store for trees, shells, stylesheet text and assets (§15).
//
// Revisions are immutable once published. A capture writes a new revision in
// status `building` and flips `meta.current_revision` in one transaction, so
// readers never see a half-written index.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export interface VariantInfo {
  id: number;
  name: string;
  profile: string;
  recipe?: string;
}

export interface PageRow {
  id: number;
  url: string;
  status: "ok" | "failed" | "removed";
  error?: string;
  template?: string;
  quirks: boolean;
  lang?: string;
  /** Blob hashes per variant id. */
  trees: Record<number, string>;
  shells: Record<number, string>;
  /** URL → asset blob hash, for replaying the page's subresources (L2). */
  assets: Record<string, string>;
  /** Shell box agreement on the fidelity sample (0..1), when checked. */
  fidelity?: number;
  capturedAt: string;
}

export interface RevisionRow {
  id: number;
  status: "building" | "ready" | "failed";
  createdAt: string;
  pageCount: number;
  variants: VariantInfo[];
  source: string;
  notes: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS index_revision (
  id INTEGER PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL,
  page_count INTEGER NOT NULL, variants TEXT NOT NULL, source TEXT NOT NULL, notes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS page (
  rev INTEGER NOT NULL, id INTEGER NOT NULL, url TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (rev, id));
CREATE TABLE IF NOT EXISTS stylesheet (
  rev INTEGER NOT NULL, url TEXT NOT NULL, content_hash TEXT, pages BLOB NOT NULL,
  PRIMARY KEY (rev, url));
CREATE TABLE IF NOT EXISTS token_posting (
  rev INTEGER NOT NULL, token TEXT NOT NULL, runtime INTEGER NOT NULL, pages BLOB NOT NULL,
  PRIMARY KEY (rev, runtime, token));
CREATE TABLE IF NOT EXISTS usage_posting (
  rev INTEGER NOT NULL, key TEXT NOT NULL, pages BLOB NOT NULL, PRIMARY KEY (rev, key));
CREATE TABLE IF NOT EXISTS selector_match (
  rev INTEGER NOT NULL, key TEXT NOT NULL, by_variant BLOB NOT NULL, evaluated BLOB NOT NULL,
  rejected BLOB, PRIMARY KEY (rev, key));
CREATE TABLE IF NOT EXISTS matcher_check (
  rev INTEGER NOT NULL, feature TEXT NOT NULL, agree INTEGER NOT NULL, disagree INTEGER NOT NULL,
  example TEXT, PRIMARY KEY (rev, feature));
`;

/** Reads a blob without a Store (worker threads don't open SQLite). */
export function readBlob(blobDir: string, hash: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`bad blob hash: ${hash}`);
  return gunzipSync(readFileSync(join(blobDir, hash.slice(0, 2), hash)));
}

export class Store {
  readonly db: Database.Database;
  readonly blobDir: string;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, "index.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- blobs ----

  putBlob(data: Buffer | string): string {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    const hash = createHash("sha256").update(buf).digest("hex");
    const dir = join(this.blobDir, hash.slice(0, 2));
    const file = join(dir, hash);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, gzipSync(buf, { level: 6 }));
      renameSync(tmp, file);
    }
    return hash;
  }

  getBlob(hash: string): Buffer {
    return readBlob(this.blobDir, hash);
  }

  hasBlob(hash: string): boolean {
    return existsSync(join(this.blobDir, hash.slice(0, 2), hash));
  }

  // ---- meta / revisions ----

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  currentRevision(): RevisionRow | undefined {
    const id = this.getMeta("current_revision");
    return id ? this.revision(Number(id)) : undefined;
  }

  revision(id: number): RevisionRow | undefined {
    const r = this.db.prepare("SELECT * FROM index_revision WHERE id = ?").get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      pageCount: r.page_count,
      variants: JSON.parse(r.variants),
      source: r.source,
      notes: JSON.parse(r.notes),
    };
  }

  createRevision(source: string, variants: VariantInfo[]): number {
    const next = ((this.db.prepare("SELECT MAX(id) AS m FROM index_revision").get() as any).m ?? 0) + 1;
    this.db
      .prepare("INSERT INTO index_revision (id, status, created_at, page_count, variants, source, notes) VALUES (?, 'building', ?, 0, ?, ?, '{}')")
      .run(next, new Date().toISOString(), JSON.stringify(variants), source);
    return next;
  }

  /** Atomically marks a revision ready and makes it current. */
  publishRevision(id: number, pageCount: number, notes: Record<string, unknown>): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE index_revision SET status = 'ready', page_count = ?, notes = ? WHERE id = ?")
        .run(pageCount, JSON.stringify(notes), id);
      this.setMeta("current_revision", String(id));
    })();
  }

  failRevision(id: number, error: string): void {
    this.db.prepare("UPDATE index_revision SET status = 'failed', notes = ? WHERE id = ?").run(JSON.stringify({ error }), id);
  }

  /** Drops rows of all revisions except the current one and `keep`. */
  pruneRevisions(keep: number[]): void {
    const cur = Number(this.getMeta("current_revision") ?? 0);
    const ids = [...new Set([cur, ...keep])].filter(Boolean);
    const list = ids.join(",") || "0";
    this.db.transaction(() => {
      for (const t of ["page", "stylesheet", "token_posting", "usage_posting", "selector_match", "matcher_check"]) {
        this.db.exec(`DELETE FROM ${t} WHERE rev NOT IN (${list})`);
      }
      this.db.exec(`DELETE FROM index_revision WHERE id NOT IN (${list})`);
    })();
  }

  // ---- rows ----

  pages(rev: number): PageRow[] {
    return (this.db.prepare("SELECT data FROM page WHERE rev = ? ORDER BY id").all(rev) as any[]).map((r) => JSON.parse(r.data));
  }
}
