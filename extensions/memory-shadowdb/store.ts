/**
 * store.ts — Abstract base class for memory storage backends
 *
 * Defines the MemoryStore interface that all backends (Postgres, SQLite, MySQL)
 * must implement. Contains shared logic that is identical across backends:
 *
 * - Reciprocal Rank Fusion (RRF) merge of search signals
 * - Startup context assembly (priority ordering, char budgeting, digest)
 * - Relative age formatting ("5d ago")
 * - Snippet and full-record formatting
 * - Input validation and sanitization for writes
 *
 * The contract: backends implement the abstract methods (raw DB operations).
 * This class handles the orchestration and formatting.
 *
 * SECURITY MODEL:
 * - No SQL in this file — all queries delegated to backend implementations
 * - Input validation/sanitization centralized here (single enforcement point)
 * - maxChars bounds on startup injection prevent context overflow
 */

import { createHash } from "node:crypto";
import type { SearchResult, WriteResult } from "./types.js";
import type { EmbeddingClient } from "./embedder.js";

// ============================================================================
// Constants — shared validation limits
// ============================================================================

/** Maximum content length in characters. ~100KB of UTF-8 text. */
export const MAX_CONTENT_CHARS = 100_000;

/** Maximum tag count per record. Prevents index bloat. */
export const MAX_TAGS = 50;

/** Maximum length of a single tag string. */
export const MAX_TAG_LENGTH = 200;

/** Maximum length of title and category strings. */
export const MAX_TITLE_LENGTH = 500;
export const MAX_CATEGORY_LENGTH = 100;

/** RRF constant k — standard value from the original RRF paper. */
export const RRF_K = 60;

// ============================================================================
// Types — internal to store layer
// ============================================================================

/**
 * A single ranked hit from one search signal (vector, FTS, fuzzy).
 * Each backend returns these; the base class merges them via RRF.
 */
export interface RankedHit {
  id: number;
  content: string;
  category: string | null;
  title: string | null;
  record_type: string | null;
  created_at: Date | string | null;
  /** 1-based rank within this signal's result set */
  rank: number;
  /** Raw score from the signal (for diagnostics, not used in RRF) */
  rawScore?: number;
}

/** A row from the startup table. */
export interface StartupRow {
  key: string;
  content: string;
}

/** Logger interface — subset of what OpenClaw provides. */
export interface StoreLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
}

/** Configuration passed to store constructors. */
export interface StoreConfig {
  /** Database table name (default: "memories") */
  table: string;
  /** RRF weight for vector similarity signal */
  vectorWeight: number;
  /** RRF weight for full-text search signal */
  textWeight: number;
  /** RRF weight for recency signal (intentionally low — tiebreaker, not dominant) */
  recencyWeight: number;
  /** Whether to auto-embed on write/update */
  autoEmbed: boolean;
  /** Days before soft-deleted records are permanently purged (0 = never) */
  purgeAfterDays: number;
}

// ============================================================================
// Abstract Base Class
// ============================================================================

/**
 * Abstract memory store — the contract all backends implement.
 *
 * Shared logic lives here. Backend-specific SQL lives in subclasses.
 * The search pipeline is a template method:
 *   1. Backend runs vectorSearch(), textSearch(), fuzzySearch() in parallel
 *   2. Base class merges results via RRF
 *   3. Base class formats snippets and returns SearchResult[]
 */
export abstract class MemoryStore {
  protected embedder: EmbeddingClient;
  protected config: StoreConfig;
  protected logger: StoreLogger;

  constructor(embedder: EmbeddingClient, config: StoreConfig, logger: StoreLogger) {
    this.embedder = embedder;
    this.config = config;
    this.logger = logger;
  }

  // ==========================================================================
  // SEARCH — template method pattern
  // ==========================================================================

