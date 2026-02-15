/**
 * search.ts — PostgreSQL search implementation for memory-shadowdb
 *
 * Implements hybrid search combining:
 * 1. Vector similarity (pgvector cosine distance)
 * 2. Full-text search (tsvector + tsquery BM25 ranking)
 * 3. Trigram similarity (pg_trgm for fuzzy matching)
 *
 * Results are merged using Reciprocal Rank Fusion (RRF) for balanced relevance.
 *
 * SECURITY MODEL:
 * - Connection string may contain credentials (never logged in full)
 * - SQL uses parameterized queries ($1, $2, ...) for all user input
 * - Table name IS interpolated but comes from config only (not user input)
 * - Pool size capped at 3 connections to prevent resource exhaustion
 * - Input truncation enforced (8000 chars in embedder, bounds here for paths/queries)
 *
 * DATA FLOW:
 * 1. User query → embed() → vector
 * 2. SQL query with $1=vector, $2=limit, $3=text_query
 * 3. Three parallel CTEs: vector_search, fts_search, trigram_search
 * 4. FULL OUTER JOIN + RRF scoring
 * 5. Return ranked results with citations
 */

import pg from "pg";
import { createHash } from "node:crypto";
import type { EmbeddingClient } from "./embedder.js";
import type { SearchResult } from "./types.js";

/**
 * PostgreSQL-backed memory search with hybrid ranking
 *
 * This class manages the connection pool and implements all search operations:
 * - search(): hybrid vector + FTS + trigram with RRF
 * - get(): fetch single record by ID
 * - getByPath(): fetch by category or virtual path
 * - getStartupContext(): load startup records for agent initialization
 *
 * SECURITY NOTES:
 * - Connection pool limited to 3 connections max (resource protection)
 * - All queries use parameterized SQL ($1, $2, ...) except table name
 * - Table name interpolation is safe because it comes from config only
 * - No user input is ever interpolated into SQL strings
 *
 * LIFECYCLE:
 * - Lazy pool creation on first query
 * - close() must be called for clean shutdown
 * - ping() for health checks
 */
export class ShadowSearch {
  private pool: pg.Pool | null = null;
  private connectionString: string;
  private table: string;
  private embedder: EmbeddingClient;
  private vectorWeight: number;
  private textWeight: number;

  constructor(params: {
    connectionString: string;
    table: string;
    embedder: EmbeddingClient;
    vectorWeight: number;
    textWeight: number;
  }) {
    this.connectionString = params.connectionString;
    this.table = params.table;
    this.embedder = params.embedder;
    this.vectorWeight = params.vectorWeight;
    this.textWeight = params.textWeight;
  }

  /**
   * Get or create connection pool (lazy initialization)
   *
   * SECURITY: Pool settings enforce resource limits:
   * - max: 3 connections (prevents connection exhaustion)
   * - idleTimeoutMillis: 30s (releases idle connections)
   * - connectionTimeoutMillis: 5s (fails fast on connection issues)
   *
   * @returns PostgreSQL connection pool
   */
  private getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({
        connectionString: this.connectionString,
        max: 3, // SECURITY: cap concurrent connections
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
    }
    return this.pool;
  }

