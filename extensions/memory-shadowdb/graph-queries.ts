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
export function buildEdgeQuery(
  entitySlug: string,
  opts: EdgeQueryOptions = {},
): { sql: string; values: unknown[] } {
  const table = opts.table ?? "memories";
  const tag = `entity:${entitySlug}`;
  const values: unknown[] = [tag];
  let idx = 2;

  const conditions = [
    "deleted_at IS NULL",
    "category = 'graph'",
    "record_type = 'atom'",
    `tags @> ARRAY[$1]::text[]`,
  ];

  if (opts.min_confidence !== undefined && opts.min_confidence > 0) {
    conditions.push(`(metadata->>'confidence')::numeric >= $${idx++}`);
    values.push(opts.min_confidence);
  }

  if (opts.relationship_type) {
    conditions.push(`metadata->>'relationship_type' = $${idx++}`);
    values.push(opts.relationship_type);
  }

  const sql = `
    SELECT id, content, tags,
           COALESCE(metadata, '{}') as metadata
    FROM ${table}
    WHERE ${conditions.join(" AND ")}
    ORDER BY (metadata->>'confidence')::numeric DESC NULLS LAST, created_at DESC
  `;

  return { sql, values };
}

/**
 * Given a graph edge and the "from" entity slug, return the slug of the
 * connected entity on the other side of the edge.
 *
 * Returns null if the edge metadata is malformed or the slug doesn't appear
 * in either entity_a or entity_b.
 */
export function extractConnectedEntity(
  edge: GraphEdge,
  fromSlug: string,
): string | null {
  const a = edge.metadata?.entity_a;
  const b = edge.metadata?.entity_b;

  if (!a || !b) return null;

  if (a === fromSlug) return b;
  if (b === fromSlug) return a;

  // Edge is tagged with this entity but metadata doesn't match — malformed
  return null;
}

/**
 * Normalize an entity slug: lowercase, trim, replace spaces with hyphens.
 * Prevents slug mismatches from casing or whitespace differences.
 */
export function normalizeEntitySlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}
