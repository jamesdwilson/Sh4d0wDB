/**
 * conflict-detector.ts — Detect contradictory relationship edges
 *
 * v0.6.0: conflict detection — find edges where same entity pair has
 * contradictory relationship types.
 *
 * Used by memory_graph or a dedicated memory_conflicts tool.
 */
/** Pairs of relationship types that conflict with each other. */
export const CONFLICT_PAIRS = [
    ["knows", "tension"],
    ["knows", "rivals"],
    ["allies", "rivals"],
    ["allies", "tension"],
    ["colleagues", "rivals"],
    ["colleagues", "tension"],
    ["probable-allies", "tension"],
    ["probable-allies", "rivals"],
    ["co-investors", "rivals"],
    ["mentor-mentee", "rivals"],
];
/** Build a quick lookup: type → set of conflicting types. */
function buildConflictMap() {
    const map = new Map();
    for (const [a, b] of CONFLICT_PAIRS) {
        if (!map.has(a))
            map.set(a, new Set());
        if (!map.has(b))
            map.set(b, new Set());
        map.get(a).add(b);
        map.get(b).add(a);
    }
    return map;
}
const CONFLICT_MAP = buildConflictMap();
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
export function detectConflicts(edges) {
    const conflicts = [];
    // Group edges by normalized entity pair
    const byPair = new Map();
    for (const edge of edges) {
        const a = edge.metadata?.entity_a;
        const b = edge.metadata?.entity_b;
        if (!a || !b)
            continue;
        // Normalize: always alphabetical order
        const [first, second] = a < b ? [a, b] : [b, a];
        const key = `${first}|${second}`;
        if (!byPair.has(key))
            byPair.set(key, []);
        byPair.get(key).push(edge);
    }
    // Check each pair for conflicts
    for (const [key, pairEdges] of byPair) {
        if (pairEdges.length < 2)
            continue;
        // Get all relationship types for this pair
        const types = new Map();
        for (const edge of pairEdges) {
            const t = edge.metadata?.relationship_type;
            if (t && !types.has(t))
                types.set(t, edge);
        }
        // Check for conflicts
        for (const [typeA, edgeA] of types) {
            const conflicting = CONFLICT_MAP.get(typeA);
            if (!conflicting)
                continue;
            for (const typeB of conflicting) {
                const edgeB = types.get(typeB);
                if (edgeB && edgeA.id !== edgeB.id) {
                    // Found a conflict
                    const [first] = key.split("|");
                    const [, second] = key.split("|");
                    // Avoid duplicate conflicts (A vs B same as B vs A)
                    const conflictKey = [typeA, typeB].sort().join("|");
                    const alreadyReported = conflicts.some(c => c.entity_a === first && c.entity_b === second &&
                        [c.types[0], c.types[1]].sort().join("|") === conflictKey);
                    if (!alreadyReported) {
                        conflicts.push({
                            entity_a: first,
                            entity_b: second,
                            types: [typeA, typeB],
                            edge_ids: [edgeA.id, edgeB.id],
                        });
                    }
                }
            }
        }
    }
    return conflicts;
}