  /**
   * Hybrid search: vector + FTS + trigram with RRF merging
   *
   * ALGORITHM:
   * 1. Vector search: pgvector cosine similarity (1 - <=> operator)
   * 2. FTS search: tsvector with plainto_tsquery + ts_rank_cd
   * 3. Trigram search: pg_trgm similarity for fuzzy matching
   * 4. Reciprocal Rank Fusion (RRF): score = Σ weight/(60+rank) across methods
   * 5. Sort by RRF score, return top N
   *
   * SECURITY:
   * - All user input is parameterized ($1=vector, $2=maxResults, $3=query)
   * - Table name is interpolated but comes from config (not user input)
   * - Query filters: superseded_by IS NULL AND contradicted IS NOT TRUE
   *   (only returns active, non-contradicted records)
   * - Oversample factor: 5x maxResults for each CTE to ensure good RRF merge
   *
   * RRF FORMULA:
   * - k=60 (standard RRF constant)
   * - vector: vectorWeight * (1 / (60 + vec_rank))
   * - fts: textWeight * (1 / (60 + fts_rank))
   * - trigram: 0.2 * (1 / (60 + trgm_rank))
   * - Combined score threshold: rrf_score > 0.001 (filters noise)
   *
   * @param query - Search query string
   * @param maxResults - Maximum results to return
   * @param minScore - Minimum RRF score threshold (currently unused, filtering happens in SQL)
   * @returns Ranked search results with citations
   */
  async search(query: string, maxResults: number, minScore: number): Promise<SearchResult[]> {
    // Generate embedding vector for query
    const queryVec = await this.embedder.embed(query);
    
    // SECURITY: pgvector literal is safe because queryVec is float[] from embedder
    // (no user input interpolation)
    const vecLiteral = `[${queryVec.join(",")}]`;

    // Hybrid search with RRF merge
    // NOTE: Table name ${this.table} is interpolated, but comes from config only (not user input)
    const sql = `
      WITH vector_search AS (
        SELECT id, content, category, title, record_type,
               1 - (embedding <=> $1::vector) AS vec_score,
               ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vec_rank
        FROM ${this.table}
        WHERE embedding IS NOT NULL
          AND superseded_by IS NULL AND contradicted IS NOT TRUE
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      ),
      fts_search AS (
        SELECT id, content, category, title, record_type,
               ts_rank_cd(fts, plainto_tsquery('english', $3)) AS fts_score,
               ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts, plainto_tsquery('english', $3)) DESC) AS fts_rank
        FROM ${this.table}
        WHERE fts IS NOT NULL
          AND fts @@ plainto_tsquery('english', $3)
          AND superseded_by IS NULL AND contradicted IS NOT TRUE
        ORDER BY fts_score DESC
        LIMIT $2
      ),
      trigram_search AS (
        SELECT id, content, category, title, record_type,
               similarity(content, $3) AS trgm_score,
               ROW_NUMBER() OVER (ORDER BY content <-> $3) AS trgm_rank
        FROM ${this.table}
        WHERE (content % $3 OR content ILIKE '%' || $3 || '%')
          AND superseded_by IS NULL AND contradicted IS NOT TRUE
        ORDER BY content <-> $3
        LIMIT $2
      ),
      combined AS (
        SELECT
          COALESCE(v.id, f.id, t.id) AS id,
          COALESCE(v.content, f.content, t.content) AS content,
          COALESCE(v.category, f.category, t.category) AS category,
          COALESCE(v.title, f.title, t.title) AS title,
          COALESCE(v.record_type, f.record_type, t.record_type) AS record_type,
          COALESCE(v.vec_score, 0) AS vec_score,
          -- RRF: 1/(k+rank) with k=60
          COALESCE($4::float * (1.0 / (60 + v.vec_rank)), 0) +
          COALESCE($5::float * (1.0 / (60 + f.fts_rank)), 0) +
          COALESCE(0.2 * (1.0 / (60 + t.trgm_rank)), 0) AS rrf_score
        FROM vector_search v
        FULL OUTER JOIN fts_search f ON v.id = f.id
        FULL OUTER JOIN trigram_search t ON COALESCE(v.id, f.id) = t.id
      )
      SELECT DISTINCT ON (id) id, content, category, title, record_type, vec_score, rrf_score
      FROM combined
      WHERE rrf_score > 0.001
      ORDER BY id, rrf_score DESC
    `;

    // SECURITY: All parameters are bound, no string interpolation of user input
    const result = await this.getPool().query(sql, [
      vecLiteral,
      maxResults * 5, // oversample for RRF merge + trigram
      query, // $3: text query for FTS and trigram
      this.vectorWeight, // $4: RRF weight for vector ranking
      this.textWeight, // $5: RRF weight for FTS ranking
    ]);

    // DISTINCT ON resets ordering, so re-sort by rrf_score descending
    const sorted = result.rows.sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        (parseFloat(b.rrf_score as string) || 0) - (parseFloat(a.rrf_score as string) || 0),
    );

