/**
 * list-filters.ts — Pure SQL builders for memory_list queries
 *
 * Extracted from postgres.ts to enable isolated unit testing.
 * No external dependencies — compiles standalone.
 */
/**
 * Build WHERE conditions for memory_list queries.
 *
 * Always includes `deleted_at IS NULL` as the first condition.
 * All user values are parameterized — no SQL injection risk.
 *
 * @param params   - List filter parameters
 * @param startIdx - First $N parameter index to use (default 1)
 */
export function buildListConditions(params, startIdx = 1) {
    const conditions = ["deleted_at IS NULL"];
    const values = [];
    let idx = startIdx;
    if (params.category) {
        conditions.push(`category = $${idx++}`);
        values.push(params.category);
    }
    if (params.record_type) {
        conditions.push(`record_type = $${idx++}`);
        values.push(params.record_type);
    }
    if (params.parent_id !== undefined) {
        conditions.push(`parent_id = $${idx++}`);
        values.push(params.parent_id);
    }
    if (params.priority_min !== undefined) {
        conditions.push(`priority >= $${idx++}`);
        values.push(params.priority_min);
    }
    if (params.priority_max !== undefined) {
        conditions.push(`priority <= $${idx++}`);
        values.push(params.priority_max);
    }
    if (params.created_after) {
        conditions.push(`created_at >= $${idx++}`);
        values.push(params.created_after);
    }
    if (params.created_before) {
        conditions.push(`created_at <= $${idx++}`);
        values.push(params.created_before);
    }
    if (params.tags && params.tags.length > 0) {
        conditions.push(`tags @> $${idx++}::text[]`);
        values.push(params.tags);
    }
    if (params.tags_include && params.tags_include.length > 0) {
        conditions.push(`tags @> $${idx++}::text[]`);
        values.push(params.tags_include);
    }
    if (params.tags_any && params.tags_any.length > 0) {
        conditions.push(`tags && $${idx++}::text[]`);
        values.push(params.tags_any);
    }
    if (params.metadata && Object.keys(params.metadata).length > 0) {
        conditions.push(`metadata @> $${idx++}::jsonb`);
        values.push(JSON.stringify(params.metadata));
    }
    return { conditions, values, nextIdx: idx };
}
/** Allowed plain-column sort fields (whitelist against SQL injection). */
const ALLOWED_SORTS = ["created_at", "updated_at", "priority", "title"];
/**
 * Build ORDER BY clause for memory_list queries.
 *
 * Supports:
 * - Plain columns: created_at, updated_at, priority, title
 * - Metadata fields: metadata.fieldName (alphanumeric + underscore only)
 *
 * SECURITY: metadata field names are validated against /^[a-zA-Z_][a-zA-Z0-9_]*$/
 * to prevent SQL injection via the field name.
 *
 * @throws Error if metadata field name contains invalid characters
 */
export function buildSortClause(sort, sort_order) {
    const sortDir = sort_order === "asc" ? "ASC" : "DESC";
    if (sort && sort.startsWith("metadata.")) {
        const fieldName = sort.slice("metadata.".length);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fieldName)) {
            throw new Error(`Invalid metadata sort field: ${fieldName}`);
        }
        return `ORDER BY
        CASE WHEN metadata->>'${fieldName}' ~ '^-?[0-9]+(\\.[0-9]+)?$'
             THEN (metadata->>'${fieldName}')::numeric ELSE NULL END ${sortDir} NULLS LAST,
        metadata->>'${fieldName}' ${sortDir} NULLS LAST`;
    }
    const sortCol = ALLOWED_SORTS.includes(sort) ? sort : "created_at";
    return `ORDER BY ${sortCol} ${sortDir}`;
}
