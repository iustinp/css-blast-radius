// SQLite-backed persistence for index status/revision metadata.
//
// MVP scope note: this does not (yet) persist full rule_usage/posting/
// element_hit tables per the architecture doc's data model — live queries
// are answered from the in-memory corpus (see crawl/crawler.ts) for
// correctness at demo scale. This store exists to make `index/getStatus`
// durable across daemon restarts and to give the schema a concrete,
// migratable home once on-disk postings are needed for large corpora.

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export interface IndexRevisionRow {
  id: string;
  repo_root: string;
  built_at: number;
  page_count: number;
  css_file_count: number;
  cluster_count: number;
  schema_version: number;
}

const SCHEMA_VERSION = 1;

export class IndexStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_revision (
        id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        built_at INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        css_file_count INTEGER NOT NULL,
        cluster_count INTEGER NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS page (
        index_revision_id TEXT NOT NULL,
        url TEXT NOT NULL,
        file_path TEXT NOT NULL,
        skeleton_hash TEXT NOT NULL,
        cluster_id TEXT NOT NULL,
        has_shadow INTEGER NOT NULL,
        has_iframe INTEGER NOT NULL,
        FOREIGN KEY (index_revision_id) REFERENCES index_revision(id)
      );
    `);
  }

  recordRevision(row: Omit<IndexRevisionRow, "schema_version">, pages: Array<{
    url: string;
    filePath: string;
    skeletonHash: string;
    clusterId: string;
    hasShadow: boolean;
    hasIframe: boolean;
  }>) {
    const insertRevision = this.db.prepare(
      `INSERT INTO index_revision (id, repo_root, built_at, page_count, css_file_count, cluster_count, schema_version)
       VALUES (@id, @repo_root, @built_at, @page_count, @css_file_count, @cluster_count, @schema_version)`,
    );
    const insertPage = this.db.prepare(
      `INSERT INTO page (index_revision_id, url, file_path, skeleton_hash, cluster_id, has_shadow, has_iframe)
       VALUES (@index_revision_id, @url, @file_path, @skeleton_hash, @cluster_id, @has_shadow, @has_iframe)`,
    );

    const tx = this.db.transaction(() => {
      insertRevision.run({ ...row, schema_version: SCHEMA_VERSION });
      for (const p of pages) {
        insertPage.run({
          index_revision_id: row.id,
          url: p.url,
          file_path: p.filePath,
          skeleton_hash: p.skeletonHash,
          cluster_id: p.clusterId,
          has_shadow: p.hasShadow ? 1 : 0,
          has_iframe: p.hasIframe ? 1 : 0,
        });
      }
    });
    tx();
  }

  latestRevision(): IndexRevisionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM index_revision ORDER BY built_at DESC LIMIT 1`)
      .get() as IndexRevisionRow | undefined;
  }

  close() {
    this.db.close();
  }
}
