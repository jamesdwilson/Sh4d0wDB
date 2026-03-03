/**
 * metadata-filters.ts — Typed metadata comparison SQL builder
 *
 * Sprint 5: extends filter capability beyond JSONB containment (@>)
 * to support typed comparisons: >, >=, <, <=, =, !=
 *
 * SECURITY:
 * - Field names validated against /^[a-zA-Z_][a-zA-Z0-9_]*$/ — no interpolation of user input
 * - Operators whitelisted — no arbitrary SQL injection via op field
 * - Values always parameterized ($N) — never interpolated
 */
/** Allowed comparison operators. */
export type MetadataOp = "=" | "!=" | ">" | ">=" | "<" | "<=";
export interface MetadataFilter {
    /** metadata field name, e.g. "confidence", "tier", "last_verified" */
    field: string;
    /** comparison operator */
    op: MetadataOp;
    /** value to compare against (string or number) */
    value: string | number;
}
/**
 * Build parameterized SQL clauses for typed metadata field comparisons.
 *
 * For numeric values: casts the JSONB text value to numeric before comparing.
 * For string values: compares the raw text value (no cast).
 *
 * @param filters  - Array of metadata filter specs
 * @param startIdx - First $N parameter index to use
 *
 * @throws Error if field name or operator is invalid
 *
 * @example
 *   buildMetadataFilters([{ field: 'confidence', op: '>', value: 70 }], 3)
 *   // → { clauses: ["(metadata->>'confidence')::numeric > $3"], values: [70], nextIdx: 4 }
 */
export declare function buildMetadataFilters(filters: MetadataFilter[] | undefined, startIdx: number): {
    clauses: string[];
    values: (string | number)[];
    nextIdx: number;
};
