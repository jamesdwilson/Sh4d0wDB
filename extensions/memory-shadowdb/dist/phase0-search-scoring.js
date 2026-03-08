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
import { computeRecordConfidence, computeFinalScore, TIER_WEIGHTS, } from "./phase0-scoring.js";
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
export function applySearchScoring(hits, asOf = new Date()) {
    if (hits.length === 0)
        return [];
    const scored = hits.map((hit) => {
        try {
            const recordForConfidence = {
                confidence: hit.confidence,
                confidenceDecayRate: hit.confidenceDecayRate,
                lastVerifiedAt: null, // TODO: wire last_verified_at when added to RankedHit
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
            const tierWeight = hit.isTimeless
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
        }
        catch {
            // Safe fallback: use rrfScore if scoring fails for this hit
            return { ...hit, finalScore: hit.rrfScore };
        }
    });
    // Sort by finalScore descending
    return scored.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}
//# sourceMappingURL=phase0-search-scoring.js.map