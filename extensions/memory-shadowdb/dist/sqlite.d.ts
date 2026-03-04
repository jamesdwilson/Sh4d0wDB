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
/**
 * SQLite-backed memory store.
 *
 * Zero-config backend: single file, no server, no extensions to install
 * (sqlite-vec is loaded as a runtime extension if available).
 * FTS5 is built into SQLite. Trigram tokenizer provides substring/fuzzy matching.
 */
export declare class SQLiteStore extends MemoryStore {
    private db;
    private dbPath;
    private hasVec;
    constructor(params: {
        dbPath: string;
        embedder: EmbeddingClient;
        config: StoreConfig;
        logger: StoreLogger;
    });
    initialize(): Promise<void>;
    protected vectorSearch(query: string, embedding: number[], limit: number): Promise<RankedHit[]>;
    protected textSearch(query: string, limit: number): Promise<RankedHit[]>;
    protected fuzzySearch(query: string, limit: number): Promise<RankedHit[]>;
    get(id: number): Promise<{
        text: string;
        path: string;
    } | null>;
    getByPath(pathQuery: string, from?: number, lines?: number): Promise<{
        text: string;
        path: string;
    }>;
    protected getPrimerRows(): Promise<PrimerRow[]>;
    protected insertRecord(params: {
        content: string;
        category: string;
        title: string | null;
        tags: string[];
        metadata: Record<string, unknown>;
        record_type: string;
        parent_id: number | null;
        priority: number;
    }): Promise<number>;
    list(params: {
        category?: string;
        tags?: string[];
        record_type?: string;
        parent_id?: number;
        priority_min?: number;
        priority_max?: number;
        created_after?: string;
        created_before?: string;
        detail_level?: "summary" | "snippet" | "full";
        limit?: number;
        offset?: number;
    }): Promise<import("./types.js").ListResult[]>;
    protected updateRecord(id: number, patch: Record<string, unknown>): Promise<void>;
    protected softDeleteRecord(id: number): Promise<void>;
    protected restoreRecord(id: number): Promise<void>;
    protected fetchExpiredRecords(days: number): Promise<{
        id: number;
        content: string;
        category: string | null;
        title: string | null;
        deleted_at: string;
    }[]>;
    protected purgeExpiredRecords(days: number): Promise<number>;
    protected storeEmbedding(id: number, embedding: number[]): Promise<void>;
    protected getRecordMeta(id: number): Promise<{
        id: number;
        content: string;
        category: string | null;
        deleted_at: string | Date | null;
    } | null>;
    ping(): Promise<boolean>;
    close(): Promise<void>;
    getMetaValue(key: string): Promise<string | null>;
    setMetaValue(key: string, value: string): Promise<void>;
    protected getRecordBatch(afterId: number, limit: number): Promise<Array<{
        id: number;
        content: string;
    }>>;
}
