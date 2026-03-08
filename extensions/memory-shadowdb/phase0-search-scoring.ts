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

import {
  computeRecordConfidence,
  computeFinalScore,
  TIER_WEIGHTS,
  type RelevanceTier,
  type RecordForConfidence,
} from "./phase0-scoring.js";

// ============================================================================
// Types
// ============================================================================

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
 *   - lastVerifiedAt: from memories.last_verified_at (resets decay clock)
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
  /**
   * When the record was last verified as still accurate.
   * Resets the decay clock — decay runs from this date instead of created_at.
   * Null means decay runs from created_at.
   * May be a Date object or ISO string (DB may return either).
   */
  readonly lastVerifiedAt: Date | string | null;
  /** Final combined score — set by applySearchScoring() */
  finalScore?: number;
}

// ============================================================================
// Public API
// ============================================================================

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
export function applySearchScoring(
  hits: ScoredRankedHit[],
  asOf: Date = new Date(),
): ScoredRankedHit[] {
  if (hits.length === 0) return [];

  const scored = hits.map((hit) => {
    try {
      // Safely parse lastVerifiedAt — DB may return Date, ISO string, or null
      const lastVerifiedAt: Date | null =
        hit.lastVerifiedAt instanceof Date
          ? hit.lastVerifiedAt
          : typeof hit.lastVerifiedAt === "string" && hit.lastVerifiedAt
            ? new Date(hit.lastVerifiedAt)
            : null;

      const recordForConfidence: RecordForConfidence = {
        confidence: hit.confidence,
        confidenceDecayRate: hit.confidenceDecayRate,
        // lastVerifiedAt resets the decay clock — records recently verified
        // retain high confidence even if created_at is old
        lastVerifiedAt,
        isTimeless: hit.isTimeless,
        createdAt: hit.created_at instanceof Date
          ? hit.created_at
          : hit.created_at
            ? new Date(hit.created_at)
            : new Date(),
      };

      const confidenceWeight = computeRecordConfidence(recordForConfidence, asOf);

      // Tier weight: null tier (archived) gets minimum weight, not zero
      // so archived records can still surface if timeless override applies
      const tierWeight: number = hit.isTimeless
        ? 1.0
        : TIER_WEIGHTS[hit.relevanceTier ?? 4] ?? TIER_WEIGHTS[4];

      const scored = computeFinalScore({
        memoryId: hit.id,
        vectorScore: hit.rrfScore,
        rerankScore: hit.rerankScore,
        confidenceWeight,
        tierWeight,
        isTimeless: hit.isTimeless,
      });

      return { ...hit, finalScore: scored.finalScore };
    } catch {
      // Safe fallback: use rrfScore if scoring fails for this hit
      return { ...hit, finalScore: hit.rrfScore };
    }
  });

  // Sort by finalScore descending
  return scored.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}
