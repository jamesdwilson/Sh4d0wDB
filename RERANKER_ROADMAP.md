# ShadowDB Reranker Integration — Implementation Roadmap

**Created:** 2026-03-07  
**Status:** ✅ COMPLETE — shipped 2026-03-07  
**DB Backup:** `backups/shadow_backup_20260307_182322.sql`  
**Goal:** Wire Qwen3-Reranker-0.6B into the `memory_search` query path so every search benefits from cross-encoder precision scoring.

---

## Problem Statement

The current search pipeline is:

```
query → embed → [vectorSearch ∥ textSearch ∥ fuzzySearch] → RRF merge → format → return
```

The Qwen3-Reranker is installed, working, and idle. It is not called during search. This means:
- Vector similarity scores rank by embedding proximity, not true relevance
- RRF fusion improves recall but not precision
- Top-5 results may not be the 5 most relevant — just the 5 with best combined ANN+FTS score

**Target pipeline:**

```
query → embed → [vectorSearch ∥ textSearch ∥ fuzzySearch] → RRF merge (top 30) → rerank (top 10) → format → return
```

The reranker reads query + each candidate together and outputs P(relevant) ∈ [0,1]. This is fundamentally more accurate than bi-encoder cosine similarity.

---

## Architecture Decision: Where to Insert

**Option A:** Insert in `store.ts::search()` after RRF merge, before formatting.  
**Option B:** Insert in `postgres.ts` as a separate method.  
**Option C:** New module `reranker.ts` called from `store.ts`.

**Decision: Option C (new module) + insertion point in `store.ts`.**

Reasons:
- `postgres.ts` is database-only — reranker is HTTP, not SQL
- `store.ts` search method is backend-agnostic — reranker is too
- New module = independently testable, mockable, importable
- Clean separation: reranker is a pure function `(query, candidates) → rankedCandidates`

---

## New Module: `reranker.ts`

### Responsibilities
- HTTP client for `http://127.0.0.1:9000/v1/rerank` (embed-rerank service)
- Graceful degradation: if service unreachable, return candidates unchanged (search still works)
- Request batching: send all candidates in one request, not N requests
- Timeout: hard 3s timeout — if reranker is slow, skip it rather than block search
- Score normalization: reranker returns P(yes) ∈ [0,1] — keep as-is
- Configurable: base URL, timeout, enabled flag, min candidates threshold

### Function Contracts

```typescript
/**
 * Reranker client configuration.
 * All fields optional — safe defaults applied for zero-config operation.
 */
export interface RerankerConfig {
  /** Base URL of the reranker service. Default: "http://127.0.0.1:9000" */
  baseUrl: string;

  /** Request timeout in milliseconds. Default: 3000. */
  timeoutMs: number;

  /** Whether reranking is enabled. Default: true. */
  enabled: boolean;

  /**
   * Minimum number of candidates required before reranking is attempted.
   * Reranking 1-2 candidates adds latency with no benefit.
   * Default: 3.
   */
  minCandidates: number;

  /**
   * Model identifier sent to reranker service.
   * Default: "reranker" (embed-rerank auto-selects loaded model).
   */
  model: string;
}

/**
 * A candidate document for reranking — content + original RRF score.
 */
export interface RerankCandidate {
  /** Original memory record id */
  id: number;
  /** Text content sent to reranker */
  content: string;
  /** Original RRF score (used as fallback if reranking fails) */
  rrfScore: number;
  /** Reranker score P(relevant) ∈ [0,1] — populated after reranking */
  rerankScore?: number;
}

/**
 * Rerank a list of candidate documents against a query.
 *
 * Sends a single HTTP POST to /v1/rerank with all candidates.
 * Returns candidates sorted by rerankScore descending.
 * On any failure (network, timeout, service down): returns input unchanged,
 * sorted by rrfScore descending, with rerankScore = undefined.
 *
 * This function NEVER throws — degradation is always silent and logged.
 *
 * @param query       - The user's search query
 * @param candidates  - Candidates from RRF merge (content + rrfScore)
 * @param config      - Reranker configuration
 * @param logger      - Logger for timing and error reporting
 * @returns           - Candidates sorted by rerankScore (or rrfScore on failure)
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[],
  config: RerankerConfig,
  logger: StoreLogger,
): Promise<RerankCandidate[]>;

/**
 * Check if the reranker service is reachable and healthy.
 * Used at startup to warn if reranker is configured but unavailable.
 * Does NOT block startup — search degrades gracefully without it.
 *
 * @param config  - Reranker configuration
 * @returns       - true if service responds to /health within 1s
 */
export async function checkRerankerHealth(
  config: RerankerConfig,
): Promise<boolean>;

/**
 * Parse reranker config from plugin config.
 * Returns default config if reranker section is absent.
 * Validates all fields — throws descriptive error on invalid values.
 *
 * @param pluginConfig  - Raw plugin configuration
 * @returns             - Validated RerankerConfig with defaults applied
 */
export function parseRerankerConfig(
  pluginConfig: Partial<PluginConfig>,
): RerankerConfig;
```

