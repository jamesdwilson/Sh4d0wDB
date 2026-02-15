/**
 * writer.ts — Write operations for memory-shadowdb
 *
 * Implements memory_write, memory_update, and memory_delete operations
 * against the PostgreSQL memories table with automatic embedding generation.
 *
 * SECURITY MODEL:
 * - All write operations are config-gated: `writes.enabled` must be true
 * - Hard-delete requires additional gate: `writes.allowDelete` must be true
 * - All SQL uses parameterized queries ($1, $2, ...) — no user input interpolation
 * - Table name comes from plugin config only (same as search.ts)
 * - Content length is bounded (max 100,000 chars) to prevent storage abuse
 * - Embedding generation is fail-open: write succeeds even if embedding fails
 *   (data persistence > search quality; embedding can be backfilled later)
 *
 * DATA FLOW — memory_write:
 * 1. Validate input (content non-empty, ≤100K chars, category/title are strings)
 * 2. INSERT into memories table with parameterized SQL
 * 3. If autoEmbed: generate embedding via EmbeddingClient
 * 4. UPDATE embedding column with vector (separate query for fail-open)
 * 5. Return new record ID and virtual path
 *
 * DATA FLOW — memory_update:
 * 1. Validate record exists (SELECT by ID)
 * 2. Build dynamic SET clause from provided fields only
 * 3. UPDATE with parameterized SQL
 * 4. If content changed and autoEmbed: regenerate embedding
 * 5. Return confirmation with updated path
 *
 * DATA FLOW — memory_delete:
 * 1. Validate record exists
 * 2. Soft-delete: UPDATE contradicted = TRUE (default)
 * 3. Hard-delete: DELETE FROM ... WHERE id = $1 (requires writes.allowDelete)
 * 4. Return confirmation with method used
 *
 * DEPENDENCY CHAIN:
 * - types.ts: WriteResult type
 * - embedder.ts: EmbeddingClient for auto-embedding
 * - pg: PostgreSQL connection pool (shared with ShadowSearch)
 */

import pg from "pg";
import type { EmbeddingClient } from "./embedder.js";
import type { WriteResult } from "./types.js";

/**
 * Maximum content length in characters.
 *
 * Bounds storage consumption per record. 100K chars is ~100KB of UTF-8 text,
 * which is generous for knowledge records but prevents accidental mega-inserts
 * (e.g., pasting entire codebases or log files).
 *
 * This limit is enforced at the application layer, not the DB layer,
 * so the error message is clear and actionable.
 */
const MAX_CONTENT_CHARS = 100_000;

/**
 * Maximum tag count per record.
 *
 * Prevents unbounded array storage and GIN index bloat.
 * 50 tags is generous for any reasonable categorization scheme.
 */
const MAX_TAGS = 50;

/**
 * Maximum length of a single tag string.
 *
 * Prevents absurdly long tag values that would bloat the index.
 */
const MAX_TAG_LENGTH = 200;

/**
 * Maximum length of title and category strings.
 *
 * These are metadata fields used in search results and citations.
 * Keeping them bounded ensures readable output formatting.
 */
const MAX_TITLE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 100;

/**
 * PostgreSQL-backed memory writer with auto-embedding
 *
 * This class handles all write operations (insert, update, delete) against
 * the memories table. It shares the connection pool with ShadowSearch
 * (passed in via constructor) to avoid duplicate connections.
 *
 * SECURITY NOTES:
 * - Config gates (enabled, allowDelete) are checked at the tool registration
 *   level in index.ts AND enforced here as defense-in-depth
 * - All queries use parameterized SQL ($1, $2, ...) — no string interpolation
 *   of user input into SQL
 * - Table name is interpolated but comes from config only (trusted source)
 * - Embedding failure does not block the write (fail-open design)
 *
 * LIFECYCLE:
 * - Receives pool reference from caller (does not create its own pool)
 * - No cleanup needed (pool lifecycle managed by ShadowSearch)
 */
export class ShadowWriter {
  private pool: pg.Pool;
  private table: string;
  private embedder: EmbeddingClient;
  private autoEmbed: boolean;
  private allowDelete: boolean;
  private logger: { warn: (msg: string) => void; info: (msg: string) => void };

