/**
 * graph-queries.ts — Pure SQL builders for graph traversal
 *
 * Extracted for isolated unit testing. No external dependencies.
 *
 * Graph edges are stored as:
 *   record_type = 'atom'
 *   category    = 'graph'
 *   tags        = ['entity:slug-a', 'entity:slug-b', ...]
 *   metadata    = { entity_a, entity_b, relationship_type, confidence, ... }
 *
 * See GRAPH_SPEC.md for full edge schema and relationship type conventions.
 */
/** A graph edge as stored in the memories table. */
export interface GraphEdge {
    id: number;
    content: string;
    tags: string[];
    metadata: {
        entity_a?: string;
        entity_a_type?: string;
        entity_b?: string;
        entity_b_type?: string;
        relationship_type?: string;
        evidence_type?: string;
        confidence?: number;
        affinity_score?: number;
        affinity_basis?: string;
        signal_basis?: string;
        depth?: number;
        last_verified?: string;
        [key: string]: unknown;
    };
}
export interface EdgeQueryOptions {
    /** Minimum confidence threshold (0-100). Edges below this are excluded. */
    min_confidence?: number;
    /** Filter to a specific relationship type slug (e.g. "knows", "tension"). */
    relationship_type?: string;
    /** Table name (default: "memories"). */
    table?: string;
}
/**
 * Build a parameterized SQL query to fetch all graph edges for an entity slug.
 *
 * Finds all atom records tagged `entity:{slug}` in category=graph.
 * Returns SQL + bound values ready for pg.Pool.query().
 *
 * SECURITY: entity slug is parameterized. relationship_type filter uses
 * parameterized JSONB path — no interpolation.
 */
export declare function buildEdgeQuery(entitySlug: string, opts?: EdgeQueryOptions): {
    sql: string;
    values: unknown[];
};
/**
 * Given a graph edge and the "from" entity slug, return the slug of the
 * connected entity on the other side of the edge.
 *
 * Returns null if the edge metadata is malformed or the slug doesn't appear
 * in either entity_a or entity_b.
 */
export declare function extractConnectedEntity(edge: GraphEdge, fromSlug: string): string | null;
/**
 * Normalize an entity slug: lowercase, trim, replace spaces with hyphens.
 * Prevents slug mismatches from casing or whitespace differences.
 */
export declare function normalizeEntitySlug(raw: string): string;
