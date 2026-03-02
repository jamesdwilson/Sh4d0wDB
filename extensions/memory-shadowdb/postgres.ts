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
    metadata: Record<string, unknown>;
    parent_id: number | null;
    priority: number;
  }): Promise<number> {
    const sql = `
      INSERT INTO ${this.config.table} (content, category, title, tags, record_type, metadata, parent_id, priority)
      VALUES ($1, $2, $3, $4, 'fact', $5::jsonb, $6, $7)
      RETURNING id
    `;
    const result = await this.getPool().query(sql, [
      params.content, params.category, params.title, params.tags,
      JSON.stringify(params.metadata), params.parent_id, params.priority,
    ]);
    return result.rows[0].id;
  }

  async list(params: {
    category?: string;
    tags?: string[];
    tags_include?: string[];
    tags_any?: string[];
    record_type?: string;
    parent_id?: number;
    priority_min?: number;
    priority_max?: number;
    created_after?: string;
    created_before?: string;
    metadata?: Record<string, unknown>;
    detail_level?: "summary" | "snippet" | "full";
    sort?: "created_at" | "updated_at" | "priority" | "title";
    sort_order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<import("./types.js").ListResult[]> {
    const conditions: string[] = ["deleted_at IS NULL"];
    const values: unknown[] = [];
    let idx = 1;

    if (params.category) { conditions.push(`category = $${idx++}`); values.push(params.category); }
    if (params.record_type) { conditions.push(`record_type = $${idx++}`); values.push(params.record_type); }
    if (params.parent_id !== undefined) { conditions.push(`parent_id = $${idx++}`); values.push(params.parent_id); }
    if (params.priority_min !== undefined) { conditions.push(`priority >= $${idx++}`); values.push(params.priority_min); }
    if (params.priority_max !== undefined) { conditions.push(`priority <= $${idx++}`); values.push(params.priority_max); }
    if (params.created_after) { conditions.push(`created_at >= $${idx++}`); values.push(params.created_after); }
    if (params.created_before) { conditions.push(`created_at <= $${idx++}`); values.push(params.created_before); }
    if (params.tags && params.tags.length > 0) { conditions.push(`tags @> $${idx++}::text[]`); values.push(params.tags); }
    if (params.tags_include && params.tags_include.length > 0) { conditions.push(`tags @> $${idx++}::text[]`); values.push(params.tags_include); }
    if (params.tags_any && params.tags_any.length > 0) { conditions.push(`tags && $${idx++}::text[]`); values.push(params.tags_any); }
    if (params.metadata && Object.keys(params.metadata).length > 0) { conditions.push(`metadata @> $${idx++}::jsonb`); values.push(JSON.stringify(params.metadata)); }

    const where = conditions.join(" AND ");
    const lim = Math.min(params.limit ?? 50, 200);
    const off = params.offset ?? 0;
    const contentCol = params.detail_level === "full" || params.detail_level === "snippet"
      ? ", content" : "";

    // Sort — validate column name to prevent SQL injection
    const allowedSorts = ["created_at", "updated_at", "priority", "title"] as const;
    const sortCol = allowedSorts.includes(params.sort as any) ? params.sort! : "created_at";
    const sortDir = params.sort_order === "asc" ? "ASC" : "DESC";

    const sql = `
      SELECT id, category, title, record_type, priority, parent_id,
             COALESCE(metadata, '{}') as metadata, created_at, COALESCE(tags, '{}') as tags${contentCol}
      FROM ${this.config.table}
      WHERE ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    values.push(lim, off);

    const result = await this.getPool().query(sql, values);
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      path: `shadowdb/${row.category || "general"}/${row.id}`,
      category: row.category as string | null,
      title: row.title as string | null,
      record_type: row.record_type as string | null,
      priority: row.priority as number,
      parent_id: row.parent_id as number | null,
      metadata: row.metadata as Record<string, unknown>,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      tags: row.tags as string[],
      ...(contentCol ? { content: row.content as string } : {}),
    }));
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

  protected async fetchExpiredRecords(days: number) {
    const result = await this.getPool().query(
      `SELECT id, content, category, title, deleted_at FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '${days} days'`,
    );
    return result.rows;
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
    // Create meta table for embedding fingerprint tracking
    await this.getPool().query(`
      CREATE TABLE IF NOT EXISTS ${this.config.table}_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  async getMetaValue(key: string): Promise<string | null> {
    try {
      const result = await this.getPool().query(
        `SELECT value FROM ${this.config.table}_meta WHERE key = $1`, [key],
      );
      return result.rows[0]?.value ?? null;
    } catch (err) {
      // Table might not exist yet
      const code = (err as { code?: string }).code;
      if (code === "42P01") return null; // undefined_table
      throw err;
    }
  }

  async setMetaValue(key: string, value: string): Promise<void> {
    await this.getPool().query(`
      INSERT INTO ${this.config.table}_meta (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, value]);
  }

  protected async getRecordBatch(afterId: number, limit: number): Promise<Array<{ id: number; content: string }>> {
    const result = await this.getPool().query(
      `SELECT id, content FROM ${this.config.table} WHERE deleted_at IS NULL AND id > $1 ORDER BY id ASC LIMIT $2`,
      [afterId, limit],
    );
    return result.rows;
  }
}
