/**
 * postgres.ts — PostgreSQL backend for MemoryStore
 *
 * Implements all abstract methods from MemoryStore using:
 * - pgvector for vector similarity search (cosine distance)
 * - tsvector + tsquery for full-text search with BM25-style ranking
 * - pg_trgm for fuzzy/typo-tolerant matching
 * - Standard SQL for CRUD, soft-delete, and retention purge
 *
 * SECURITY:
 * - All queries use parameterized SQL ($1, $2, ...) — no user input interpolation
 * - Table name interpolation is safe: comes from plugin config only (not user input)
 * - Connection pool capped at 3 to prevent resource exhaustion
 * - Connection string may contain credentials — never logged
 */

import pg from "pg";
import { MemoryStore, type RankedHit, type PrimerRow, type StoreConfig, type StoreLogger } from "./store.js";
import type { EmbeddingClient } from "./embedder.js";

/**
 * PostgreSQL-backed memory store.
 *
 * The richest backend: full vector search, FTS, trigram fuzzy matching.
 * Requires pgvector and pg_trgm extensions.
 */
export class PostgresStore extends MemoryStore {
  private pool: pg.Pool | null = null;
  private connectionString: string;

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
  // Connection pool — lazy init, capped at 3
  // ==========================================================================

  private getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({
        connectionString: this.connectionString,
        max: 3,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
    }
    return this.pool;
  }

  /**
   * Expose pool for legacy compatibility (index.ts shared pool pattern).
   * TODO: Remove once index.ts is fully migrated to use MemoryStore directly.
   */
  getSharedPool(): pg.Pool {
    return this.getPool();
  }

  // ==========================================================================
  // Search legs
  // ==========================================================================

