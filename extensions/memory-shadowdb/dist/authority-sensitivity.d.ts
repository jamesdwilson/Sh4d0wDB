/**
 * authority-sensitivity.ts — Derive authority sensitivity from psych profile
 *
 * v0.7.0: From GRAPH_SPEC.md — "Authority sensitivity — derive from psych profile
 * at query time, never store: ISTJ/ESTJ/Analyst → weight intro source heavily"
 *
 * Returns score 0-100 where:
 * - 80-100: High authority sensitivity (weight intro source heavily)
 * - 50-79: Medium sensitivity
 * - 0-49: Low sensitivity (deference less important)
 */
export interface PsychProfile {
    mbti?: string | null;
    voss_type?: "Analyst" | "Accommodator" | "Assertive" | null;
    disc?: string | null;
}
/**
 * Compute authority sensitivity score from psych profile.
 *
 * Rules (from GRAPH_SPEC.md):
 * - ISTJ/ESTJ/Analyst → high authority sensitivity
 * - ENFP/INFP/Accommodator → low authority sensitivity
 * - Combined signals additively boost score
 *
 * @param profile - Psych profile with MBTI, Voss type, DISC
 * @returns Score 0-100
 */
export declare function computeAuthoritySensitivity(profile: PsychProfile | null | undefined): number;
