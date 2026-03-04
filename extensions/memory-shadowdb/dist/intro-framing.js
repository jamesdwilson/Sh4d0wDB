/**
 * intro-framing.ts — Suggest introduction framing based on affinity + friction
 *
 * v0.7.0: From GRAPH_SPEC.md — use affinity + friction data to suggest
 * how to frame an introduction between two entities.
 *
 * Affinity score interpretation:
 * - 80-100: Natural fit — compatible psych, shared values, no competition
 * - 50-79: Workable — different styles, mutual respect likely
 * - 20-49: Friction risk — personality clash or value divergence likely
 * - <20: Avoid — high probability bad chemistry
 */
/**
 * Suggest introduction framing based on edges and psych profiles.
 *
 * @param entity_a   - First entity slug
 * @param entity_b   - Second entity slug
 * @param edges      - Graph edges between these entities
 * @param profiles   - Optional psych profiles for each entity
 */
export function suggestIntroFraming(entity_a, entity_b, edges, profiles) {
    // Calculate affinity from edges
    const affinityEdge = edges.find(e => e.metadata?.entity_a === entity_a && e.metadata?.entity_b === entity_b
        || e.metadata?.entity_a === entity_b && e.metadata?.entity_b === entity_a);
    const affinity = affinityEdge?.metadata?.affinity_score ?? 50;
    const frictionRisks = affinityEdge?.metadata?.friction_risks
        ? [String(affinityEdge.metadata.friction_risks)]
        : [];
    // Determine tier
    let tier;
    if (affinity >= 80)
        tier = "natural-fit";
    else if (affinity >= 50)
        tier = "workable";
    else if (affinity >= 20)
        tier = "caution";
    else
        tier = "avoid";
    // Generate framing text
    let framing;
    const suggestions = [];
    switch (tier) {
        case "natural-fit":
            framing = `Natural fit — lead with shared values and complementary strengths. ${entity_a} and ${entity_b} align on core priorities.`;
            suggestions.push("Emphasize mutual interests and shared goals");
            suggestions.push("Frame as 'you two should meet' rather than formal intro");
            break;
        case "workable":
            framing = `Workable — frame as complementary skills. ${entity_a} and ${entity_b} have different styles but mutual respect is likely.`;
            suggestions.push("Acknowledge different approaches upfront");
            suggestions.push("Lead with what each brings to the table");
            break;
        case "caution":
            framing = `Caution — acknowledge potential tension, frame around common goal. ${entity_a} and ${entity_b} may have friction points.`;
            suggestions.push("Be explicit about why the intro makes sense despite differences");
            suggestions.push("Find a shared adversary or common challenge to unite around");
            if (frictionRisks.length > 0) {
                suggestions.push(`Address friction: ${frictionRisks.join(", ")}`);
            }
            break;
        case "avoid":
            framing = `Not recommended — high friction risk. ${entity_a} and ${entity_b} have low affinity and significant compatibility concerns.`;
            suggestions.push("Consider if the intro is truly necessary");
            suggestions.push("If required, use a neutral third party as intermediary");
            break;
    }
    // Add authority sensitivity note if profiles available
    if (profiles) {
        const profile_a = profiles[entity_a];
        const profile_b = profiles[entity_b];
        if (profile_a || profile_b) {
            // Import at top causes circular dep, inline the check
            const analyst_a = profile_a?.voss_type === "Analyst" || profile_a?.mbti?.toUpperCase().includes("TJ");
            const analyst_b = profile_b?.voss_type === "Analyst" || profile_b?.mbti?.toUpperCase().includes("TJ");
            if (analyst_a && tier !== "avoid") {
                suggestions.push(`${entity_a} values substantive credentials — prepare solid context`);
            }
            if (analyst_b && tier !== "avoid") {
                suggestions.push(`${entity_b} values substantive credentials — prepare solid context`);
            }
        }
    }
    return { affinity, tier, framing, risks: frictionRisks, suggestions };
}