  /**
   * Hybrid search: run backend-specific search legs, merge via RRF.
   *
   * Each backend implements vectorSearch/textSearch/fuzzySearch. This method
   * orchestrates them in parallel and combines results using Reciprocal Rank
   * Fusion. The formula: score = Σ weight/(k+rank) across all signals.
   *
   * @param query - User's search query
   * @param maxResults - Maximum results to return
   * @param minScore - Minimum RRF score threshold
   * @returns Ranked, deduplicated results with snippets and citations
   */
  async search(query: string, maxResults: number, minScore: number): Promise<SearchResult[]> {
    const embedding = await this.embedder.embed(query);
    const oversample = maxResults * 5;

    // Run all search legs in parallel — backends return [] for unsupported signals
    const [vectorHits, ftsHits, fuzzyHits] = await Promise.all([
      this.vectorSearch(query, embedding, oversample),
      this.textSearch(query, oversample),
      this.fuzzySearch(query, oversample),
    ]);

    // Merge via RRF
    const merged = this.mergeRRF(vectorHits, ftsHits, fuzzyHits, maxResults, minScore);

    // Format as SearchResult[]
    return merged.map((hit) => {
      const snippet = this.formatSnippet(hit);
      const virtualPath = `shadowdb/${hit.category || "general"}/${hit.id}`;
      return {
        path: virtualPath,
        startLine: 1,
        endLine: 1,
        score: hit.rrfScore,
        snippet,
        source: "memory",
        citation: `shadowdb:${this.config.table}#${hit.id}`,
      };
    });
  }

