/**
 * mysql.ts — MySQL backend for MemoryStore
 *
 * Implements all abstract methods from MemoryStore using:
 * - Native VECTOR type for similarity search (MySQL 9.2+)
 * - FULLTEXT indexes with MATCH AGAINST for text search
 * - No fuzzy/trigram search (MySQL has no built-in equivalent)
 * - Standard SQL for CRUD, soft-delete, and retention purge
 *
 * Dependencies:
 * - mysql2: MySQL driver with prepared statement support
 *
 * REQUIREMENTS:
 * - MySQL 9.2.1+ for native VECTOR type
 * - FULLTEXT index on (title, content) for text search
 *
 * SECURITY:
 * - All queries use parameterized SQL (? placeholders)
 * - Table name comes from config only (not user input)
 * - Connection pool capped at 3 to prevent resource exhaustion
 * - Connection string may contain credentials — never logged
 *
 * DESIGN NOTES:
 * - Tags stored as JSON array (MySQL JSON type)
 * - VECTOR type stores embeddings natively (no extension needed in 9.2+)
 * - LAST_INSERT_ID() instead of RETURNING (MySQL doesn't support RETURNING)
 * - deleted_at uses DATETIME type (MySQL's TIMESTAMP has 2038 limitation)
 */

import { MemoryStore, type RankedHit, type StartupRow, type StoreConfig, type StoreLogger } from "./store.js";
import type { EmbeddingClient } from "./embedder.js";

// mysql2 types
type Pool = any;

/**
 * MySQL-backed memory store.
 *
 * Requires MySQL 9.2+ for native VECTOR support.
 * FULLTEXT search built-in. No trigram/fuzzy search.
 */
export class MySQLStore extends MemoryStore {
  private pool: Pool = null;
  private connectionString: string;
  private hasVector: boolean = false;

  constructor(params: {
    connectionString: string;
    embedder: EmbeddingClient;
    config: StoreConfig;
    logger: StoreLogger;
  }) {
    super(params.embedder, params.config, params.logger);
    this.connectionString = params.connectionString;
  }

