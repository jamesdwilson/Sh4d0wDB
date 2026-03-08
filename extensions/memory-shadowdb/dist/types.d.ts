/**
 * types.ts — Type definitions for memory-shadowdb plugin
 *
 * Pure type definitions with no runtime logic. All types used across the plugin
 * are centralized here for maintainability and clarity.
 *
 * Security: No sensitive data or logic here, only type definitions.
 */
/**
 * Configuration file structure for ~/.shadowdb.json
 *
 * Contains PostgreSQL connection details. This file may contain sensitive
 * credentials (passwords, connection strings) and should never be logged
 * in full or exposed to untrusted contexts.
 */
export type ShadowDbConfig = {
    backend?: string;
    postgres?: {
        /** Full connection string (postgresql://user:pass@host:port/db) */
        connection_string?: string;
        host?: string;
        port?: number;
        user?: string;
        /** SECURITY: Password field — never log this value */
        password?: string;
        database?: string;
    };
};
/**
 * Supported embedding providers
 *
 * Each provider has different authentication and API requirements:
 * - ollama: local, no auth required
 * - openai: requires OPENAI_API_KEY
 * - openai-compatible: requires API key and base URL
 * - voyage: requires VOYAGE_API_KEY
 * - gemini: requires GEMINI_API_KEY or GOOGLE_API_KEY
 * - command: external process via stdin/stdout
 */
export type EmbeddingProvider = "ollama" | "openai" | "openai-compatible" | "voyage" | "gemini" | "command";
/**
 * Plugin configuration structure
 *
 * SECURITY NOTES:
 * - connectionString: may contain credentials, never log in full
 * - embedding.apiKey: API key for embedding providers, never logged
 * - embedding.headers: may contain auth headers, treat as sensitive
 * - All connection/auth config must be sourced from config files or env vars only,
 *   never from user input or external sources
 */
export type PluginConfig = {
    /**
     * Database backend to use.
     * - "postgres": Full features — pgvector, FTS, trigram, recency (default)
     * - "sqlite": Zero-config — sqlite-vec, FTS5, single file
     * - "mysql": MySQL 9.2+ — native VECTOR, FULLTEXT
     */
    backend?: "postgres" | "sqlite" | "mysql";
    /** Database connection string (Postgres/MySQL) or file path (SQLite). SECURITY: may contain credentials */
    connectionString?: string;
    /** Path to ~/.shadowdb.json config file */
    configPath?: string;
    /** Embedding provider configuration */
    embedding?: {
        /** Provider type (ollama, openai, etc.) */
        provider?: EmbeddingProvider | string;
        /** API key for cloud providers. SECURITY: never logged */
        apiKey?: string;
        /** Model name/identifier */
        model?: string;
        /** Expected embedding dimensions (must match pgvector column) */
        dimensions?: number;
        /** Ollama base URL */
        ollamaUrl?: string;
        /** Base URL for API-based providers */
        baseUrl?: string;
        /** Custom HTTP headers. SECURITY: may contain auth tokens */
        headers?: Record<string, string>;
        /** Voyage-specific: input type hint */
        voyageInputType?: "query" | "document";
        /** Gemini-specific: task type hint */
        geminiTaskType?: string;
        /** Command-based provider: executable path */
        command?: string;
        /** Command-based provider: CLI arguments */
        commandArgs?: string[];
        /** Command timeout in milliseconds */
        commandTimeoutMs?: number;
    };
    /** Database table name (default: "memories") */
    table?: string;
    /** Search behavior configuration */
    search?: {
        /**
         * Maximum number of results to return after RRF scoring.
         * With large corpora (5k+ records), low values cause good records to be
         * dropped before ranking. Default: 15. Increase for very large DBs.
         */
        maxResults?: number;
        /** Minimum score threshold for results. Default: 0.005. */
        minScore?: number;
        /**
         * Weight for vector similarity in RRF scoring. Default: 0.5.
         * Increase for concept/semantic-heavy queries; decrease for name-heavy
         * corpora where FTS outperforms embeddings (proper names embed poorly
         * with models like nomic-embed-text).
         */
        vectorWeight?: number;
        /**
         * Weight for full-text search in RRF scoring. Default: 0.5.
         * Increase for contact/name-heavy corpora where exact-match FTS is
         * more reliable than vector similarity for proper nouns.
         */
        textWeight?: number;
        /**
         * Minimum cosine similarity threshold for vector search results.
         * Vector hits below this score are excluded before RRF merge.
         * Prevents low-relevance records from polluting results via the vector leg.
         * Value range: 0.0–1.0 (cosine similarity). Default: 0 (no filtering).
         */
        minVectorScore?: number;
        /**
         * Weight for recency in RRF scoring.
         * Newer records get a slight boost when competing with older records
         * of equal semantic relevance. Deliberately small — recency is a
         * tiebreaker, not a dominant signal.
         * Default: 0.15
         */
        recencyWeight?: number;
    };
    /**
     * Reranker configuration — Qwen3-Reranker cross-encoder via embed-rerank service.
     * Optional: degrades gracefully to RRF-only search if absent or service unreachable.
     */
    reranker?: {
        /**
         * Base URL of the embed-rerank service.
         * Default: "http://127.0.0.1:9000"
         */
        baseUrl?: string;
        /**
         * Whether reranking is enabled.
         * Default: true
         */
        enabled?: boolean;
        /**
         * Timeout for reranker HTTP requests in milliseconds.
         * If exceeded, search returns RRF results without reranking.
         * Default: 3000
         */
        timeoutMs?: number;
        /**
         * Minimum candidate count before reranking is attempted.
         * Default: 3
         */
        minCandidates?: number;
        /**
         * Number of RRF candidates to pass to reranker.
         * Clamped to [1, 100]. Default: 30.
         */
        rerankTopK?: number;
        /**
         * Model identifier sent to reranker service.
         * Default: "reranker"
         */
        model?: string;
    };
    /**
     * Gmail ingestion pipeline configuration.
     * Controls the watermark-based ingestion runner (phase1-runner.ts).
     */
    ingestion?: {
        /** Enable/disable ingestion pipeline. Default: true */
        enabled?: boolean;
        /** gog CLI account email (primary Gmail account). E.g. "james@jameswilson.name" */
        account?: string;
        /**
         * Model alias or provider/model for scoreInterestingness LLM gate.
         * Must be an OpenAI-compatible endpoint. Default: "local-qwen35"
         */
        scoringModel?: string;
        /**
         * Minimum LLM interestingness score [0-10] to embed a document.
         * Receipts/shipping already hard-vetoed before this gate.
         * 5 = keep newsletters + business correspondence; drop promo blasts
         * 6 = stricter; keep only clear business signal
         * Default: 5
         */
        scoreThreshold?: number;
        /** Max messages to process per ingestion run. 0 = unlimited. Default: 100 */
        maxMessagesPerRun?: number;
        /** Additional gog gmail search filter appended to watermark date query. Default: "" */
        searchQuery?: string;
        /** Path for ingestion run logs. Default: "~/models/eval-results/gmail-ingestion.log" */
        logPath?: string;
    };
    /** Write operations configuration (disabled by default) */
    writes?: {
        /**
         * Master gate for all write tools (memory_write, memory_update, memory_delete, memory_undelete).
         * Must be explicitly set to true — defaults to false for safety.
         * There is no way to enable writes via tool parameters or env vars.
         */
        enabled?: boolean;
        /**
         * Auto-generate embedding vector on write/update operations.
         * When true, new and updated records are immediately vector-searchable.
         * When false, records are inserted with embedding=NULL (still FTS/trigram searchable).
         * Embedding failure is non-fatal: record persists without vector, warning logged.
         * Default: true
         */
        autoEmbed?: boolean;
        /** Retention policy for automatic data cleanup */
        retention?: {
            /**
             * Permanently remove soft-deleted records after N days.
             * Only records with deleted_at older than this are purged.
             * Set to 0 to never auto-purge (soft-deleted records persist forever).
             * Default: 30
             */
            purgeAfterDays?: number;
        };
    };
    /** Primer context injection configuration */
    primer?: {
        /** Enable/disable primer context injection */
        enabled?: boolean;
        /** Injection strategy: always, first-run, or digest-based */
        mode?: "always" | "first-run" | "digest";
        /** Maximum characters to inject (default: 4000) */
        maxChars?: number;
        /**
         * Model-aware maxChars overrides
         *
         * Maps model name patterns (substring match) to character limits.
         * Enables small-context models to get compact essentials while
         * large-context models get full priority stack.
         *
         * Example: { "opus": 6000, "ministral-8b": 1500 }
         */
        maxCharsByModel?: Record<string, number>;
        /** Cache TTL for digest mode (milliseconds) */
        cacheTtlMs?: number;
    };
};
/**
 * Primer injection mode strategies
 *
 * - always: inject on every agent start (highest overhead, strictest parity)
 * - first-run: inject only on first session start (lowest overhead)
 * - digest: inject when content changes or cache expires (balanced)
 */