  /**
   * Reciprocal Rank Fusion — merge ranked lists from multiple signals.
   *
   * RRF formula: score_i = Σ_signal weight_signal / (k + rank_signal_i)
   * where k=60 (standard constant from Cormack et al., 2009).
   *
   * Advantages over raw score combination:
   * - No score normalization needed (different signals have different scales)
   * - Robust to outliers in any single signal
   * - Simple, well-studied, hard to break
   */
  private mergeRRF(
    vectorHits: RankedHit[],
    ftsHits: RankedHit[],
    fuzzyHits: RankedHit[],
    maxResults: number,
    minScore: number,
  ): Array<RankedHit & { rrfScore: number }> {
    // Build a map of id → accumulated RRF score + best metadata
    const scoreMap = new Map<number, {
      hit: RankedHit;
      rrfScore: number;
    }>();

    const addSignal = (hits: RankedHit[], weight: number) => {
      for (const hit of hits) {
        const contribution = weight / (RRF_K + hit.rank);
        const existing = scoreMap.get(hit.id);
        if (existing) {
          existing.rrfScore += contribution;
        } else {
          scoreMap.set(hit.id, { hit, rrfScore: contribution });
        }
      }
    };

    addSignal(vectorHits, this.config.vectorWeight);
    addSignal(ftsHits, this.config.textWeight);
    addSignal(fuzzyHits, 0.2); // fixed trigram weight

    // Recency boost: newest records get a small rank-based boost.
    // We rank ALL seen records by created_at (newest first) and apply RRF.
    const allEntries = [...scoreMap.values()];
    const byRecency = [...allEntries]
      .filter((e) => e.hit.created_at != null)
      .sort((a, b) => {
        const dateA = a.hit.created_at instanceof Date ? a.hit.created_at : new Date(a.hit.created_at!);
        const dateB = b.hit.created_at instanceof Date ? b.hit.created_at : new Date(b.hit.created_at!);
        return dateB.getTime() - dateA.getTime(); // newest first
      });

    byRecency.forEach((entry, idx) => {
      entry.rrfScore += this.config.recencyWeight / (RRF_K + idx + 1);
    });

    // Sort by RRF score descending, apply threshold, return top N
    return allEntries
      .filter((e) => e.rrfScore > Math.max(minScore, 0.001))
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, maxResults)
      .map((e) => ({ ...e.hit, rrfScore: e.rrfScore }));
  }

  // ==========================================================================
  // STARTUP CONTEXT — shared assembly logic
  // ==========================================================================

  /**
   * Load startup context from the `startup` table.
   *
   * Fetches rows ordered by priority, formats as markdown sections,
   * enforces maxChars budget, and generates a content digest for caching.
   *
   * @param maxChars - Maximum characters to return (truncation marked in output)
   * @returns Startup context with text, digest, and metadata; null if no rows
   */
  async getStartupContext(maxChars: number): Promise<{
    text: string;
    digest: string;
    totalChars: number;
    rowCount: number;
    truncated: boolean;
  } | null> {
    const rows = await this.getStartupRows();
    if (rows.length === 0) return null;

    // Format each row as a markdown section: ## {key}\n{content}
    const sections = rows
      .map((row) => {
        const key = String(row.key || "startup").trim();
        const content = String(row.content || "").trim();
        return content ? `## ${key}\n${content}` : "";
      })
      .filter(Boolean);

    if (sections.length === 0) return null;

    const fullText = sections.join("\n\n");
    const digest = createHash("sha1").update(fullText).digest("hex").slice(0, 16);

    const trimmedMax = Math.max(0, maxChars);
    const truncated = trimmedMax > 0 && fullText.length > trimmedMax;
    const text = truncated
      ? `${truncateCleanly(fullText, trimmedMax)}\n\n[...startup context truncated...]`
      : fullText;

    return { text, digest, totalChars: fullText.length, rowCount: sections.length, truncated };
  }

  // ==========================================================================
  // WRITE OPERATIONS — validation + delegation
  // ==========================================================================

  /**
   * Create a new memory record.
   *
   * Validates and sanitizes input, delegates to backend insertRecord(),
   * then optionally generates an embedding.
   */
  async write(params: {
    content: string;
    category?: string;
    title?: string;
    tags?: string[];
  }): Promise<WriteResult> {
    const content = validateContent(params.content);
    const category = sanitizeString(params.category, MAX_CATEGORY_LENGTH) || "general";
    const title = sanitizeString(params.title, MAX_TITLE_LENGTH) || null;
    const tags = sanitizeTags(params.tags);

    const newId = await this.insertRecord({ content, category, title, tags });

    let embedded = false;
    if (this.config.autoEmbed) {
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
   * Update an existing memory record (partial update).
   *
   * Validates inputs, checks record exists and is not deleted,
   * delegates to backend updateRecord(), re-embeds if content changed.
   */
  async update(params: {
    id: number;
    content?: string;
    title?: string;
    category?: string;
    tags?: string[];
  }): Promise<WriteResult> {
    const existing = await this.getRecordMeta(params.id);
    if (!existing) throw new Error(`Record ${params.id} not found`);
    if (existing.deleted_at !== null) {
      throw new Error(`Record ${params.id} is deleted. Use memory_undelete to restore it first.`);
    }

    // Build validated patch
    const patch: Record<string, unknown> = {};
    let contentChanged = false;

    if (params.content !== undefined) {
      const content = validateContent(params.content);
      patch.content = content;
      contentChanged = content !== existing.content;
    }
    if (params.title !== undefined) {
      patch.title = sanitizeString(params.title, MAX_TITLE_LENGTH) || null;
    }
    if (params.category !== undefined) {
      patch.category = sanitizeString(params.category, MAX_CATEGORY_LENGTH) || "general";
    }
    if (params.tags !== undefined) {
      patch.tags = sanitizeTags(params.tags);
    }

    if (Object.keys(patch).length === 0) {
      throw new Error("At least one field (content, title, category, tags) must be provided");
    }

    await this.updateRecord(params.id, patch);

    let embedded = false;
    if (contentChanged && this.config.autoEmbed) {
      embedded = await this.tryEmbed(params.id, patch.content as string);
    }

    const category = (patch.category as string) || existing.category || "general";
    const path = `shadowdb/${category}/${params.id}`;
    return {
      ok: true,
      operation: "update",
      id: params.id,
      path,
      embedded,
      message: `Updated record ${params.id}${contentChanged ? (embedded ? " (re-embedded)" : " (content changed, no embedding)") : ""}`,
    };
  }

  /**
   * Soft-delete a record (set deleted_at, never permanent).
   * Idempotent: deleting an already-deleted record is a no-op.
   */
  async delete(params: { id: number }): Promise<WriteResult> {
    const existing = await this.getRecordMeta(params.id);
    if (!existing) throw new Error(`Record ${params.id} not found`);

    const category = existing.category || "general";
    const path = `shadowdb/${category}/${params.id}`;

    if (existing.deleted_at !== null) {
      return {
        ok: true, operation: "delete", id: params.id, path, embedded: false,
        message: `Record ${params.id} already deleted (deleted_at: ${existing.deleted_at})`,
      };
    }

    await this.softDeleteRecord(params.id);

    const purgeNote = this.config.purgeAfterDays > 0
      ? ` Permanent removal in ${this.config.purgeAfterDays} days.`
      : " No auto-purge configured.";

    return {
      ok: true, operation: "delete", id: params.id, path, embedded: false,
      message: `Soft-deleted record ${params.id}.${purgeNote} Use memory_undelete to restore.`,
    };
  }

  /**
   * Restore a soft-deleted record (clear deleted_at).
   */
  async undelete(params: { id: number }): Promise<WriteResult> {
    const existing = await this.getRecordMeta(params.id);
    if (!existing) {
      throw new Error(`Record ${params.id} not found (may have been permanently purged)`);
    }

    const category = existing.category || "general";
    const path = `shadowdb/${category}/${params.id}`;

    if (existing.deleted_at === null) {
      return {
        ok: true, operation: "write", id: params.id, path, embedded: false,
        message: `Record ${params.id} is not deleted — no action needed`,
      };
    }

    await this.restoreRecord(params.id);

    return {
      ok: true, operation: "write", id: params.id, path, embedded: false,
      message: `Restored record ${params.id} — now active and searchable`,
    };
  }

  /**
   * Run retention purge — permanently remove expired soft-deleted records.
   * This is the ONLY code path that permanently deletes data.
   */
  async runRetentionPurge(): Promise<{ softDeletePurged: number }> {
    let purged = 0;
    if (this.config.purgeAfterDays > 0) {
      purged = await this.purgeExpiredRecords(this.config.purgeAfterDays);
    }
    this.logger.info(
      `memory-shadowdb: retention sweep — purged ${purged} soft-deleted (>${this.config.purgeAfterDays}d)`,
    );
    return { softDeletePurged: purged };
  }

  // ==========================================================================
  // EMBEDDING — shared try-embed logic
  // ==========================================================================

  /**
   * Attempt to generate and store an embedding for a record.
   * FAIL-OPEN: errors logged but don't propagate. Record persists without vector.
   */
  protected async tryEmbed(recordId: number, content: string): Promise<boolean> {
    try {
      const embedding = await this.embedder.embed(content);
      await this.storeEmbedding(recordId, embedding);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`memory-shadowdb: auto-embed failed for record ${recordId}: ${message}`);
      return false;
    }
  }

  // ==========================================================================
  // FORMATTING — shared across all backends
  // ==========================================================================

  /**
   * Format a search result snippet.
   * Compact: [category] | 3d ago\n{content truncated to 700 chars}
   */
  protected formatSnippet(row: {
    id: number;
    content: string;
    category?: string | null;
    title?: string | null;
    record_type?: string | null;
    created_at?: Date | string | null;
  }): string {
    const maxChars = 700;
    const header = [
      row.category ? `[${row.category}]` : null,
      row.created_at ? formatRelativeAge(row.created_at) : null,
    ].filter(Boolean).join(" | ");

    const prefix = header ? `${header}\n` : "";
    const body = (row.content || "").slice(0, maxChars - prefix.length);
    return `${prefix}${body}`.trim();
  }

  /**
   * Format a full record for memory_get results (no truncation).
   */
  formatFullRecord(row: {
    id: number;
    content: string;
    category?: string | null;
    title?: string | null;
    record_type?: string | null;
  }): string {
    const parts: string[] = [];
    if (row.title) parts.push(`# ${row.title}`);
    if (row.category) parts.push(`Category: ${row.category}`);
    if (row.record_type) parts.push(`Type: ${row.record_type}`);
    parts.push("");
    parts.push(row.content || "");
    return parts.join("\n");
  }

  // ==========================================================================
  // ABSTRACT METHODS — each backend implements these
  // ==========================================================================

  // --- Search legs (return ranked hits for RRF merge) ---

  /** Vector similarity search. Return [] if backend doesn't support vectors. */
  protected abstract vectorSearch(query: string, embedding: number[], limit: number): Promise<RankedHit[]>;

  /** Full-text keyword search. All backends should support this. */
  protected abstract textSearch(query: string, limit: number): Promise<RankedHit[]>;

  /** Fuzzy/typo-tolerant search. Return [] if unsupported (e.g., SQLite, MySQL). */
  protected abstract fuzzySearch(query: string, limit: number): Promise<RankedHit[]>;

  // --- Read operations ---

  /** Fetch a single record by ID (null if not found or deleted). */
  abstract get(id: number): Promise<{ text: string; path: string } | null>;

  /** Fetch by virtual path (category listing or specific record). */
  abstract getByPath(pathQuery: string, from?: number, lines?: number): Promise<{ text: string; path: string }>;

  /** Fetch startup rows ordered by priority. */
  protected abstract getStartupRows(): Promise<StartupRow[]>;

  // --- Write operations (raw DB, no validation — base class validates first) ---

  /** Insert a new record, return the new ID. */
  protected abstract insertRecord(params: {
    content: string;
    category: string;
    title: string | null;
    tags: string[];
  }): Promise<number>;

  /** Update record fields by ID. */
  protected abstract updateRecord(id: number, patch: Record<string, unknown>): Promise<void>;

  /** Set deleted_at = now() on a record. */
  protected abstract softDeleteRecord(id: number): Promise<void>;

  /** Clear deleted_at on a record. */
  protected abstract restoreRecord(id: number): Promise<void>;

  /** Delete records where deleted_at is older than N days. Return count. */
  protected abstract purgeExpiredRecords(days: number): Promise<number>;

  /** Store an embedding vector for a record. */
  protected abstract storeEmbedding(id: number, embedding: number[]): Promise<void>;

  /** Get minimal record metadata for validation (exists? deleted?). */
  protected abstract getRecordMeta(id: number): Promise<{
    id: number;
    content: string;
    category: string | null;
    deleted_at: string | Date | null;
  } | null>;

  // --- Lifecycle ---

  /** Health check. */
  abstract ping(): Promise<boolean>;

  /** Clean shutdown (close connections/pools). */
  abstract close(): Promise<void>;

  /** Initialize backend (create tables if needed). */
  abstract initialize(): Promise<void>;
}

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Truncate text at a clean boundary (section > paragraph > sentence > word).
 * Walks backward from maxChars to find the best break point.
 * Falls back to hard cut only if no break found in the last 200 chars.
 */