    // Format results with snippets and citations
    return sorted.slice(0, maxResults).map((row) => {
      const snippet = this.formatSnippet(row);
      const virtualPath = `shadowdb/${row.category || "general"}/${row.id}`;
      return {
        path: virtualPath,
        startLine: 1,
        endLine: 1,
        score: parseFloat(row.rrf_score) || parseFloat(row.vec_score) || 0,
        snippet,
        source: "memory",
        citation: `shadowdb:${this.table}#${row.id}`,
      };
    });
  }

  /**
   * Read a specific record by ID
   *
   * Used by memory_get tool for deep retrieval after memory_search.
   *
   * SECURITY: ID is parameterized ($1), no injection risk.
   *
   * @param recordId - Database record ID
   * @returns Full record content and virtual path, or null if not found
   */
  async get(recordId: number): Promise<{ text: string; path: string } | null> {
    // SECURITY: ID is parameterized, table name from config only
    const sql = `SELECT id, content, category, title, record_type FROM ${this.table} WHERE id = $1`;
    const result = await this.getPool().query(sql, [recordId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    const virtualPath = `shadowdb/${row.category || "general"}/${row.id}`;
    
    return {
      text: this.formatFullRecord(row),
      path: virtualPath,
    };
  }

  /**
   * Read multiple records by category or specific record by path
   *
   * Supports two path formats:
   * 1. shadowdb/{category}/{id} → fetch specific record
   * 2. shadowdb/{category} → list recent records in category
   *
   * Optional from/lines parameters enable line-range extraction for large records.
   *
   * SECURITY:
   * - Category is parameterized ($1) when used in WHERE clause
   * - ID parsing is safe (parseInt returns NaN for non-numbers)
   * - No user input in SQL string interpolation
   *
   * @param pathQuery - Virtual path (shadowdb/{category} or shadowdb/{category}/{id})
   * @param from - Optional starting line number (1-indexed)
   * @param lines - Optional line count to extract
   * @returns Record content and path
   */
  async getByPath(
    pathQuery: string,
    from?: number,
    lines?: number,
  ): Promise<{ text: string; path: string }> {
    // Parse virtual path: shadowdb/{category}/{id} or shadowdb/{category}
    const parts = pathQuery.replace(/^shadowdb\//, "").split("/");

    // Case 1: Specific record by ID (path ends with numeric ID)
    if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
      const id = parseInt(parts[parts.length - 1], 10);
      const record = await this.get(id);
      
      if (!record) {
        return { text: `Record ${id} not found`, path: pathQuery };
      }
      
      // Optional line-range extraction
      if (from || lines) {
        const allLines = record.text.split("\n");
        const start = Math.max(1, from ?? 1);
        const count = Math.max(1, lines ?? allLines.length);
        return { 
          text: allLines.slice(start - 1, start - 1 + count).join("\n"), 
          path: pathQuery 
        };
      }
      
      return record;
    }

    // Case 2: Category listing (show recent records in category)
    const category = parts[0] || null;
    
    // SECURITY: Category is parameterized if present, otherwise query all records
    const sql = category
      ? `SELECT id, left(content, 200) as content, category, title FROM ${this.table} WHERE category = $1 ORDER BY id DESC LIMIT 20`
      : `SELECT id, left(content, 200) as content, category, title FROM ${this.table} ORDER BY id DESC LIMIT 20`;
    
    const params = category ? [category] : [];
    const result = await this.getPool().query(sql, params);

    // Format as list of records with truncated content
    const text = result.rows
      .map((r) => `[${r.id}] ${r.title || r.category || "—"}: ${(r.content || "").slice(0, 120)}`)
      .join("\n");

    return { text: text || "No records found", path: pathQuery };
  }

  /**
   * Load startup context from database for agent initialization
   *
   * Fetches rows from `startup` table and formats them for injection into
   * the agent's initial context. This front-loads identity, rules, and
   * critical memory before the first user message.
   *
   * SECURITY:
   * - maxChars bounds total output to prevent context overflow (DoS protection)
   * - Digest enables cache-based injection (only re-inject when content changes)
   * - Truncation marked in output so agent knows context was trimmed
   *
   * CACHING:
   * - Digest = SHA1 hash of concatenated content (first 16 hex chars)
   * - Caller can cache by digest to avoid redundant DB queries
   * - If content hasn't changed, skip injection (digest mode)
   *
   * @param maxChars - Maximum characters to return (enforced with truncation marker)
   * @returns Startup context object with text, digest, metadata, or null if no records
   */
  async getStartupContext(maxChars: number): Promise<{
    text: string;
    digest: string;
    totalChars: number;
    rowCount: number;
    truncated: boolean;
  } | null> {
    const rows = await this.fetchStartupRows();
    
    if (rows.length === 0) {
      return null;
    }

    // Format each row as a markdown section (## {key}\n{content})
    const sections = rows
      .map((row) => {
        const key = String(row.key || "startup").trim();
        const content = String(row.content || "").trim();
        if (!content) {
          return "";
        }
        return `## ${key}\n${content}`;
      })
      .filter(Boolean);

    if (sections.length === 0) {
      return null;
    }

    const fullText = sections.join("\n\n");
    
    // SECURITY: Generate digest for cache key (SHA1 is fast, collision-resistant for this use)
    const digest = createHash("sha1").update(fullText).digest("hex").slice(0, 16);

    // SECURITY: Enforce maxChars limit to prevent unbounded context injection
    const trimmedMax = Math.max(0, maxChars);
    const truncated = trimmedMax > 0 && fullText.length > trimmedMax;
    
    const text = truncated
      ? `${fullText.slice(0, trimmedMax)}\n\n[...startup context truncated...]`
      : fullText;

    return {
      text,
      digest,
      totalChars: fullText.length,
      rowCount: sections.length,
      truncated,
    };
  }

  /**
   * Fetch startup rows from database with graceful fallback
   *
   * Tries multiple query variants to handle different schema versions:
   * 1. Full query: ORDER BY priority ASC NULLS LAST, key ASC (with enabled filter)
   * 2. Fallback 1: No enabled filter (for schemas without enabled column)
   * 3. Fallback 2: No priority column (for minimal schemas)
   *
   * Returns empty array if `startup` table doesn't exist (code 42P01).
   *
   * SECURITY:
   * - No user input in these queries (no parameters needed)
   * - Table name is fixed ("startup"), not interpolated from config
   * - Graceful degradation if table/columns missing (not a security issue)
   *
   * @returns Array of {key, content} objects ordered by priority
   */
  private async fetchStartupRows(): Promise<Array<{ key: string; content: string }>> {
    const queries = [
      // Preferred: full schema with priority and enabled columns
      `SELECT key, content FROM startup WHERE (enabled IS NULL OR enabled IS TRUE) ORDER BY priority ASC NULLS LAST, key ASC`,
      // Fallback 1: no enabled column
      `SELECT key, content FROM startup ORDER BY priority ASC NULLS LAST, key ASC`,
      // Fallback 2: no priority column
      `SELECT key, content FROM startup ORDER BY key ASC`,
    ];

    for (const sql of queries) {
      try {
        const result = await this.getPool().query(sql);
        return result.rows as Array<{ key: string; content: string }>;
      } catch (err) {
        const code = (err as { code?: string }).code;
        
        // 42P01 = table does not exist (expected if startup table not created yet)
        if (code === "42P01") {
          return [];
        }
        
        // Other errors (missing column, syntax, etc.) → try next fallback
        continue;
      }
    }

    // All queries failed (shouldn't happen unless DB is severely broken)
    return [];
  }

  /**
   * Expose the connection pool for shared use by ShadowWriter
   *
   * The writer needs a pool reference to execute write queries.
   * Rather than creating a separate pool (which would double connection count),
   * we share the same pool. This is safe because:
   * - Pool handles concurrency internally (pg.Pool is connection-safe)
   * - Max connections is still capped at 3 (set in getPool())
   * - Writer and search operations are independent queries (no transaction conflicts)
   *
   * @returns The PostgreSQL connection pool (lazily created if needed)
   */
  getSharedPool(): pg.Pool {
    return this.getPool();
  }

  /**
   *
   * Simple SELECT 1 query to test connectivity.
   * Used by plugin service for startup validation.
   *
   * @returns true if connection works, false otherwise
   */
  async ping(): Promise<boolean> {
    try {
      await this.getPool().query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close connection pool (clean shutdown)
   *
   * Must be called during plugin stop to release database connections.
   * After close(), this ShadowSearch instance cannot be used.
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Format record snippet for search results
   *
   * Creates a compact representation with metadata header and truncated content.
   * Max 700 chars to fit tool result constraints.
   *
   * Format:
   * ```
   * # {title} | [{category}] | type: {record_type}
   * {content truncated to fit}
   * ```
   *
   * @param row - Database row with id, content, category, title, record_type
   * @returns Formatted snippet string
   */
  private formatSnippet(row: {
    id: number;
    content: string;
    category?: string;
    title?: string;
    record_type?: string;
  }): string {
    const maxChars = 700;
    
    // Build metadata header
    const header = [
      row.title ? `# ${row.title}` : null,
      row.category ? `[${row.category}]` : null,
      row.record_type && row.record_type !== row.category
        ? `type: ${row.record_type}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const prefix = header ? `${header}\n` : "";
    const body = (row.content || "").slice(0, maxChars - prefix.length);
    
    return `${prefix}${body}`.trim();
  }

  /**
   * Format full record for memory_get results
   *
   * Includes all metadata and complete content (no truncation).
   *
   * Format:
   * ```
   * # {title}
   * Category: {category}
   * Type: {record_type}
   *
   * {full content}
   * ```
   *
   * @param row - Database row with id, content, category, title, record_type
   * @returns Formatted full record string
   */
  private formatFullRecord(row: {
    id: number;
    content: string;
    category?: string;
    title?: string;
    record_type?: string;
  }): string {
    const parts: string[] = [];
    
    if (row.title) parts.push(`# ${row.title}`);
    if (row.category) parts.push(`Category: ${row.category}`);
    if (row.record_type) parts.push(`Type: ${row.record_type}`);
    
    parts.push(""); // Blank line before content
    parts.push(row.content || "");
    
    return parts.join("\n");
  }
}