export type PrimerInjectionMode = "always" | "first-run" | "digest";
/**
 * A single record returned by memory_list.
 */
export type ListResult = {
    id: number;
    path: string;
    category: string | null;
    title: string | null;
    record_type: string | null;
    priority: number;
    parent_id: number | null;
    metadata: Record<string, unknown>;
    created_at: string;
    tags: string[];
    /** Included when detail_level is snippet or full */
    content?: string;
};
/**
 * Result of memory_assemble — token-budget-aware context assembly.
 */
export type AssembleResult = {
    text: string;
    tokenEstimate: number;
    tokenBudget: number;
    recordsUsed: number;
    recordsSkipped: number;
    citations: Array<{
        id: number;
        path: string;
        title: string | null;
        tokensUsed: number;
    }>;
};
/**
 * Filters for memory_search — passed through to backend search legs.
 */
export type SearchFilters = {
    category?: string;
    record_type?: string;
    tags_include?: string[];
    tags_any?: string[];
    priority_min?: number;
    priority_max?: number;
    created_after?: string;
    created_before?: string;
    parent_id?: number;
    metadata_filters?: Array<{
        field: string;
        op: string;
        value: string | number;
    }>;
};
/**
 * Write operation result structure
 *
 * Returned by memory_write, memory_update, memory_delete tools.
 * Provides confirmation details for the agent to reference.
 */
export type WriteResult = {
    /** Whether the operation succeeded */
    ok: boolean;
    /** Operation type for confirmation */
    operation: "write" | "update" | "delete";
    /** Record ID affected */
    id: number;
    /** Virtual path (shadowdb/{category}/{id}) */
    path: string;
    /** Whether an embedding was generated/updated */
    embedded: boolean;
    /** Human-readable status message */
    message: string;
};
/**
 * Memory search result structure
 *
 * Returned by memory_search tool with all metadata needed for citation
 * and follow-up retrieval via memory_get.
 */
export type SearchResult = {
    /** Virtual path for this result (shadowdb/{category}/{id}) */
    path: string;
    /** Starting line number (always 1 for DB records) */
    startLine: number;
    /** Ending line number (always 1 for DB records) */
    endLine: number;
    /** Relevance score (RRF-combined vector + FTS + trigram) */
    score: number;
    /** Content snippet with metadata header */
    snippet: string;
    /** Source identifier ("memory") */
    source: string;
    /** Citation string (shadowdb:table#id) */
    citation?: string;
};
