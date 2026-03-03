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
export function computeDecayFactor(
  lastVerified: string | Date | null | undefined,
  options: DecayOptions = {},
): number {
  const { halfLifeDays = 30, minFactor = 0 } = options;

  if (!lastVerified) return 0;

  const date = lastVerified instanceof Date ? lastVerified : new Date(lastVerified);
  if (isNaN(date.getTime())) return 0;

  const ageMs = Date.now() - date.getTime();
  if (ageMs < 0) return 1.0; // Future date — no decay

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
export function decayConfidence(
  edges: EdgeWithConfidence[],
  options: DecayOptions = {},
): DecayResult[] {
  const { minConfidence = 0 } = options;
  const results: DecayResult[] = [];

  for (const edge of edges) {
    const current = edge.metadata?.confidence;
    if (typeof current !== "number") continue;

    const lastVerified = edge.metadata?.last_verified;
    const factor = computeDecayFactor(lastVerified, options);

    // No decay needed if factor is 1.0
    if (factor >= 1.0) continue;

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
