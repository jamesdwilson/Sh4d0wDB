/**
 * reranker.ts — Qwen3-Reranker client for ShadowDB memory search
 *
 * Integrates with the embed-rerank FastAPI service (http://127.0.0.1:9000)
 * to provide cross-encoder reranking after RRF fusion.
 *
 * Design principles:
 * - NEVER throws: all errors are caught and logged; degraded results returned
 * - Single HTTP request: all candidates sent in one batch, not N requests
 * - Hard timeout: search never blocks longer than timeoutMs on reranker
 * - Pure function surface: rerankCandidates takes (query, candidates, config, logger)
 *   with no shared mutable state — safe for concurrent searches
 *
 * Insertion point in store.ts search():
 *   RRF merge → rerankCandidates() → format → return
 */
import type { StoreLogger } from "./store.js";
import type { PluginConfig } from "./types.js";
/**
 * Validated reranker client configuration.
 * All fields required — use parseRerankerConfig() to get defaults applied.
 */
export interface RerankerConfig {
    /** Base URL of the reranker service (no trailing slash). */
    readonly baseUrl: string;
    /** Request timeout in milliseconds. */
    readonly timeoutMs: number;
    /** Whether reranking is enabled. */
    readonly enabled: boolean;
    /**
     * Minimum candidate count required before reranking is attempted.
     * Reranking < minCandidates candidates is skipped (not worth the latency).
     */
    readonly minCandidates: number;
    /**
     * Number of RRF-merged candidates to send to the reranker.
     * Caller slices to this before calling rerankCandidates().
     */
    readonly rerankTopK: number;
    /** Model identifier sent to reranker service. */
    readonly model: string;
}
/**
 * A candidate document for reranking.
 * Carries original RRF score as fallback if reranking is skipped/fails.
 */
export interface RerankCandidate {
    /** Memory record id. */
    readonly id: number;
    /** Text content sent to reranker (may be truncated). */
    readonly content: string;
    /** Original RRF score — used as fallback sort key. */
    readonly rrfScore: number;
    /**
     * Reranker score P(relevant) ∈ [0,1].
     * Undefined when reranking was skipped or failed.
     */
    rerankScore?: number;
}
/**
 * Rerank a list of candidate documents against a query.
 *
 * Sends a single HTTP POST to /v1/rerank with all candidates.
 * Returns candidates sorted by rerankScore descending.
 *
 * Degradation contract: on ANY failure (network, timeout, HTTP error,
 * malformed response), returns input sorted by rrfScore with rerankScore=undefined.
 * This function NEVER throws.
 *
 * @param query       - The user's search query
 * @param candidates  - Candidates from RRF merge
 * @param config      - Validated reranker configuration
 * @param logger      - Logger for timing and error reporting
 * @returns           - Candidates sorted by rerankScore (or rrfScore on failure/skip)
 */
export declare function rerankCandidates(query: string, candidates: RerankCandidate[], config: RerankerConfig, logger: StoreLogger): Promise<RerankCandidate[]>;
/**
 * Check if the reranker service is reachable and healthy.
 *
 * Does NOT throw — returns false on any error or timeout.
 * Intended for startup diagnostics only, not hot path.
 *
 * @param config  - Reranker configuration
 * @returns       - true if service responds to /health within HEALTH_TIMEOUT_MS
 */
export declare function checkRerankerHealth(config: RerankerConfig): Promise<boolean>;
/**
 * Parse and validate reranker config from plugin config.
 * Returns a fully-populated RerankerConfig with all defaults applied.
 * Throws a descriptive TypeError on invalid values.
 *
 * @param pluginConfig  - Raw plugin configuration (may be partial or empty)
 * @returns             - Validated RerankerConfig
 * @throws TypeError    - If any field has an invalid value
 */
export declare function parseRerankerConfig(pluginConfig: Partial<PluginConfig>): RerankerConfig;
