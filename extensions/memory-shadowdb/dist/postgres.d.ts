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
import type { SearchFilters } from "./types.js";
import { type GraphEdge } from "./graph-queries.js";
/**
 * PostgreSQL-backed memory store.
 *
 * The richest backend: full vector search, FTS, trigram fuzzy matching.
 * Requires pgvector and pg_trgm extensions.
 */
export declare class PostgresStore extends MemoryStore {
    private pool;
    private connectionString;
    constructor(params: {
        connectionString: string;
        embedder: EmbeddingClient;
        config: StoreConfig;
        logger: StoreLogger;
    });
    protected getPool(): pg.Pool;
    /**
     * Expose pool for legacy compatibility (index.ts shared pool pattern).
     * TODO: Remove once index.ts is fully migrated to use MemoryStore directly.
     */
    getSharedPool(): pg.Pool;
    protected vectorSearch(query: string, embedding: number[], limit: number, filters?: SearchFilters): Promise<RankedHit[]>;
    protected textSearch(query: string, limit: number, filters?: SearchFilters): Promise<RankedHit[]>;
    protected fuzzySearch(query: string, limit: number, filters?: SearchFilters): Promise<RankedHit[]>;
    get(id: number, opts?: {
        include_children?: boolean;
        section?: string;
    }): Promise<{
        text: string;
        path: string;
    } | null>;
    getByPath(pathQuery: string, from?: number, lines?: number, opts?: {
        include_children?: boolean;
        section?: string;
    }): Promise<{
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
    }): Promise<import("./types.js").ListResult[]>;
    protected updateRecord(id: number, patch: Record<string, unknown>): Promise<void>;
    protected softDeleteRecord(id: number): Promise<void>;
    protected restoreRecord(id: number): Promise<void>;
    protected fetchExpiredRecords(days: number): Promise<any[]>;
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
    initialize(): Promise<void>;
    getMetaValue(key: string): Promise<string | null>;
    setMetaValue(key: string, value: string): Promise<void>;
    protected getRecordBatch(afterId: number, limit: number): Promise<Array<{
        id: number;
        content: string;
    }>>;
    /**
     * Traverse the entity graph from a starting slug.
     *
     * Returns all edges touching the entity (1-hop), and optionally recurses
     * to N hops. Each hop collects the connected entity slugs, then fetches
     * their edges in turn. Visited set prevents infinite loops.
     *
     * @param entitySlug     - Starting entity slug (e.g. "james-wilson")
     * @param hops           - Number of hops to traverse (default 1, max 3)
     * @param min_confidence - Minimum edge confidence to include (0-100)
     * @param relationship_type - Optional filter to specific relationship type
     * @returns edges[], connected entity slugs[], and raw edge records
     */
    graph(params: {
        entity: string;
        hops?: number;
        min_confidence?: number;
        relationship_type?: string;
    }): Promise<{
        entity: string;
        edges: GraphEdge[];
        connected: string[];
        hopResults: Array<{
            entity: string;
            edges: GraphEdge[];
        }>;
    }>;
    /**
     * Query all graph edges (for conflict detection, decay preview).
     * Public method for tool handlers.
     */
    queryAllGraphEdges(opts?: {
        domain?: string;
        min_confidence?: number;
    }): Promise<GraphEdge[]>;
}
