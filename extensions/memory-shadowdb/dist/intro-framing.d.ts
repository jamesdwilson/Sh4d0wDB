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
import type { GraphEdge } from "./graph-queries.js";
import type { PsychProfile } from "./authority-sensitivity.js";
export interface FramingResult {
    affinity: number;
    tier: "natural-fit" | "workable" | "caution" | "avoid";
    framing: string;
    risks: string[];
    suggestions: string[];
}
/**
 * Suggest introduction framing based on edges and psych profiles.
 *
 * @param entity_a   - First entity slug
 * @param entity_b   - Second entity slug
 * @param edges      - Graph edges between these entities
 * @param profiles   - Optional psych profiles for each entity
 */
export declare function suggestIntroFraming(entity_a: string, entity_b: string, edges: GraphEdge[], profiles?: Record<string, PsychProfile>): FramingResult;
