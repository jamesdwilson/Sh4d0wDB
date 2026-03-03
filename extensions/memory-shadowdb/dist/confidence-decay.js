/**
 * confidence-decay.ts — Decay confidence on stale relationship edges
 *
 * v0.6.0: confidence decay — lower confidence on edges where
 * last_verified is older than a threshold.
 *
 * Uses exponential decay: factor = 2^(-age/halfLife)
 * At halfLife days old, confidence is multiplied by 0.5.
 */
/**
 * Compute decay factor based on age and half-life.
 *
 * Formula: factor = 2^(-age_days / halfLifeDays)
 *
 * @param lastVerified - ISO date string or null
 * @param options      - Decay options
 * @returns Decay factor (0-1), or 0 if date is null/invalid
 */
export function computeDecayFactor(lastVerified, options = {}) {
    const { halfLifeDays = 30, minFactor = 0 } = options;
    if (!lastVerified)
        return 0;
    const date = lastVerified instanceof Date ? lastVerified : new Date(lastVerified);
    if (isNaN(date.getTime()))
        return 0;
    const ageMs = Date.now() - date.getTime();
    if (ageMs < 0)
        return 1.0; // Future date — no decay
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const factor = Math.pow(2, -ageDays / halfLifeDays);
    return Math.max(minFactor, Math.min(1, factor));
}
/**
 * Compute decayed confidence values for stale edges.
 *
 * @param edges   - Array of edges with metadata.confidence and metadata.last_verified
 * @param options - Decay options
 * @returns Array of edges that need updating with their new confidence values
 */
export function decayConfidence(edges, options = {}) {
    const { minConfidence = 0 } = options;
    const results = [];
    for (const edge of edges) {
        const current = edge.metadata?.confidence;
        if (typeof current !== "number")
            continue;
        const lastVerified = edge.metadata?.last_verified;
        const factor = computeDecayFactor(lastVerified, options);
        // No decay needed if factor is 1.0
        if (factor >= 1.0)
            continue;
        const decayed = Math.round(current * factor);
        const clamped = Math.max(minConfidence, decayed);
        // Only report if actually changed
        if (clamped !== current) {
            results.push({
                id: edge.id,
                oldConfidence: current,
                newConfidence: clamped,
                decayFactor: factor,
            });
        }
    }
    return results;
}
