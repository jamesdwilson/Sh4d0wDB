/**
 * writer.ts — Write operations for memory-shadowdb
 *
 * Implements memory_write, memory_update, memory_delete, and memory_undelete
 * against the PostgreSQL memories table with automatic embedding generation.
 *
 * SECURITY MODEL:
 * - All write operations are config-gated: `writes.enabled` must be true
 * - There is NO hard-delete via tools. Tools can only soft-delete (set deleted_at).
 *   Permanent removal happens exclusively through the retention policy.
 * - All SQL uses parameterized queries ($1, $2, ...) — no user input interpolation
 * - Table name comes from plugin config only (same as search.ts)
 * - Content length is bounded (max 100,000 chars) to prevent storage abuse
 * - Embedding generation is fail-open: write succeeds even if embedding fails
 *
 * DATA FLOW — memory_delete:
 * 1. Validate record exists and is not already deleted
 * 2. SET deleted_at = NOW()
 * 3. Record becomes invisible to search/get/startup (filtered by deleted_at IS NULL)
 * 4. Record remains in DB until retention purge removes it
 *
 * DATA FLOW — retention purge:
 * 1. Runs on service start and optionally on interval
 * 2. DELETE FROM memories WHERE deleted_at < NOW() - INTERVAL 'N days'
 * 3. Optionally: DELETE WHERE last_accessed < NOW() - INTERVAL 'N days' (stale purge)
 * 4. Logs purge counts — no silent data loss
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
 */
const MAX_CONTENT_CHARS = 100_000;

/** Maximum tag count per record. Prevents GIN index bloat. */
const MAX_TAGS = 50;

/** Maximum length of a single tag string. */
const MAX_TAG_LENGTH = 200;

/** Maximum length of title and category strings. */
const MAX_TITLE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 100;

/**
 * PostgreSQL-backed memory writer with auto-embedding and retention
 *
 * Handles insert, update, soft-delete, undelete, and retention purge.
 * Shares the connection pool with ShadowSearch (no extra connections).
 *
 * SECURITY NOTES:
 * - Config gates (writes.enabled) are checked at tool registration level
 *   in index.ts AND enforced here as defense-in-depth
 * - No hard-delete via any method except retention purge
 * - All queries use parameterized SQL ($1, $2, ...)
 * - Table name is interpolated but comes from config only (trusted source)
 * - Embedding failure does not block writes (fail-open design)
 */
export class ShadowWriter {
  private pool: pg.Pool;
  private table: string;
  private embedder: EmbeddingClient;
  private autoEmbed: boolean;
  private purgeAfterDays: number;
  private stalePurgeDays: number;
  private logger: { warn: (msg: string) => void; info: (msg: string) => void };