function truncateCleanly(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);

  // Try to break at a section boundary (## heading)
  const lastSection = slice.lastIndexOf("\n## ");
  if (lastSection > maxChars - 500 && lastSection > 0) {
    return slice.slice(0, lastSection).trimEnd();
  }

  // Try to break at a paragraph boundary (double newline)
  const lastPara = slice.lastIndexOf("\n\n");
  if (lastPara > maxChars - 300 && lastPara > 0) {
    return slice.slice(0, lastPara).trimEnd();
  }

  // Try to break at a sentence boundary (. or \n followed by content)
  const lastSentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("\n"),
  );
  if (lastSentence > maxChars - 200 && lastSentence > 0) {
    return slice.slice(0, lastSentence + 1).trimEnd();
  }

  // Try to break at a word boundary (space)
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars - 100 && lastSpace > 0) {
    return slice.slice(0, lastSpace).trimEnd();
  }

  // Hard cut — no clean break found
  return slice;
}

/** Validate content: required, non-empty, bounded length. */
function validateContent(raw: unknown): string {
  const content = (typeof raw === "string" ? raw : "").trim();
  if (!content) throw new Error("content is required and must not be empty");
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`content exceeds maximum length: ${content.length} chars (max ${MAX_CONTENT_CHARS})`);
  }
  return content;
}

/** Trim and truncate a string. Returns empty string for non-string input. */
export function sanitizeString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

/** Validate, deduplicate, and bound a tags array. */
export function sanitizeTags(tags: unknown): string[] {
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

/**
 * Format a timestamp as a compact relative age string.
 * Examples: "2h ago", "3d ago", "2w ago", "3mo ago", "1y ago"
 */
export function formatRelativeAge(timestamp: string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(date.getTime())) return "";

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days < 14) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
