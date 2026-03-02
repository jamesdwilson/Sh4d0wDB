/**
 * mysql.ts — MySQL backend for MemoryStore
 *
 * Implements all abstract methods from MemoryStore using:
 * - Native VECTOR type for similarity search (MySQL 9.2+)
 * - FULLTEXT indexes with MATCH AGAINST for text search
 * - FULLTEXT ngram parser for substring/fuzzy search (built-in since MySQL 5.7)
 * - Standard SQL for CRUD, soft-delete, and retention purge
 *
 * Dependencies:
 * - mysql2: MySQL driver with prepared statement support
 *
 * REQUIREMENTS:
 * - MySQL 5.7+ for ngram parser, MySQL 9.2.1+ for native VECTOR type
 * - Server variable ngram_token_size=3 recommended (default is 2)
 * - FULLTEXT index on (title, content) for text search
 * - FULLTEXT index WITH PARSER ngram on (title, content) for fuzzy search
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
import { MemoryStore, type RankedHit, type PrimerRow, type StoreConfig, type StoreLogger } from "./store.js";
import type { EmbeddingClient } from "./embedder.js";
/**
 * MySQL-backed memory store.
 *
 * Requires MySQL 9.2+ for native VECTOR support.
 * FULLTEXT search built-in. ngram parser provides substring/fuzzy matching.
 */
export declare class MySQLStore extends MemoryStore {
    private pool;
    private connectionString;
    private hasVector;
    constructor(params: {
        connectionString: string;
        embedder: EmbeddingClient;
        config: StoreConfig;
        logger: StoreLogger;
    });
    private getPool;
    /** Execute a query and return rows. */
    private query;
    /** Execute a statement (INSERT/UPDATE/DELETE) and return result metadata. */
    private exec;
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
        deleted_at: Date;
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