  constructor(params: {
    /** Shared connection pool (from ShadowSearch.getPool or equivalent) */
    pool: pg.Pool;

    /** Target table name (from plugin config, not user input) */
    table: string;

    /** Embedding client for auto-embed on write/update */
    embedder: EmbeddingClient;

    /**
     * Whether to auto-generate embeddings on write/update.
     * When false, records are inserted with embedding=NULL.
     */
    autoEmbed: boolean;

    /**
     * Whether hard-delete is permitted.
     * When false, memory_delete only soft-deletes (contradicted=TRUE).
     */
    allowDelete: boolean;

    /** Logger for warnings (embedding failures, etc.) */
    logger: { warn: (msg: string) => void; info: (msg: string) => void };
  }) {
    this.pool = params.pool;
    this.table = params.table;
    this.embedder = params.embedder;
    this.autoEmbed = params.autoEmbed;
    this.allowDelete = params.allowDelete;
    this.logger = params.logger;
  }

  /**
   * Insert a new memory record
   *
   * Creates a row in the memories table with the provided content, category,
   * title, and tags. Optionally generates an embedding vector for immediate
   * vector-searchability.
   *
   * SECURITY:
   * - All input is validated and bounded before SQL execution
   * - Content max: 100,000 chars | Title max: 500 chars | Category max: 100 chars
   * - Tags: max 50 entries, each max 200 chars
   * - SQL is fully parameterized ($1-$4), no user input interpolation
   * - Embedding failure is non-fatal (record persists, warning logged)
   *
   * @param params - Write parameters from tool invocation
   * @returns WriteResult with new record ID and path
   * @throws Error if content is empty or exceeds limits
   */
  async write(params: {
    content: string;
    category?: string;
    title?: string;
    tags?: string[];
  }): Promise<WriteResult> {
    // ---- Input validation ----

    const content = (params.content || "").trim();
    if (!content) {
      throw new Error("content is required and must not be empty");
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(
        `content exceeds maximum length: ${content.length} chars (max ${MAX_CONTENT_CHARS})`,
      );
    }

    const category = sanitizeString(params.category, MAX_CATEGORY_LENGTH) || "general";
    const title = sanitizeString(params.title, MAX_TITLE_LENGTH) || null;
    const tags = sanitizeTags(params.tags);

    // ---- Insert record ----
    // SECURITY: Fully parameterized SQL. Table name from config only.
    const insertSql = `
      INSERT INTO ${this.table} (content, category, title, tags, record_type)
      VALUES ($1, $2, $3, $4, 'fact')
      RETURNING id
    `;
    const insertResult = await this.pool.query(insertSql, [content, category, title, tags]);
    const newId: number = insertResult.rows[0].id;

    // ---- Auto-embed (fail-open) ----
    let embedded = false;
    if (this.autoEmbed) {
      embedded = await this.tryEmbed(newId, content);
    }

    const path = `shadowdb/${category}/${newId}`;
    return {
      ok: true,
      operation: "write",
      id: newId,
      path,
      embedded,
      message: `Created record ${newId}${embedded ? " (embedded)" : " (no embedding)"}`,
    };
  }

