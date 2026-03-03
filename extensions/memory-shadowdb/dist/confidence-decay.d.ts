/**
 * confidence-decay.ts — Decay confidence on stale relationship edges
 *
 * v0.6.0: confidence decay — lower confidence on edges where
 * last_verified is older than a threshold.
 *
 * Uses exponential decay: factor = 2^(-age/halfLife)
 * At halfLife days old, confidence is multiplied by 0.5.
 */
export interface DecayOptions {
    /** Half-life in days (default: 30) */
    halfLifeDays?: number;
    /** Minimum confidence floor (default: 0) */
    minConfidence?: number;
    /** Minimum decay factor before clamping to 0 (default: 0) */
    minFactor?: number;
}
export interface DecayResult {
    id: number;
    oldConfidence: number;
    newConfidence: number;
    decayFactor: number;
}
export interface EdgeWithConfidence {
    id: number;
    content: string;
    tags: string[];
    metadata: {
        last_verified?: string | null;
        confidence?: number;
        [key: string]: unknown;
    };
}
/**
 * Compute decay factor based on age and half-life.
 *
 * Formula: factor = 2^(-age_days / halfLifeDays)
 *
 * @param lastVerified - ISO date string or null
 * @param options      - Decay options
 * @returns Decay factor (0-1), or 0 if date is null/invalid
 */
export declare function computeDecayFactor(lastVerified: string | Date | null | undefined, options?: DecayOptions): number;
/**
 * Compute decayed confidence values for stale edges.
 *
 * @param edges   - Array of edges with metadata.confidence and metadata.last_verified
 * @param options - Decay options
 * @returns Array of edges that need updating with their new confidence values
 */
export declare function decayConfidence(edges: EdgeWithConfidence[], options?: DecayOptions): DecayResult[];