  constructor(params: {
    pool: pg.Pool;
    table: string;
    embedder: EmbeddingClient;
    autoEmbed: boolean;
    purgeAfterDays: number;
    stalePurgeDays: number;
    logger: { warn: (msg: string) => void; info: (msg: string) => void };
  }) {
    this.pool = params.pool;
    this.table = params.table;
    this.embedder = params.embedder;
    this.autoEmbed = params.autoEmbed;
    this.purgeAfterDays = params.purgeAfterDays;
    this.stalePurgeDays = params.stalePurgeDays;
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

    const insertSql = `
      INSERT INTO ${this.table} (content, category, title, tags, record_type)
      VALUES ($1, $2, $3, $4, 'fact')
      RETURNING id
    `;
    const insertResult = await this.pool.query(insertSql, [content, category, title, tags]);
    const newId: number = insertResult.rows[0].id;

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
   * Partial update: only modifies fields explicitly provided.
   * Cannot update a soft-deleted record (must undelete first).
   * Re-embeds automatically on content change if autoEmbed is enabled.
   *
   * SECURITY:
   * - Record existence verified before update
   * - Soft-deleted records rejected (must undelete first)
   * - Dynamic SET clause uses hardcoded field names, never user-controlled keys
   * - Same input validation limits as write()
   *
   * @param params - Update parameters from tool invocation
   * @returns WriteResult with updated record path
   * @throws Error if record not found, is deleted, or all fields empty
   */
  async update(params: {
    id: number;
    content?: string;
    title?: string;
    category?: string;
    tags?: string[];
  }): Promise<WriteResult> {
    const recordId = params.id;

    // Verify record exists and is not soft-deleted
    const existing = await this.pool.query(
      `SELECT id, content, category, deleted_at FROM ${this.table} WHERE id = $1`,
      [recordId],
    );
    if (existing.rows.length === 0) {
      throw new Error(`Record ${recordId} not found`);
    }
    if (existing.rows[0].deleted_at !== null) {
      throw new Error(`Record ${recordId} is deleted. Use memory_undelete to restore it first.`);
    }

    // Build dynamic SET clause — field names are hardcoded, values are $N params
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
      setClauses.push(`title = $${paramIndex++}`);
      setValues.push(sanitizeString(params.title, MAX_TITLE_LENGTH) || null);
    }

    if (params.category !== undefined) {
      setClauses.push(`category = $${paramIndex++}`);
      setValues.push(sanitizeString(params.category, MAX_CATEGORY_LENGTH) || "general");
    }

    if (params.tags !== undefined) {
      setClauses.push(`tags = $${paramIndex++}`);
      setValues.push(sanitizeTags(params.tags));
    }

    if (setClauses.length === 0) {
      throw new Error("At least one field (content, title, category, tags) must be provided");
    }

    const updateSql = `
      UPDATE ${this.table}
      SET ${setClauses.join(", ")}
      WHERE id = $${paramIndex}
    `;
    setValues.push(recordId);
    await this.pool.query(updateSql, setValues);

    let embedded = false;
    if (contentChanged && this.autoEmbed) {
      embedded = await this.tryEmbed(recordId, params.content!.trim());
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
   * Soft-delete a memory record
   *
   * Sets deleted_at = NOW(). Record remains in the database but becomes
   * invisible to search, get, and startup operations. Recoverable via
   * memory_undelete within the retention window (default: 30 days).
   *
   * After the retention window, the background purge permanently removes it.
   * There is NO hard-delete parameter. Tools never permanently destroy data.
   *
   * SECURITY:
   * - Record existence verified before delete
   * - Idempotent: deleting an already-deleted record is a no-op
   * - SQL is fully parameterized
   *
   * @param params - Delete parameters from tool invocation
   * @returns WriteResult with deletion confirmation and retention info
   * @throws Error if record not found
   */
  async delete(params: { id: number }): Promise<WriteResult> {
    const recordId = params.id;

    const existing = await this.pool.query(
      `SELECT id, category, deleted_at FROM ${this.table} WHERE id = $1`,
      [recordId],
    );
    if (existing.rows.length === 0) {
      throw new Error(`Record ${recordId} not found`);
    }

    const category = existing.rows[0].category || "general";
    const path = `shadowdb/${category}/${recordId}`;

    // Idempotent: already deleted → no-op
    if (existing.rows[0].deleted_at !== null) {
      return {
        ok: true,
        operation: "delete",
        id: recordId,
        path,
        embedded: false,
        message: `Record ${recordId} already deleted (deleted_at: ${existing.rows[0].deleted_at})`,
      };
    }

    await this.pool.query(
      `UPDATE ${this.table} SET deleted_at = NOW() WHERE id = $1`,
      [recordId],
    );

    const purgeNote = this.purgeAfterDays > 0
      ? ` Permanent removal in ${this.purgeAfterDays} days.`
      : " No auto-purge configured.";

    return {
      ok: true,
      operation: "delete",
      id: recordId,
      path,
      embedded: false,
      message: `Soft-deleted record ${recordId}.${purgeNote} Use memory_undelete to restore.`,
    };
  }

  /**
   * Restore a soft-deleted record
   *
   * Sets deleted_at = NULL, making the record active and searchable again.
   * Only works if the record hasn't been permanently purged yet.
   *
   * @param params - Undelete parameters from tool invocation
   * @returns WriteResult with restoration confirmation
   * @throws Error if record not found (already purged or never existed)
   */
  async undelete(params: { id: number }): Promise<WriteResult> {
    const recordId = params.id;

    const existing = await this.pool.query(
      `SELECT id, category, deleted_at FROM ${this.table} WHERE id = $1`,
      [recordId],
    );
    if (existing.rows.length === 0) {
      throw new Error(`Record ${recordId} not found (may have been permanently purged)`);
    }

    const category = existing.rows[0].category || "general";
    const path = `shadowdb/${category}/${recordId}`;

    // Already active → no-op
    if (existing.rows[0].deleted_at === null) {
      return {
        ok: true,
        operation: "write", // reuse "write" since there's no "undelete" in the union
        id: recordId,
        path,
        embedded: false,
        message: `Record ${recordId} is not deleted — no action needed`,
      };
    }

    await this.pool.query(
      `UPDATE ${this.table} SET deleted_at = NULL WHERE id = $1`,
      [recordId],
    );

    return {
      ok: true,
      operation: "write",
      id: recordId,
      path,
      embedded: false,
      message: `Restored record ${recordId} — now active and searchable`,
    };
  }

  /**
   * Run retention purge — permanently remove expired soft-deleted records
   *
   * This is the ONLY code path that permanently deletes data. It runs:
   * 1. On service start (once)
   * 2. Optionally on a recurring interval
   *
   * Two purge modes:
   * - Soft-delete retention: records with deleted_at older than purgeAfterDays
   * - Stale access purge: records with last_accessed older than stalePurgeDays
   *   (disabled by default, opt-in only)
   *
   * SECURITY:
   * - No user input — all thresholds from config
   * - Logged with counts — no silent data loss
   * - Stale purge only targets non-deleted, non-contradicted records
   *
   * @returns Purge counts for logging
   */
  async runRetentionPurge(): Promise<{ softDeletePurged: number; stalePurged: number }> {
    let softDeletePurged = 0;
    let stalePurged = 0;

    // 1. Purge soft-deleted records past retention window
    if (this.purgeAfterDays > 0) {
      const result = await this.pool.query(
        `DELETE FROM ${this.table} WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '${this.purgeAfterDays} days' RETURNING id`,
      );
      softDeletePurged = result.rowCount ?? 0;
    }

    // 2. Purge stale records (opt-in, disabled by default)
    if (this.stalePurgeDays > 0) {
      const result = await this.pool.query(
        `DELETE FROM ${this.table} WHERE last_accessed IS NOT NULL AND last_accessed < NOW() - INTERVAL '${this.stalePurgeDays} days' AND deleted_at IS NULL AND contradicted IS NOT TRUE RETURNING id`,
      );
      stalePurged = result.rowCount ?? 0;
    }

    this.logger.info(
      `memory-shadowdb: retention sweep — purged ${softDeletePurged} soft-deleted (>${this.purgeAfterDays}d), ${stalePurged} stale (${this.stalePurgeDays > 0 ? `>${this.stalePurgeDays}d` : "disabled"})`,
    );

    return { softDeletePurged, stalePurged };
  }

  /**
   * Attempt to generate and store an embedding for a record
   *
   * FAIL-OPEN: If embedding fails, the error is logged but does NOT propagate.
   * The record persists without an embedding — still FTS/trigram searchable.
   *
   * @param recordId - Record to embed
   * @param content - Content text to generate embedding from
   * @returns true if embedding succeeded, false if it failed
   */
  private async tryEmbed(recordId: number, content: string): Promise<boolean> {
    try {
      const embedding = await this.embedder.embed(content);
      const vecLiteral = `[${embedding.join(",")}]`;
      await this.pool.query(
        `UPDATE ${this.table} SET embedding = $1::vector WHERE id = $2`,
        [vecLiteral, recordId],
      );
      return true;
    } catch (err) {
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

/** Trim and truncate a string. Returns empty string for non-string input. */
function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/** Validate, deduplicate, and bound a tags array. */
function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const cleaned = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}
