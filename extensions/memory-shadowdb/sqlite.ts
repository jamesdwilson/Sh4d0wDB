/**
 * sqlite.ts — SQLite backend for MemoryStore
 *
 * Implements all abstract methods from MemoryStore using:
 * - sqlite-vec for vector similarity search (cosine distance)
 * - FTS5 for full-text search (unicode61 tokenizer, BM25 ranked)
 * - FTS5 trigram for fuzzy/substring search (trigram tokenizer)
 * - Standard SQL for CRUD, soft-delete, and retention purge
 *
 * Dependencies:
 * - better-sqlite3: synchronous SQLite driver (fast, no async overhead)
 * - sqlite-vec: vector search extension (loaded at runtime)
 *
 * DESIGN NOTES:
 * - Single-file database: zero config, no server process
 * - Synchronous API wrapped in async for interface compatibility
 * - FTS5 via two shadow tables: _fts (word-level BM25) and _trigram (substring)
 * - Tags stored as JSON array (no native array type in SQLite)
 * - Timestamps stored as ISO 8601 TEXT (no native timestamp type)
 * - Vector embeddings stored in a separate vec0 virtual table
 *
 * SECURITY:
 * - All queries use parameterized SQL (? placeholders)
 * - Table name comes from config only (not user input)
 * - WAL mode for concurrent read safety
 */

import { MemoryStore, type RankedHit, type PrimerRow, type StoreConfig, type StoreLogger } from "./store.js";
import type { EmbeddingClient } from "./embedder.js";

// better-sqlite3 types
type Database = any;

/**
 * SQLite-backed memory store.
 *
 * Zero-config backend: single file, no server, no extensions to install
 * (sqlite-vec is loaded as a runtime extension if available).
 * FTS5 is built into SQLite. Trigram tokenizer provides substring/fuzzy matching.
 */
export class SQLiteStore extends MemoryStore {
  private db: Database = null;
  private dbPath: string;
  private hasVec: boolean = false;

  constructor(params: {
    dbPath: string;
    embedder: EmbeddingClient;
    config: StoreConfig;
    logger: StoreLogger;
  }) {
    super(params.embedder, params.config, params.logger);
    this.dbPath = params.dbPath;
  }

  // ==========================================================================
  // Initialization — create tables, load extensions
  // ==========================================================================

