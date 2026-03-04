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
const ALLOWED_OPS = new Set(["=", "!=", ">", ">=", "<", "<="]);
const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
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
export function buildMetadataFilters(filters, startIdx) {
    if (!filters || filters.length === 0) {
        return { clauses: [], values: [], nextIdx: startIdx };
    }
    const clauses = [];
    const values = [];
    let idx = startIdx;
    for (const f of filters) {
        // Validate field name
        if (!FIELD_RE.test(f.field)) {
            throw new Error(`Invalid metadata filter field: "${f.field}"`);
        }
        // Validate operator
        if (!ALLOWED_OPS.has(f.op)) {
            throw new Error(`Invalid metadata filter op: "${f.op}"`);
        }
        // Numeric value → cast JSONB text to numeric for comparison
        // String value → compare text directly
        if (typeof f.value === "number") {
            clauses.push(`(metadata->>'${f.field}')::numeric ${f.op} $${idx++}`);
        }
        else {
            clauses.push(`metadata->>'${f.field}' ${f.op} $${idx++}`);
        }
        values.push(f.value);
    }
    return { clauses, values, nextIdx: idx };
}