  protected async vectorSearch(query: string, embedding: number[], limit: number): Promise<RankedHit[]> {
    const vecLiteral = `[${embedding.join(",")}]`;
    const sql = `
      SELECT id, content, category, title, record_type, created_at,
             1 - (embedding <=> $1::vector) AS score,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM ${this.config.table}
      WHERE embedding IS NOT NULL AND deleted_at IS NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;
    const result = await this.getPool().query(sql, [vecLiteral, limit]);
    return result.rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      title: r.title,
      record_type: r.record_type,
      created_at: r.created_at,
      rank: parseInt(r.rank, 10),
      rawScore: parseFloat(r.score),
    }));
  }

  protected async textSearch(query: string, limit: number): Promise<RankedHit[]> {
    const sql = `
      SELECT id, content, category, title, record_type, created_at,
             ts_rank_cd(fts, plainto_tsquery('english', $1)) AS score,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts, plainto_tsquery('english', $1)) DESC) AS rank
      FROM ${this.config.table}
      WHERE fts IS NOT NULL
        AND fts @@ plainto_tsquery('english', $1)
        AND deleted_at IS NULL
      ORDER BY score DESC
      LIMIT $2
    `;
    const result = await this.getPool().query(sql, [query, limit]);
    return result.rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      title: r.title,
      record_type: r.record_type,
      created_at: r.created_at,
      rank: parseInt(r.rank, 10),
      rawScore: parseFloat(r.score),
    }));
  }

  protected async fuzzySearch(query: string, limit: number): Promise<RankedHit[]> {
    const sql = `
      SELECT id, content, category, title, record_type, created_at,
             similarity(content, $1) AS score,
             ROW_NUMBER() OVER (ORDER BY content <-> $1) AS rank
      FROM ${this.config.table}
      WHERE (content % $1 OR content ILIKE '%' || $1 || '%')
        AND deleted_at IS NULL
      ORDER BY content <-> $1
      LIMIT $2
    `;
    const result = await this.getPool().query(sql, [query, limit]);
    return result.rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      title: r.title,
      record_type: r.record_type,
      created_at: r.created_at,
      rank: parseInt(r.rank, 10),
      rawScore: parseFloat(r.score),
    }));
  }

  // ==========================================================================
  // Read operations
  // ==========================================================================

  async get(id: number): Promise<{ text: string; path: string } | null> {
    const sql = `SELECT id, content, category, title, record_type FROM ${this.config.table} WHERE id = $1 AND deleted_at IS NULL`;
    const result = await this.getPool().query(sql, [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      text: this.formatFullRecord(row),
      path: `shadowdb/${row.category || "general"}/${row.id}`,
    };
  }

  async getByPath(pathQuery: string, from?: number, lines?: number): Promise<{ text: string; path: string }> {
    const parts = pathQuery.replace(/^shadowdb\//, "").split("/");

    // Specific record by ID
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

    // Category listing
    const category = parts[0] || null;
    const sql = category
      ? `SELECT id, left(content, 200) as content, category, title FROM ${this.config.table} WHERE category = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`
      : `SELECT id, left(content, 200) as content, category, title FROM ${this.config.table} WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`;

    const result = await this.getPool().query(sql, category ? [category] : []);
    const text = result.rows
      .map((r: any) => `[${r.id}] ${r.title || r.category || "—"}: ${(r.content || "").slice(0, 120)}`)
      .join("\n");

    return { text: text || "No records found", path: pathQuery };
  }

  protected async getPrimerRows(): Promise<PrimerRow[]> {
    // Try queries with decreasing schema assumptions (graceful degradation)
    const queries = [
      `SELECT key, content FROM primer WHERE (enabled IS NULL OR enabled IS TRUE) ORDER BY priority ASC NULLS LAST, key ASC`,
      `SELECT key, content FROM primer ORDER BY priority ASC NULLS LAST, key ASC`,
      `SELECT key, content FROM primer ORDER BY key ASC`,
    ];

    for (const sql of queries) {
      try {
        const result = await this.getPool().query(sql);
        return result.rows as PrimerRow[];
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "42P01") return []; // table doesn't exist
        continue;
      }
    }
    return [];
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
    const sql = `
      INSERT INTO ${this.config.table} (content, category, title, tags, record_type)
      VALUES ($1, $2, $3, $4, 'fact')
      RETURNING id
    `;
    const result = await this.getPool().query(sql, [
      params.content, params.category, params.title, params.tags,
    ]);
    return result.rows[0].id;
  }

  protected async updateRecord(id: number, patch: Record<string, unknown>): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(patch)) {
      setClauses.push(`${key} = $${paramIdx++}`);
      values.push(value);
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(id);

    const sql = `UPDATE ${this.config.table} SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`;
    await this.getPool().query(sql, values);
  }

  protected async softDeleteRecord(id: number): Promise<void> {
    await this.getPool().query(
      `UPDATE ${this.config.table} SET deleted_at = NOW() WHERE id = $1`, [id],
    );
  }

  protected async restoreRecord(id: number): Promise<void> {
    await this.getPool().query(
      `UPDATE ${this.config.table} SET deleted_at = NULL WHERE id = $1`, [id],
    );
  }

  protected async purgeExpiredRecords(days: number): Promise<number> {
    const result = await this.getPool().query(
      `DELETE FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '${days} days' RETURNING id`,
    );
    return result.rowCount ?? 0;
  }

  protected async storeEmbedding(id: number, embedding: number[]): Promise<void> {
    const vecLiteral = `[${embedding.join(",")}]`;
    await this.getPool().query(
      `UPDATE ${this.config.table} SET embedding = $1::vector WHERE id = $2`,
      [vecLiteral, id],
    );
  }

  protected async getRecordMeta(id: number): Promise<{
    id: number;
    content: string;
    category: string | null;
    deleted_at: string | Date | null;
  } | null> {
    const result = await this.getPool().query(
      `SELECT id, content, category, deleted_at FROM ${this.config.table} WHERE id = $1`, [id],
    );
    return result.rows[0] || null;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async ping(): Promise<boolean> {
    try {
      await this.getPool().query("SELECT 1");
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

  async initialize(): Promise<void> {
    // Postgres schema is managed externally via schema.sql / setup.sh.
    // This is a no-op — we don't auto-create tables.
    // Run `setup.sh` or apply schema.sql manually.
  }
}