  async initialize(): Promise<void> {
    // Dynamic import to keep sqlite optional (not everyone needs it)
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    this.db = new BetterSqlite3(this.dbPath);

    // WAL mode for concurrent reads
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Try to load sqlite-vec extension
    try {
      const sqliteVec = await import("sqlite-vec");
      sqliteVec.load(this.db);
      this.hasVec = true;
      this.logger.info("memory-shadowdb: sqlite-vec extension loaded");
    } catch {
      this.logger.warn(
        "memory-shadowdb: sqlite-vec not available — vector search disabled. Install: npm install sqlite-vec",
      );
    }

    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.config.table} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        content     TEXT NOT NULL,
        title       TEXT,
        category    TEXT DEFAULT 'general',
        record_type TEXT DEFAULT 'fact',
        tags        TEXT DEFAULT '[]',
        created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        deleted_at  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_${this.config.table}_category
        ON ${this.config.table}(category) WHERE deleted_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_${this.config.table}_deleted
        ON ${this.config.table}(deleted_at) WHERE deleted_at IS NOT NULL;
    `);

    // FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.config.table}_fts USING fts5(
        title, content, content=${this.config.table}, content_rowid=id
      );
    `);

    // Trigram FTS5 virtual table for substring/fuzzy search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.config.table}_trigram USING fts5(
        title, content, content=${this.config.table}, content_rowid=id,
        tokenize='trigram'
      );
    `);

    // Triggers to keep both FTS5 tables in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${this.config.table}_ai AFTER INSERT ON ${this.config.table} BEGIN
        INSERT INTO ${this.config.table}_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        INSERT INTO ${this.config.table}_trigram(rowid, title, content) VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS ${this.config.table}_ad AFTER DELETE ON ${this.config.table} BEGIN
        INSERT INTO ${this.config.table}_fts(${this.config.table}_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO ${this.config.table}_trigram(${this.config.table}_trigram, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS ${this.config.table}_au AFTER UPDATE ON ${this.config.table} BEGIN
        INSERT INTO ${this.config.table}_fts(${this.config.table}_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO ${this.config.table}_trigram(${this.config.table}_trigram, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO ${this.config.table}_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        INSERT INTO ${this.config.table}_trigram(rowid, title, content) VALUES (new.id, new.title, new.content);
      END;
    `);

    // Vector table (if sqlite-vec is available)
    if (this.hasVec) {
      const dims = this.embedder.getDimensions?.() ?? 768;
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${this.config.table}_vec USING vec0(
          id INTEGER PRIMARY KEY,
          embedding float[${dims}]
        );
      `);
    }

    // Primer table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS primer (
        key        TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        priority   INTEGER DEFAULT 50,
        always     INTEGER DEFAULT 0,
        enabled    INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
  }

  // ==========================================================================
  // Search legs
  // ==========================================================================

  protected async vectorSearch(query: string, embedding: number[], limit: number): Promise<RankedHit[]> {
    if (!this.hasVec) return [];

    // sqlite-vec: query the vec0 virtual table, join back to main table for metadata
    const sql = `
      SELECT m.id, m.content, m.category, m.title, m.record_type, m.created_at,
             v.distance AS score
      FROM ${this.config.table}_vec v
      JOIN ${this.config.table} m ON m.id = v.id
      WHERE v.embedding MATCH ?
        AND k = ?
        AND m.deleted_at IS NULL
      ORDER BY v.distance ASC
    `;
    const vecBlob = new Float32Array(embedding).buffer;
    const rows = this.db.prepare(sql).all(new Uint8Array(vecBlob), limit);

    return rows.map((r: any, idx: number) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      title: r.title,
      record_type: r.record_type,
      created_at: r.created_at,
      rank: idx + 1,
      rawScore: 1 - r.score, // convert distance to similarity
    }));
  }

  protected async textSearch(query: string, limit: number): Promise<RankedHit[]> {
    // FTS5 MATCH with bm25 ranking
    const sql = `
      SELECT m.id, m.content, m.category, m.title, m.record_type, m.created_at,
             -fts.rank AS score
      FROM ${this.config.table}_fts fts
      JOIN ${this.config.table} m ON m.id = fts.rowid
      WHERE ${this.config.table}_fts MATCH ?
        AND m.deleted_at IS NULL
      ORDER BY fts.rank
      LIMIT ?
    `;

    try {
      const rows = this.db.prepare(sql).all(query, limit);
      return rows.map((r: any, idx: number) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        title: r.title,
        record_type: r.record_type,
        created_at: r.created_at,
        rank: idx + 1,
        rawScore: r.score,
      }));
    } catch {
      // FTS5 can throw on malformed queries — degrade gracefully
      return [];
    }
  }

  protected async fuzzySearch(query: string, limit: number): Promise<RankedHit[]> {
    // FTS5 trigram tokenizer — enables substring matching.
    // Unlike pg_trgm, this is boolean (match/no-match) not scored similarity,
    // but combined with BM25 ranking it produces usable fuzzy results.
    // Trigram MATCH requires the query to be at least 3 characters.
    if (query.length < 3) return [];

    const sql = `
      SELECT m.id, m.content, m.category, m.title, m.record_type, m.created_at,
             -tri.rank AS score
      FROM ${this.config.table}_trigram tri
      JOIN ${this.config.table} m ON m.id = tri.rowid
      WHERE ${this.config.table}_trigram MATCH ?
        AND m.deleted_at IS NULL
      ORDER BY tri.rank
      LIMIT ?
    `;

    try {
      // Quote the query for trigram MATCH — wrap in double quotes for literal substring
      const quoted = '"' + query.replace(/"/g, '""') + '"';
      const rows = this.db.prepare(sql).all(quoted, limit);
      return rows.map((r: any, idx: number) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        title: r.title,
        record_type: r.record_type,
        created_at: r.created_at,
        rank: idx + 1,
        rawScore: r.score,
      }));
    } catch {
      // Trigram FTS5 can throw on certain inputs — degrade gracefully
      return [];
    }
  }

  // ==========================================================================
  // Read operations
  // ==========================================================================

  async get(id: number): Promise<{ text: string; path: string } | null> {
    const row = this.db.prepare(
      `SELECT id, content, category, title, record_type FROM ${this.config.table} WHERE id = ? AND deleted_at IS NULL`,
    ).get(id);

    if (!row) return null;
    return {
      text: this.formatFullRecord(row),
      path: `shadowdb/${row.category || "general"}/${row.id}`,
    };
  }

  async getByPath(pathQuery: string, from?: number, lines?: number): Promise<{ text: string; path: string }> {
    const parts = pathQuery.replace(/^shadowdb\//, "").split("/");

    if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
      const id = parseInt(parts[parts.length - 1], 10);
      const record = await this.get(id);
      if (!record) return { text: `Record ${id} not found`, path: pathQuery };

      if (from || lines) {
        const allLines = record.text.split("\n");
        const start = Math.max(1, from ?? 1);
        const count = Math.max(1, lines ?? allLines.length);
        return { text: allLines.slice(start - 1, start - 1 + count).join("\n"), path: pathQuery };
      }
      return record;
    }

    const category = parts[0] || null;
    const sql = category
      ? `SELECT id, substr(content, 1, 200) as content, category, title FROM ${this.config.table} WHERE category = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`
      : `SELECT id, substr(content, 1, 200) as content, category, title FROM ${this.config.table} WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`;

    const rows = category
      ? this.db.prepare(sql).all(category)
      : this.db.prepare(sql).all();

    const text = rows
      .map((r: any) => `[${r.id}] ${r.title || r.category || "—"}: ${(r.content || "").slice(0, 120)}`)
      .join("\n");

    return { text: text || "No records found", path: pathQuery };
  }

  protected async getPrimerRows(): Promise<PrimerRow[]> {
    try {
      return this.db.prepare(
        `SELECT key, content FROM primer WHERE enabled = 1 OR enabled IS NULL ORDER BY priority ASC, key ASC`,
      ).all() as PrimerRow[];
    } catch {
      // Table might not exist yet
      return [];
    }
  }

  // ==========================================================================
  // Write operations
  // ==========================================================================

  protected async insertRecord(params: {
    content: string;
    category: string;
    title: string | null;
    tags: string[];
  }): Promise<number> {
    const result = this.db.prepare(`
      INSERT INTO ${this.config.table} (content, category, title, tags, record_type)
      VALUES (?, ?, ?, ?, 'fact')
    `).run(params.content, params.category, params.title, JSON.stringify(params.tags));

    return Number(result.lastInsertRowid);
  }

  protected async updateRecord(id: number, patch: Record<string, unknown>): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(patch)) {
      setClauses.push(`${key} = ?`);
      values.push(key === "tags" ? JSON.stringify(value) : value);
    }

    setClauses.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
    values.push(id);

    this.db.prepare(
      `UPDATE ${this.config.table} SET ${setClauses.join(", ")} WHERE id = ?`,
    ).run(...values);
  }

  protected async softDeleteRecord(id: number): Promise<void> {
    this.db.prepare(
      `UPDATE ${this.config.table} SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(id);
  }

  protected async restoreRecord(id: number): Promise<void> {
    this.db.prepare(
      `UPDATE ${this.config.table} SET deleted_at = NULL WHERE id = ?`,
    ).run(id);
  }

  protected async purgeExpiredRecords(days: number): Promise<number> {
    const result = this.db.prepare(
      `DELETE FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-${days} days')`,
    ).run();
    return result.changes;
  }

  protected async storeEmbedding(id: number, embedding: number[]): Promise<void> {
    if (!this.hasVec) return;

    // Upsert into the vec0 virtual table
    const vecBlob = new Float32Array(embedding).buffer;
    this.db.prepare(
      `INSERT OR REPLACE INTO ${this.config.table}_vec (id, embedding) VALUES (?, ?)`,
    ).run(id, new Uint8Array(vecBlob));
  }

  protected async getRecordMeta(id: number): Promise<{
    id: number;
    content: string;
    category: string | null;
    deleted_at: string | Date | null;
  } | null> {
    return this.db.prepare(
      `SELECT id, content, category, deleted_at FROM ${this.config.table} WHERE id = ?`,
    ).get(id) || null;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async ping(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
