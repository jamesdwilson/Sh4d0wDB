/**
 * phase0-scoring.ts — Confidence decay, relevance tier, and final score computation
 *
 * Implements the two-dimensional scoring model:
 *   - Relevance: how well does this record match the query?
 *   - Confidence: how much do we trust this record is still accurate?
 *
 * These are independent axes. A stale contact can be highly relevant (0.95)
 * but low confidence (0.3). A timeless rule is always confidence=1.0.
 *
 * Final score = vectorScore * rerankScore * confidenceWeight * tierWeight
 * Timeless records: confidenceWeight and tierWeight are always 1.0.
 *
 * Used in: store.ts search() pipeline, after reranking, before return.
 */
/** Relevance tier based on document age. null = archived (>365 days). */
export type RelevanceTier = 1 | 2 | 3 | 4;
/**
 * Decay profile for a record type.
 * halfLifeDays=0 and isTimeless=true means no decay ever.
 */
export interface DecayProfile {
    /** Half-life in days. 0 means no decay (use with isTimeless=true). */
    readonly halfLifeDays: number;
    /** Timeless records ignore all decay and tier weighting. */
    readonly isTimeless: boolean;
}
/**
 * Full scored result breakdown — all component scores preserved for
 * debugging, tuning, and logging.
 */
export interface ScoredResult {
    readonly memoryId: number;
    /** Raw cosine similarity from vector search [0, 1]. */
    readonly vectorScore: number;
    /** Cross-encoder P(relevant) from reranker [0, 1]. Null if reranking skipped. */
    readonly rerankScore: number | null;
    /** Confidence after exponential decay [0, 1]. Always 1.0 for timeless records. */
    readonly confidenceWeight: number;
    /** Tier weight based on document age [0, 1]. Always 1.0 for timeless records. */
    readonly tierWeight: number;
    readonly isTimeless: boolean;
    /** Final combined score = vectorScore * rerankScore * confidenceWeight * tierWeight */
    readonly finalScore: number;
}
/** Minimal record fields needed for confidence computation. */
export interface RecordForConfidence {
    readonly confidence: number;
    readonly confidenceDecayRate: number;
    readonly lastVerifiedAt: Date | null;
    readonly isTimeless: boolean;
    readonly createdAt: Date;
}
/** Minimal record fields needed for tier filtering. */
export interface RecordForTier {
    readonly id: number;
    readonly relevanceTier: RelevanceTier | null;
    readonly isTimeless: boolean;
    readonly content: string;
    readonly category: string | null;
    readonly title: string | null;
    readonly record_type: string | null;
    readonly created_at: Date;
    readonly rank: number;
    readonly rrfScore: number;
}
/**
 * Tier weight multipliers applied to final score.
 * Tier 1 = full weight; tier 4 = 15% weight.
 */
export declare const TIER_WEIGHTS: Record<RelevanceTier, number>;
/**
 * Decay profiles by record_type.
 * Category overrides (timeless categories) are handled in resolveDecayProfile().
 */
export declare const DECAY_PROFILES: Record<string, DecayProfile>;
/**
 * Compute current confidence for a record based on exponential decay.
 *
 * Formula: confidence(t) = initial_confidence * e^(-decay_rate * age_days)
 * Timeless records: always returns the initial confidence unchanged.
 * Decay clock starts at last_verified_at if set, else created_at.
 * Result is clamped to [0, initial_confidence].
 *
 * @param record  - Record with confidence fields
 * @param asOf    - Date to compute confidence at (default: now)
 * @returns       - Decayed confidence in [0, initial_confidence]
 */
export declare function computeRecordConfidence(record: RecordForConfidence, asOf?: Date): number;
/**
 * Assign relevance tier based on document date.
 *
 * Tiers:
 *   1 = within 10 days of asOf  (weight: 1.00)
 *   2 = 10–30 days              (weight: 0.70)
 *   3 = 30–90 days              (weight: 0.40)
 *   4 = 90–365 days             (weight: 0.15)
 *   null = older than 365 days  (archived — excluded from default search)
 *
 * @param documentDate  - Date of the source document
 * @param asOf          - Reference date (default: now)
 * @returns             - Tier 1–4 or null (archive)
 */
export declare function assignRelevanceTier(documentDate: Date, asOf?: Date): RelevanceTier | null;
/**
 * Compute final search score from component scores.
 *
 * Formula: vectorScore * rerankScore * confidenceWeight * tierWeight
 * If isTimeless=true: confidenceWeight and tierWeight are forced to 1.0.
 * If rerankScore=null: omitted from formula (vector * confidence * tier only).
 *
 * @param components  - Score components (without finalScore)
 * @returns           - Complete ScoredResult with finalScore
 */
export declare function computeFinalScore(components: Omit<ScoredResult, 'finalScore'>): ScoredResult;
/**
 * Determine decay profile for a record based on record_type and category.
 *
 * Category takes precedence: timeless categories override record_type profile.
 * Falls back to 'fact' profile (90-day half-life) for unknown types.
 *
 * @param recordType  - memories.record_type
 * @param category    - memories.category (may be null)
 * @returns           - DecayProfile for this record
 */
export declare function resolveDecayProfile(recordType: string, category: string | null): DecayProfile;
/**
 * Filter candidate records by relevance tier before reranking.
 *
 * Excludes archived records (tier=null) unless includeArchived=true.
 * Timeless records are always included regardless of tier.
 * Preserves input order.
 *
 * @param candidates      - Records from RRF merge
 * @param includeArchived - Include records older than 365 days (default: false)
 * @returns               - Filtered records in original order
 */
export declare function filterByTier(candidates: RecordForTier[], includeArchived?: boolean): RecordForTier[];
