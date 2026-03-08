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

// ============================================================================
// Types
// ============================================================================

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

/** Wire format for /v1/rerank response */
interface RerankApiResponse {
  results: Array<{ index: number; relevance_score: number }>;
}

/** Maximum content chars sent per candidate to prevent oversized requests. */
const MAX_CONTENT_CHARS = 2000;

/** Health check timeout — shorter than normal rerank timeout. */
const HEALTH_TIMEOUT_MS = 1000;

// ============================================================================
// Public API
// ============================================================================

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
export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[],
  config: RerankerConfig,
  logger: StoreLogger,
): Promise<RerankCandidate[]> {
  // Fast path: empty input
  if (candidates.length === 0) return [];

  // Skip conditions
  if (!config.enabled) {
    logger.info(`memory-shadowdb/reranker: disabled — returning RRF order`);
    return sortByRrf(candidates);
  }
  if (candidates.length < config.minCandidates) {
    logger.info(
      `memory-shadowdb/reranker: skipped — ${candidates.length} candidates < minCandidates=${config.minCandidates}`,
    );
    return sortByRrf(candidates);
  }

  const start = Date.now();

  try {
    const documents = candidates.map((c) =>
      c.content.length > MAX_CONTENT_CHARS
        ? c.content.slice(0, MAX_CONTENT_CHARS)
        : c.content,
    );

    const body = JSON.stringify({
      model: config.model,
      query,
      documents,
      top_n: candidates.length,
    });

    const response = await fetchWithTimeout(
      `${config.baseUrl}/v1/rerank`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      config.timeoutMs,
    );

    if (!response.ok) {
      logger.warn(
        `memory-shadowdb/reranker: HTTP ${response.status} from /v1/rerank — falling back to RRF order`,
      );
      return sortByRrf(candidates);
    }

    const data = (await response.json()) as RerankApiResponse;

    if (!data?.results || !Array.isArray(data.results)) {
      logger.warn(
        `memory-shadowdb/reranker: unexpected response shape — falling back to RRF order`,
      );
      return sortByRrf(candidates);
    }

    // Apply scores back to candidates
    const scored: RerankCandidate[] = candidates.map((c) => ({ ...c }));
    for (const result of data.results) {
      if (
        typeof result.index === "number" &&
        result.index >= 0 &&
        result.index < scored.length &&
        typeof result.relevance_score === "number"
      ) {
        scored[result.index].rerankScore = result.relevance_score;
      }
    }

    // Sort by rerankScore descending; fall back to rrfScore for unscored entries
    scored.sort((a, b) => {
      const sa = a.rerankScore ?? -Infinity;
      const sb = b.rerankScore ?? -Infinity;
      if (sa !== sb) return sb - sa;
      return b.rrfScore - a.rrfScore;
    });

    const elapsed = Date.now() - start;
    logger.info(
      `memory-shadowdb/reranker: reranked ${candidates.length} candidates in ${elapsed}ms`,
    );

    return scored;
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `memory-shadowdb/reranker: error after ${elapsed}ms (${msg}) — falling back to RRF order`,
    );
    return sortByRrf(candidates);
  }
}

/**
 * Check if the reranker service is reachable and healthy.
 *
 * Does NOT throw — returns false on any error or timeout.
 * Intended for startup diagnostics only, not hot path.
 *
 * @param config  - Reranker configuration
 * @returns       - true if service responds to /health within HEALTH_TIMEOUT_MS
 */
export async function checkRerankerHealth(config: RerankerConfig): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${config.baseUrl}/health`,
      { method: "GET" },
      HEALTH_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Parse and validate reranker config from plugin config.
 * Returns a fully-populated RerankerConfig with all defaults applied.
 * Throws a descriptive TypeError on invalid values.
 *
 * @param pluginConfig  - Raw plugin configuration (may be partial or empty)
 * @returns             - Validated RerankerConfig
 * @throws TypeError    - If any field has an invalid value
 */
export function parseRerankerConfig(pluginConfig: Partial<PluginConfig>): RerankerConfig {
  const raw = pluginConfig.reranker ?? {};

  // baseUrl
  const rawUrl = (raw.baseUrl ?? "http://127.0.0.1:9000").replace(/\/$/, "");
  try {
    new URL(rawUrl);
  } catch {
    throw new TypeError(
      `reranker: invalid baseUrl "${rawUrl}" — must be a valid HTTP(S) URL`,
    );
  }

  // timeoutMs
  const timeoutMs = raw.timeoutMs ?? 3000;
  if (typeof timeoutMs !== "number" || timeoutMs < 0) {
    throw new TypeError(
      `reranker: invalid timeoutMs ${timeoutMs} — must be a non-negative number`,
    );
  }

  // minCandidates
  const minCandidates = raw.minCandidates ?? 3;
  if (typeof minCandidates !== "number" || minCandidates < 1) {
    throw new TypeError(
      `reranker: invalid minCandidates ${minCandidates} — must be >= 1`,
    );
  }

  // rerankTopK — clamp to [1, 100]
  const rerankTopKRaw = raw.rerankTopK ?? 30;
  const rerankTopK = Math.max(1, Math.min(100, rerankTopKRaw));

  return {
    baseUrl: rawUrl,
    timeoutMs,
    enabled: raw.enabled ?? true,
    minCandidates,
    rerankTopK,
    model: raw.model ?? "reranker",
  };
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Sort candidates by rrfScore descending.
 * Used as fallback when reranking is skipped or fails.
 */
function sortByRrf(candidates: RerankCandidate[]): RerankCandidate[] {
  return [...candidates].sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * fetch() with an AbortController-based timeout.
 * Throws on timeout (AbortError) or network error.
 *
 * @param url       - Request URL
 * @param init      - fetch RequestInit options
 * @param timeoutMs - Milliseconds before aborting
 * @returns         - fetch Response
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