---

## Changes to Existing Files

### `types.ts` — Add `reranker` to `PluginConfig`

```typescript
/** Reranker configuration (optional — degrades gracefully if absent) */
reranker?: {
  /**
   * Reranker service base URL.
   * Default: "http://127.0.0.1:9000"
   */
  baseUrl?: string;

  /**
   * Whether reranking is enabled.
   * Default: true if baseUrl is reachable at startup, false otherwise.
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
   * Reranking < minCandidates candidates is skipped (not worth the latency).
   * Default: 3
   */
  minCandidates?: number;

  /**
   * Number of RRF candidates to pass to reranker.
   * Higher = better recall, more latency. Default: 30.
   * Final results returned = min(rerankTopK, maxResults).
   */
  rerankTopK?: number;
};
```

### `store.ts` — Add `reranker` to `StoreConfig` + wire into `search()`

**`StoreConfig` addition:**
```typescript
/** Reranker client config — undefined means disabled */
reranker?: RerankerConfig;
```

**`search()` modification** — after RRF merge, before formatting:
```typescript
// After: const merged = mergeRRF(...)
// Before: return merged.map(...)

// Rerank top candidates if configured
const rerankTopK = this.config.reranker?.rerankTopK ?? 30;
const candidatesForRerank = merged.slice(0, rerankTopK);
const reranked = this.config.reranker?.enabled
  ? await rerankCandidates(query, candidatesForRerank.map(h => ({
      id: h.id,
      content: h.content,
      rrfScore: h.rrfScore,
    })), this.config.reranker, this.logger)
  : candidatesForRerank.map(h => ({ ...h, rerankScore: undefined }));

// Use reranked order, take maxResults
const finalHits = reranked.slice(0, maxResults);
```

### `config.ts` — Parse reranker config from plugin config

Add `parseRerankerConfig()` call in the existing config builder. Reranker config is optional with safe defaults — no breaking change.

### `index.ts` — Health check at startup

After store initialization, call `checkRerankerHealth()` and log a warning if reranker is configured but unreachable. Never block startup.

---

## Test Specification (`reranker.test.mjs`)

### Test Suite Structure

```
describe("rerankCandidates")
  ✓ returns candidates sorted by rerankScore when service responds
  ✓ preserves rrfScore sort order when service is unreachable (degradation)
  ✓ preserves rrfScore sort order when service times out
  ✓ preserves rrfScore sort order when service returns HTTP 500
  ✓ skips reranking when candidates.length < minCandidates
  ✓ skips reranking when config.enabled = false
  ✓ truncates content to 2000 chars before sending (prevent oversized requests)
  ✓ sends single request for all candidates (not N requests)
  ✓ never throws — always returns array

describe("checkRerankerHealth")
  ✓ returns true when service responds 200 within 1s
  ✓ returns false when service is unreachable
  ✓ returns false when service takes > 1s to respond

describe("parseRerankerConfig")
  ✓ applies defaults when reranker section is absent
  ✓ merges partial config with defaults correctly
  ✓ throws on invalid baseUrl (not a valid URL)
  ✓ throws on negative timeoutMs
  ✓ throws on minCandidates < 1
  ✓ clamps rerankTopK to [1, 100]
```