  /**
   * Update an existing memory record
   *
   * Performs a partial update: only modifies fields that are explicitly provided.
   * If content changes and autoEmbed is enabled, regenerates the embedding vector.
   *
   * SECURITY:
   * - Record existence is verified before update (prevents blind writes)
   * - Dynamic SET clause is built from validated field names only — never from
   *   user-controlled keys. Field names are hardcoded strings, values are $N params.
   * - Same input validation limits as write()
   * - Re-embedding on content change uses same fail-open pattern
   *
   * @param params - Update parameters from tool invocation
   * @returns WriteResult with updated record path
   * @throws Error if record does not exist or all fields are empty
   */
  async update(params: {
    id: number;
    content?: string;
    title?: string;
    category?: string;
    tags?: string[];
  }): Promise<WriteResult> {
    const recordId = params.id;

    // ---- Verify record exists ----
    // SECURITY: Parameterized lookup, table name from config
    const existing = await this.pool.query(
      `SELECT id, content, category FROM ${this.table} WHERE id = $1`,
      [recordId],
    );
    if (existing.rows.length === 0) {
      throw new Error(`Record ${recordId} not found`);
    }

    // ---- Build dynamic SET clause ----
    // SECURITY: Field names are hardcoded strings, never from user input.
    // Only values are parameterized. This prevents SQL injection via field names.
    const setClauses: string[] = [];
    const setValues: unknown[] = [];
    let paramIndex = 1;
    let contentChanged = false;

    if (params.content !== undefined) {
      const content = (params.content || "").trim();
      if (!content) {
        throw new Error("content must not be empty when provided");
      }
      if (content.length > MAX_CONTENT_CHARS) {
        throw new Error(
          `content exceeds maximum length: ${content.length} chars (max ${MAX_CONTENT_CHARS})`,
        );
      }
      setClauses.push(`content = $${paramIndex++}`);
      setValues.push(content);
      contentChanged = content !== existing.rows[0].content;
    }

    if (params.title !== undefined) {
      const title = sanitizeString(params.title, MAX_TITLE_LENGTH);
      setClauses.push(`title = $${paramIndex++}`);
      setValues.push(title || null);
    }

    if (params.category !== undefined) {
      const category = sanitizeString(params.category, MAX_CATEGORY_LENGTH);
      setClauses.push(`category = $${paramIndex++}`);
      setValues.push(category || "general");
    }

    if (params.tags !== undefined) {
      const tags = sanitizeTags(params.tags);
      setClauses.push(`tags = $${paramIndex++}`);
      setValues.push(tags);
    }

    if (setClauses.length === 0) {
      throw new Error("At least one field (content, title, category, tags) must be provided");
    }

    // ---- Execute update ----
    // SECURITY: SET clause uses hardcoded field names + $N params. ID is last param.
    const updateSql = `
      UPDATE ${this.table}
      SET ${setClauses.join(", ")}
      WHERE id = $${paramIndex}
    `;
    setValues.push(recordId);
    await this.pool.query(updateSql, setValues);

    // ---- Re-embed if content changed ----
    let embedded = false;
    if (contentChanged && this.autoEmbed) {
      const newContent = params.content!.trim();
      embedded = await this.tryEmbed(recordId, newContent);
    }

    const category = params.category
      ? sanitizeString(params.category, MAX_CATEGORY_LENGTH) || "general"
      : existing.rows[0].category || "general";
    const path = `shadowdb/${category}/${recordId}`;

    return {
      ok: true,
      operation: "update",
      id: recordId,
      path,
      embedded,
      message: `Updated record ${recordId}${contentChanged ? (embedded ? " (re-embedded)" : " (content changed, no embedding)") : ""}`,
    };
  }

  /**
   * Delete a memory record (soft or hard)
   *
   * Soft-delete (default): Sets `contradicted = TRUE`. The record remains in the
   * database but is excluded from search results by the existing WHERE clause
   * (`contradicted IS NOT TRUE`). This is reversible — set contradicted back to
   * FALSE to restore the record.
   *
   * Hard-delete: Permanently removes the row. Requires `writes.allowDelete = true`
   * in plugin config. This is a two-layer safety gate:
   * 1. `writes.enabled` must be true (checked by tool registration)
   * 2. `writes.allowDelete` must be true (checked here)
   *
   * SECURITY:
   * - Record existence is verified before delete
   * - Hard-delete gate is enforced here as defense-in-depth (also checked in index.ts)
   * - SQL is fully parameterized
   *
   * @param params - Delete parameters from tool invocation
   * @returns WriteResult with deletion confirmation
   * @throws Error if record not found or hard-delete not permitted
   */
  async delete(params: { id: number; hard?: boolean }): Promise<WriteResult> {
    const recordId = params.id;
    const hard = params.hard === true;

    // ---- Verify record exists ----
    const existing = await this.pool.query(
      `SELECT id, category FROM ${this.table} WHERE id = $1`,
      [recordId],
    );
    if (existing.rows.length === 0) {
      throw new Error(`Record ${recordId} not found`);
    }

    const category = existing.rows[0].category || "general";
    const path = `shadowdb/${category}/${recordId}`;

    if (hard) {
      // ---- Hard-delete: permanent removal ----
      // SECURITY: Two-layer gate — writes.enabled (checked by caller) + allowDelete (checked here)
      if (!this.allowDelete) {
        throw new Error(
          "Hard delete is not enabled. Set writes.allowDelete = true in plugin config, " +
            "or omit hard=true for soft-delete.",
        );
      }

      // SECURITY: Parameterized DELETE
      await this.pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [recordId]);

      return {
        ok: true,
        operation: "delete",
        id: recordId,
        path,
        embedded: false,
        message: `Hard-deleted record ${recordId} (permanent)`,
      };
    }