  // ==========================================================================
  // Connection pool
  // ==========================================================================

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      const mysql = await import("mysql2/promise");
      this.pool = mysql.createPool({
        uri: this.connectionString,
        connectionLimit: 3,
        waitForConnections: true,
        connectTimeout: 5_000,
      });
    }
    return this.pool;
  }

  /** Execute a query and return rows. */
  private async query(sql: string, params: unknown[] = []): Promise<any[]> {
    const pool = await this.getPool();
    const [rows] = await pool.execute(sql, params);
    return rows as any[];
  }

  /** Execute a statement (INSERT/UPDATE/DELETE) and return result metadata. */
  private async exec(sql: string, params: unknown[] = []): Promise<any> {
    const pool = await this.getPool();
    const [result] = await pool.execute(sql, params);
    return result;
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  async initialize(): Promise<void> {
    // Create memories table
    await this.exec(`
      CREATE TABLE IF NOT EXISTS ${this.config.table} (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        content     TEXT NOT NULL,
        title       VARCHAR(500),
        category    VARCHAR(100) DEFAULT 'general',
        record_type VARCHAR(50) DEFAULT 'fact',
        tags        JSON DEFAULT ('[]'),
        embedding   VECTOR(${this.embedder.getDimensions?.() ?? 768}),
        created_at  DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
        updated_at  DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        deleted_at  DATETIME(3) NULL,
        FULLTEXT INDEX idx_ft_content (title, content),
        INDEX idx_category (category),
        INDEX idx_deleted (deleted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Check if VECTOR type is available (MySQL 9.2+)
    try {
      await this.query(`SELECT VECTOR_DIM(embedding) FROM ${this.config.table} LIMIT 0`);
      this.hasVector = true;
      this.logger.info("memory-shadowdb: MySQL VECTOR type available");
    } catch {
      this.logger.warn(
        "memory-shadowdb: MySQL VECTOR type not available — vector search disabled. Requires MySQL 9.2+",
      );
    }

    // Startup table
    await this.exec(`
      CREATE TABLE IF NOT EXISTS startup (
        \`key\`      VARCHAR(255) PRIMARY KEY,
        content    TEXT NOT NULL,
        priority   INT DEFAULT 50,
        reinforce  TINYINT(1) DEFAULT 0,
        enabled    TINYINT(1) DEFAULT 1,
        updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  // ==========================================================================
  // Search legs
  // ==========================================================================

  protected async vectorSearch(query: string, embedding: number[], limit: number): Promise<RankedHit[]> {
    if (!this.hasVector) return [];

    // MySQL 9.2+ vector search using cosine distance
    const vecString = `[${embedding.join(",")}]`;
    const sql = `
      SELECT id, content, category, title, record_type, created_at,
             1 - DISTANCE(embedding, STRING_TO_VECTOR(?), 'COSINE') AS score
      FROM ${this.config.table}
      WHERE embedding IS NOT NULL AND deleted_at IS NULL
      ORDER BY DISTANCE(embedding, STRING_TO_VECTOR(?), 'COSINE') ASC
      LIMIT ?
    `;

    const rows = await this.query(sql, [vecString, vecString, limit]);
    return rows.map((r: any, idx: number) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      title: r.title,
      record_type: r.record_type,
      created_at: r.created_at,
      rank: idx + 1,
      rawScore: parseFloat(r.score),
    }));
  }

  protected async textSearch(query: string, limit: number): Promise<RankedHit[]> {
    // MySQL FULLTEXT with MATCH AGAINST in natural language mode
    const sql = `
      SELECT id, content, category, title, record_type, created_at,
             MATCH(title, content) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
      FROM ${this.config.table}
      WHERE MATCH(title, content) AGAINST(? IN NATURAL LANGUAGE MODE)
        AND deleted_at IS NULL
      ORDER BY score DESC
      LIMIT ?
    `;

    const rows = await this.query(sql, [query, query, limit]);
    return rows.map((r: any, idx: number) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      title: r.title,
      record_type: r.record_type,
      created_at: r.created_at,
      rank: idx + 1,
      rawScore: parseFloat(r.score),
    }));
  }

  protected async fuzzySearch(_query: string, _limit: number): Promise<RankedHit[]> {
    // MySQL has no built-in trigram/fuzzy support
    return [];
  }

  // ==========================================================================
  // Read operations
  // ==========================================================================

  async get(id: number): Promise<{ text: string; path: string } | null> {
    const rows = await this.query(
      `SELECT id, content, category, title, record_type FROM ${this.config.table} WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    if (rows.length === 0) return null;

    const row = rows[0];
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
      ? `SELECT id, LEFT(content, 200) as content, category, title FROM ${this.config.table} WHERE category = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`
      : `SELECT id, LEFT(content, 200) as content, category, title FROM ${this.config.table} WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`;

    const rows = category
      ? await this.query(sql, [category])
      : await this.query(sql);

    const text = rows
      .map((r: any) => `[${r.id}] ${r.title || r.category || "—"}: ${(r.content || "").slice(0, 120)}`)
      .join("\n");

    return { text: text || "No records found", path: pathQuery };
  }

  protected async getStartupRows(): Promise<StartupRow[]> {
    try {
      return await this.query(
        "SELECT `key`, content FROM startup WHERE enabled = 1 OR enabled IS NULL ORDER BY priority ASC, `key` ASC",
      ) as StartupRow[];
    } catch {
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
    const result = await this.exec(
      `INSERT INTO ${this.config.table} (content, category, title, tags, record_type) VALUES (?, ?, ?, ?, 'fact')`,
      [params.content, params.category, params.title, JSON.stringify(params.tags)],
    );
    return result.insertId;
  }

  protected async updateRecord(id: number, patch: Record<string, unknown>): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(patch)) {
      setClauses.push(`${key} = ?`);
      values.push(key === "tags" ? JSON.stringify(value) : value);
    }

    // updated_at auto-updates via ON UPDATE CURRENT_TIMESTAMP
    values.push(id);
    await this.exec(
      `UPDATE ${this.config.table} SET ${setClauses.join(", ")} WHERE id = ?`,
      values,
    );
  }

  protected async softDeleteRecord(id: number): Promise<void> {
    await this.exec(
      `UPDATE ${this.config.table} SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [id],
    );
  }

  protected async restoreRecord(id: number): Promise<void> {
    await this.exec(
      `UPDATE ${this.config.table} SET deleted_at = NULL WHERE id = ?`,
      [id],
    );
  }

  protected async purgeExpiredRecords(days: number): Promise<number> {
    const result = await this.exec(
      `DELETE FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days],
    );
    return result.affectedRows ?? 0;
  }

  protected async storeEmbedding(id: number, embedding: number[]): Promise<void> {
    if (!this.hasVector) return;

    const vecString = `[${embedding.join(",")}]`;
    await this.exec(
      `UPDATE ${this.config.table} SET embedding = STRING_TO_VECTOR(?) WHERE id = ?`,
      [vecString, id],
    );
  }

  protected async getRecordMeta(id: number): Promise<{
    id: number;
    content: string;
    category: string | null;
    deleted_at: string | Date | null;
  } | null> {
    const rows = await this.query(
      `SELECT id, content, category, deleted_at FROM ${this.config.table} WHERE id = ?`,
      [id],
    );
    return rows[0] || null;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async ping(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
