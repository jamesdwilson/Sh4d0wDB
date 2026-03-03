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
// MBTI types with high authority sensitivity (SJ temperament + T preference)
const HIGH_SENSITIVITY_MBTI = new Set([
    "istj", "estj", "isfj", "esfj", // SJ temperament
    "intj", "entj", // NT with Te/Ni
]);
// MBTI types with low authority sensitivity (NP temperament + F preference)
const LOW_SENSITIVITY_MBTI = new Set([
    "enfp", "infp", "entp", "intp", // NP temperament
    "esfp", "isfp", // SP with Fi
]);
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
export function computeAuthoritySensitivity(profile) {
    if (!profile)
        return 50; // Medium for missing profile
    let score = 50; // Start at medium
    const mbti = (profile.mbti || "").toLowerCase();
    const voss = profile.voss_type;
    // MBTI contribution
    if (HIGH_SENSITIVITY_MBTI.has(mbti)) {
        score += 25;
    }
    else if (LOW_SENSITIVITY_MBTI.has(mbti)) {
        score -= 25;
    }
    // Voss type contribution
    if (voss === "Analyst") {
        score += 20; // Analysts weight authority heavily
    }
    else if (voss === "Accommodator") {
        score -= 15; // Accommodators less sensitive to authority
    }
    else if (voss === "Assertive") {
        score += 5; // Assertives respect authority but challenge it
    }
    // DISC contribution (C and S types more authority-sensitive)
    const disc = (profile.disc || "").toUpperCase();
    if (disc.includes("C"))
        score += 10; // Conscientiousness = rule-following
    if (disc.includes("S"))
        score += 5; // Steadiness = hierarchy-respecting
    if (disc.includes("D"))
        score -= 5; // Dominance = challenges authority
    // Clamp to 0-100
    return Math.max(0, Math.min(100, Math.round(score)));
}