    // ---- Soft-delete: mark as contradicted ----
    // Record stays in DB but is excluded from search by WHERE contradicted IS NOT TRUE
    await this.pool.query(
      `UPDATE ${this.table} SET contradicted = TRUE WHERE id = $1`,
      [recordId],
    );

    return {
      ok: true,
      operation: "delete",
      id: recordId,
      path,
      embedded: false,
      message: `Soft-deleted record ${recordId} (contradicted=true, reversible)`,
    };
  }

  /**
   * Attempt to generate and store an embedding for a record
   *
   * FAIL-OPEN DESIGN: If embedding generation fails (provider down, rate limit,
   * network error), the error is logged as a warning but does NOT propagate to
   * the caller. The record exists without an embedding — it's still searchable
   * via FTS and trigram, just not via vector similarity.
   *
   * This design prioritizes data persistence over search quality. Embeddings
   * can be backfilled later via the batch embedding CLI (roadmap).
   *
   * SECURITY:
   * - Embedding vector is stored as pgvector literal (float[] from trusted embedder)
   * - No user input in the vector literal (numbers come from embedding provider)
   * - SQL is parameterized (vector as $1, id as $2)
   *
   * @param recordId - Record to embed
   * @param content - Content text to generate embedding from
   * @returns true if embedding succeeded, false if it failed (warning logged)
   */
  private async tryEmbed(recordId: number, content: string): Promise<boolean> {
    try {
      const embedding = await this.embedder.embed(content);

      // SECURITY: Vector literal is safe — embedding is float[] from trusted EmbeddingClient
      // which validates dimensions before returning. No user input in the literal.
      const vecLiteral = `[${embedding.join(",")}]`;

      await this.pool.query(
        `UPDATE ${this.table} SET embedding = $1::vector WHERE id = $2`,
        [vecLiteral, recordId],
      );

      return true;
    } catch (err) {
      // FAIL-OPEN: Log warning, do not propagate error
      // Record exists without embedding — still FTS/trigram searchable
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `memory-shadowdb: auto-embed failed for record ${recordId}: ${message}`,
      );
      return false;
    }
  }
}

// ============================================================================
// Input Sanitization Helpers
// ============================================================================

/**
 * Sanitize a string input: trim whitespace and enforce max length
 *
 * Returns empty string for null/undefined/non-string inputs.
 * Truncates at maxLength (does not throw — metadata fields are best-effort).
 *
 * @param value - Raw input value (may be any type)
 * @param maxLength - Maximum allowed character count
 * @returns Sanitized string, empty string if input is invalid
 */
function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/**
 * Sanitize a tags array: validate types, enforce count/length limits
 *
 * SECURITY:
 * - Rejects non-array inputs (returns empty array)
 * - Filters out non-string entries
 * - Trims whitespace and removes empty strings
 * - Truncates individual tags at MAX_TAG_LENGTH (200 chars)
 * - Caps total tag count at MAX_TAGS (50)
 * - Deduplicates tags (case-sensitive)
 *
 * @param tags - Raw tags input (may be any type)
 * @returns Validated and sanitized string array
 */
function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    if (typeof tag !== "string") continue;

    const cleaned = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (!cleaned) continue;

    // Deduplicate (case-sensitive)
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);

    result.push(cleaned);

    // SECURITY: Cap total tag count to prevent GIN index bloat
    if (result.length >= MAX_TAGS) break;
  }

  return result;
}
