/**
 * conflict-detector.ts — Detect contradictory relationship edges
 *
 * v0.6.0: conflict detection — find edges where same entity pair has
 * contradictory relationship types.
 *
 * Used by memory_graph or a dedicated memory_conflicts tool.
 */
/** Pairs of relationship types that conflict with each other. */
export declare const CONFLICT_PAIRS: Array<[string, string]>;
export interface GraphEdge {
    id: number;
    content: string;
    tags: string[];
    metadata: {
        entity_a?: string;
        entity_b?: string;
        relationship_type?: string;
        confidence?: number;
        [key: string]: unknown;
    };
}
export interface ConflictResult {
    /** First entity (alphabetically) */
    entity_a: string;
    /** Second entity (alphabetically) */
    entity_b: string;
    /** The conflicting relationship types */
    types: [string, string];
    /** Edge IDs involved */
    edge_ids: [number, number];
}
/**
 * Detect conflicting relationship edges.
 *
 * Two edges conflict if:
 * - They connect the same entity pair (order-independent)
 * - Their relationship_types appear in CONFLICT_PAIRS
 *
 * @param edges - Array of graph edges (from memory_graph or list query)
 * @returns Array of conflicts found
 */
export declare function detectConflicts(edges: GraphEdge[]): ConflictResult[];
