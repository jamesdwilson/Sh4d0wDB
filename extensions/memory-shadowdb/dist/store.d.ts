/**
 * store.ts — Abstract base class for memory storage backends
 *
 * Defines the MemoryStore interface that all backends (Postgres, SQLite, MySQL)
 * must implement. Contains shared logic that is identical across backends:
 *
 * - Reciprocal Rank Fusion (RRF) merge of search signals
 * - Primer context assembly (priority ordering, char budgeting, digest)
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
 * - maxChars bounds on primer injection prevent context overflow
 */
import type { SearchResult, WriteResult, SearchFilters, AssembleResult } from "./types.js";
import type { EmbeddingClient } from "./embedder.js";
/** Maximum content length in characters. ~100KB of UTF-8 text. */
export declare const MAX_CONTENT_CHARS = 100000;
/** Maximum tag count per record. Prevents index bloat. */
export declare const MAX_TAGS = 50;
/** Maximum length of a single tag string. */
export declare const MAX_TAG_LENGTH = 200;
/** Maximum length of title and category strings. */
export declare const MAX_TITLE_LENGTH = 500;
export declare const MAX_CATEGORY_LENGTH = 100;
/** RRF constant k — standard value from the original RRF paper. */
export declare const RRF_K = 60;
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
/** A row from the primer table. */
export interface PrimerRow {
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
/**
 * Abstract memory store — the contract all backends implement.
 *
 * Shared logic lives here. Backend-specific SQL lives in subclasses.
 * The search pipeline is a template method:
 *   1. Backend runs vectorSearch(), textSearch(), fuzzySearch() in parallel
 *   2. Base class merges results via RRF
 *   3. Base class formats snippets and returns SearchResult[]
 */
export declare abstract class MemoryStore {
    protected embedder: EmbeddingClient;
    protected config: StoreConfig;
    protected logger: StoreLogger;
    constructor(embedder: EmbeddingClient, config: StoreConfig, logger: StoreLogger);
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
     * @param filters - Optional structured filters passed to backend search legs
     * @param detailLevel - Output detail: summary (no content), snippet (default), full (no truncation)
     * @returns Ranked, deduplicated results with snippets and citations
     */
    search(query: string, maxResults: number, minScore: number, filters?: SearchFilters, detailLevel?: "summary" | "snippet" | "section" | "full"): Promise<SearchResult[]>;
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
    /**
     * Assemble context from multiple records within a token budget.
     *
     * Pipeline:
     * 1. Run broad vector search (maxResults=50, minScore=0.001) with optional filters
     * 2. Score each hit: relevance*0.5 + recency_norm*0.2 + (priority/10)*0.3
     *    (weights shifted by `prioritize` param)
     * 3. Fill token budget (approx 4 chars/token) highest score first
     * 4. Return assembled text with citations block
     */
    /** Token budget defaults for task_type presets */
    static readonly TASK_TYPE_BUDGETS: Record<string, number>;
    assemble(params: {
        query: string;
        token_budget?: number;
        task_type?: "quick" | "outreach" | "dossier" | "research";
        include_categories?: string[];
        include_tags?: string[];
        exclude_categories?: string[];
        prioritize?: "relevance" | "recency" | "priority";
    }): Promise<AssembleResult>;
    /**
     * Load primer context from the `primer` table.
     *
     * Uses PROGRESSIVE FILL (reverse pyramid): rows are ordered by priority
     * (lowest = most important). Each complete section is added only if it fits
     * the remaining character budget. This ensures:
     *
     * - Small models get only the most critical rows (identity, safety)
     * - Large models get everything that fits
     * - Sections are NEVER cut mid-content — you get whole sections or nothing
     * - Priority ordering means the most important context always wins
     *
     * Example with 3000 char budget and rows at priority 0/1/2/3:
     *   Priority 0 (soul, 222 chars)       → fits ✅ (2778 remaining)
     *   Priority 0 (core-rules, 603 chars)  → fits ✅ (2175 remaining)
     *   Priority 1 (nag-system, 890 chars)  → fits ✅ (1285 remaining)
     *   Priority 1 (tool-rules, 912 chars)  → fits ✅ (373 remaining)
     *   Priority 1 (beat-cycle, 627 chars)  → SKIP ❌ (over budget)
     *   Priority 2+ → all skipped
     *
     * @param maxChars - Character budget (0 = unlimited)
     * @returns Primer context with text, digest, and metadata; null if no rows
     */
    getPrimerContext(maxChars: number): Promise<{
        text: string;
        digest: string;
        totalChars: number;
        rowCount: number;
        includedCount: number;
        skippedKeys: string[];
        truncated: boolean;
    } | null>;
    /**
     * Create a new memory record.
     *
     * Validates and sanitizes input, delegates to backend insertRecord(),
     * then optionally generates an embedding.
     */
    write(params: {
        content: string;
        category?: string;
        title?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
        parent_id?: number;
        priority?: number;
    }): Promise<WriteResult>;
    /**
     * Update an existing memory record (partial update).
     *
     * Validates inputs, checks record exists and is not deleted,
     * delegates to backend updateRecord(), re-embeds if content changed.
     */
    update(params: {
        id: number;
        content?: string;
        title?: string;
        category?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
        parent_id?: number | null;
        priority?: number;
    }): Promise<WriteResult>;
    /**
     * Soft-delete a record (set deleted_at, never permanent).
     * Idempotent: deleting an already-deleted record is a no-op.
     */
    delete(params: {
        id: number;
    }): Promise<WriteResult>;
    /**
     * Restore a soft-deleted record (clear deleted_at).
     */
    undelete(params: {
        id: number;
    }): Promise<WriteResult>;
    /**
     * Run retention purge — permanently remove expired soft-deleted records.
     * This is the ONLY code path that permanently deletes data.
     *
     * Before deleting, exports all expired records to a JSON file and moves
     * it to the system trash (or a recovery folder). Nothing is ever lost
     * without a recoverable copy existing first.
     */
    runRetentionPurge(): Promise<{
        softDeletePurged: number;
    }>;
    /**
     * Move a file to system trash. Tries platform-native trash commands,
     * falls back to leaving the file in place (still recoverable).
     */
    private moveToTrash;
    /**
     * Attempt to generate and store an embedding for a record.
     * FAIL-OPEN: errors logged but don't propagate. Record persists without vector.
     */
    protected tryEmbed(recordId: number, content: string): Promise<boolean>;
    /**
     * Re-embed all non-deleted records with the current embedding configuration.
     * Cursor-based iteration to keep memory bounded. Errors are logged and skipped.
     */
    reembedAll(onProgress?: (done: number, total: number) => void): Promise<{
        success: number;
        errors: number;
    }>;
    /**
     * Format a search result snippet.
     * Compact: category|3d\n{content truncated to 700 chars}
     */
    protected formatSnippet(row: {
        id: number;
        content: string;
        category?: string | null;
        title?: string | null;
        record_type?: string | null;
        created_at?: Date | string | null;
    }): string;
    /**
     * Format a full record for memory_get results (no truncation).
     */
    formatFullRecord(row: {
        id: number;
        content: string;
        category?: string | null;
        title?: string | null;
        record_type?: string | null;
    }): string;
    /**
     * Format a section-level result: return the full content up to the most
     * relevant ## heading block (~200-500 tokens). If no heading structure,
     * falls back to snippet behavior.
     *
     * Selects the best section by counting query term overlaps in each block.
     */
    protected formatSection(row: {
        id: number;
        content: string;
        category?: string | null;
        title?: string | null;
        record_type?: string | null;
        created_at?: Date | string | null;
    }, query: string): string;
    /** Get a metadata value by key from the _meta table. */
    abstract getMetaValue(key: string): Promise<string | null>;
    /** Set a metadata value by key in the _meta table. */
    abstract setMetaValue(key: string, value: string): Promise<void>;
    /** Fetch a batch of non-deleted record IDs and content for re-embedding (cursor-based). */
    protected abstract getRecordBatch(afterId: number, limit: number): Promise<Array<{
        id: number;
        content: string;
    }>>;
    /** Vector similarity search. Return [] if backend doesn't support vectors. */
    protected abstract vectorSearch(query: string, embedding: number[], limit: number, filters?: SearchFilters): Promise<RankedHit[]>;
    /** Full-text keyword search. All backends should support this. */
    protected abstract textSearch(query: string, limit: number, filters?: SearchFilters): Promise<RankedHit[]>;
    /** Fuzzy/typo-tolerant search. Return [] if unsupported (e.g., SQLite, MySQL). */
    protected abstract fuzzySearch(query: string, limit: number, filters?: SearchFilters): Promise<RankedHit[]>;
    /** Fetch a single record by ID (null if not found or deleted). */
    abstract get(id: number, opts?: {
        include_children?: boolean;
        section?: string;
    }): Promise<{
        text: string;
        path: string;
    } | null>;
    /** Fetch by virtual path (category listing or specific record). */
    abstract getByPath(pathQuery: string, from?: number, lines?: number, opts?: {
        include_children?: boolean;
        section?: string;
    }): Promise<{
        text: string;
        path: string;
    }>;
    /** Fetch primer rows ordered by priority. */
    protected abstract getPrimerRows(): Promise<PrimerRow[]>;
    /** Insert a new record, return the new ID. */
    /** List records with optional filters. */
    abstract list(params: {
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
        sort?: "created_at" | "updated_at" | "priority" | "title" | string;
        sort_order?: "asc" | "desc";
        limit?: number;
        offset?: number;
    }): Promise<import("./types.js").ListResult[]>;
    protected abstract insertRecord(params: {
        content: string;
        category: string;
        title: string | null;
        tags: string[];
        metadata: Record<string, unknown>;
        parent_id: number | null;
        priority: number;
    }): Promise<number>;
    /** Update record fields by ID. */
    protected abstract updateRecord(id: number, patch: Record<string, unknown>): Promise<void>;
    /** Set deleted_at = now() on a record. */
    protected abstract softDeleteRecord(id: number): Promise<void>;
    /** Clear deleted_at on a record. */
    protected abstract restoreRecord(id: number): Promise<void>;
    /** Fetch records where deleted_at is older than N days (before purging). */
    protected abstract fetchExpiredRecords(days: number): Promise<Array<{
        id: number;
        content: string;
        category: string | null;
        title: string | null;
        deleted_at: string | Date;
    }>>;
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
    /** Health check. */
    abstract ping(): Promise<boolean>;
    /** Clean shutdown (close connections/pools). */
    abstract close(): Promise<void>;
    /** Initialize backend (create tables if needed). */
    abstract initialize(): Promise<void>;
}
/**
 * Truncate text at a clean boundary (section > paragraph > sentence > word).
 * Walks backward from maxChars to find the best break point.
 * Falls back to hard cut only if no break found in the last 200 chars.
 */
export declare function truncateCleanly(text: string, maxChars: number): string;
/** Trim and truncate a string. Returns empty string for non-string input. */
export declare function sanitizeString(value: unknown, maxLength: number): string;
/** Validate, deduplicate, and bound a tags array. */
export declare function sanitizeTags(tags: unknown): string[];
/**
 * Format a timestamp as a compact relative age string.
 * Examples: "2h ago", "3d ago", "2w ago", "3mo ago", "1y ago"
 */
export declare function formatRelativeAge(timestamp: string | Date): string;