### Test Data

Tests use a mock HTTP server (no real network calls). Two fixtures:
- `rerankerSuccessResponse` — valid `/v1/rerank` response with 5 results
- `rerankerErrorResponse` — HTTP 500 with error body

```typescript
const MOCK_CANDIDATES: RerankCandidate[] = [
  { id: 1, content: "Term sheet from Andreessen for Series A at $8M valuation", rrfScore: 0.82 },
  { id: 2, content: "Grocery list: milk eggs bread butter",                       rrfScore: 0.75 },
  { id: 3, content: "SAFE note for $2M from Sequoia Capital",                    rrfScore: 0.71 },
  { id: 4, content: "The dog needs a walk today",                                rrfScore: 0.68 },
  { id: 5, content: "Meeting with Sarah re Series A terms next Tuesday",         rrfScore: 0.65 },
];

const MOCK_QUERY = "venture capital deal term sheet";

// Expected rerank order (verified against live Qwen3-Reranker):
// [0] id=1 P(yes)≈0.99  Term sheet from Andreessen
// [1] id=5 P(yes)≈0.95  Meeting re Series A terms
// [2] id=3 P(yes)≈0.27  SAFE note Sequoia
// [3] id=4 P(yes)≈0.01  Dog walk
// [4] id=2 P(yes)≈0.00  Grocery list
```

---

## Commit Plan

```
feat(reranker): add RerankerConfig type and parseRerankerConfig  [after config tests pass]
feat(reranker): implement rerankCandidates with graceful degradation  [after unit tests pass]
feat(reranker): implement checkRerankerHealth  [after health tests pass]
feat(types): add reranker section to PluginConfig  [after types tests pass]
feat(store): add reranker to StoreConfig  [non-breaking]
feat(store): wire rerankCandidates into search() after RRF merge  [after integration test passes]
feat(config): parse reranker config in config builder  [after config integration test]
feat(index): health check reranker at startup  [after startup test]
chore: update openclaw.json to enable reranker  [after all tests pass]
```

---

## Definition of Done

- [x] All tests in `reranker.test.mjs` pass — 23/23
- [x] `npm test` passes with no regressions — 301/302 (1 pre-existing RED)
- [x] `memory_search` returns reranked results when embed-rerank service is running
- [x] `memory_search` returns correct (RRF-ranked) results when service is down
- [x] Reranker latency logged at INFO level (timing visible in logs)
- [x] `openclaw.json` updated with `reranker` config block
- [x] All code in strict TypeScript with no `any`
- [x] All commits made after corresponding tests pass

## Shipped Commits
- `223f5ee` feat(reranker): add reranker module — 23 tests passing, zero throws, graceful degradation
- `bc47fb0` feat(store): wire rerankCandidates into search() — reranker active after RRF merge
- `6a64016` feat(schema): add reranker to plugin configSchema — fixes additionalProperties validation error

---

## Non-Goals

- Reranker for `memory_assemble` (different codepath — later)
- Reranker for `memory_list` (not a relevance-ranked operation)
- Caching reranker results (premature optimization)
- Supporting multiple reranker backends (one service, one endpoint)

---

## Risk Register

| Risk | Mitigation |
|------|-----------|
| embed-rerank service crashes mid-search | Graceful degradation — catch all errors, return RRF results |
| Reranker adds >500ms latency | Hard 3s timeout + skip if slow; log timing so we can tune |
| Reranker scores wrong (bad model output) | Integration test with known good/bad pairs verifies ranking |
| TypeScript strict mode breaks existing code | Run `tsc --noEmit` before and after — no regressions |
| Breaking change to StoreConfig | New field is optional — all existing constructors unaffected |
