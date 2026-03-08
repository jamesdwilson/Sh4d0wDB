/**
 * phase0-search-scoring.ts — Apply confidence/tier scoring to search hits
 *
 * This module bridges the RRF+rerank pipeline in store.ts with the
 * two-dimensional scoring model from phase0-scoring.ts.
 *
 * Responsibility:
 *   Given a list of RankedHits (post-RRF, post-rerank), each carrying
 *   relevance_tier, confidence, confidence_decay_rate, and is_timeless
 *   from the database, compute a final score that reflects:
 *     - How well the record matched the query (vector * rerank)
 *     - How confident we are it's still accurate (confidence decay)
 *     - How recent the record is (tier weight)
 *
 * Output: same hits sorted by finalScore descending, with finalScore added.
 *
 * Contract: NEVER throws — if scoring fails for any hit, rrfScore is used
 * as fallback and a warning is logged.
 *
 * Insertion point in store.ts search():
 *   ... reranking complete ...
 *   finalHits = applySearchScoring(finalHits)   ← here
 *   ... format and return ...
 */
import { type RelevanceTier } from "./phase0-scoring.js";
/**
 * A RankedHit extended with the Phase 0 confidence/tier columns
 * returned by the database search legs.
 *
 * Extends the base RankedHit (defined in store.ts) with:
 *   - rrfScore: from RRF merge
 *   - rerankScore: from Qwen3-Reranker (null if skipped)
 *   - relevanceTier: from memories.relevance_tier (1-4 or null for archived)
 *   - confidence: from memories.confidence
 *   - confidenceDecayRate: from memories.confidence_decay_rate
 *   - isTimeless: from memories.is_timeless
 */
export interface ScoredRankedHit {
    readonly id: number;
    readonly content: string;
    readonly category: string | null;
    readonly title: string | null;
    readonly record_type: string | null;
    readonly created_at: Date | string | null;
    readonly rank: number;
    readonly rawScore?: number;
    /** Combined RRF score from all search signals */
    readonly rrfScore: number;
    /** Cross-encoder P(relevant) from reranker. Null if reranking skipped. */
    readonly rerankScore: number | null;
    /** Relevance tier (1-4) based on document age. Null = archived. */
    readonly relevanceTier: RelevanceTier | null;
    /** Current confidence [0, 1] — may be pre-decayed or fresh */
    readonly confidence: number;
    /** Exponential decay rate per day. 0 = no decay. */
    readonly confidenceDecayRate: number;
    /** Timeless records always receive full confidence and tier weight */
    readonly isTimeless: boolean;
    /** Final combined score — set by applySearchScoring() */
    finalScore?: number;
}
/**
 * Apply confidence and tier scoring to a list of post-rerank hits.
 *
 * For each hit:
 *   1. Compute decayed confidence using computeRecordConfidence()
 *   2. Look up tier weight from TIER_WEIGHTS (null tier → 0.15 minimum)
 *   3. Compute finalScore = rrfScore * rerankScore * confidenceWeight * tierWeight
 *      (timeless records: confidenceWeight = 1.0, tierWeight = 1.0 always)
 *
 * Returns hits sorted by finalScore descending.
 * On any per-hit error: assigns rrfScore as finalScore (safe fallback).
 *
 * @param hits   - Post-rerank hits with confidence/tier fields
 * @param asOf   - Reference date for decay computation (default: now)
 * @returns      - Same hits sorted by finalScore descending, finalScore populated
 */
export declare function applySearchScoring(hits: ScoredRankedHit[], asOf?: Date): ScoredRankedHit[];
