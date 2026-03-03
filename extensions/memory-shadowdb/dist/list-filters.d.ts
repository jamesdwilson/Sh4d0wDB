/**
 * list-filters.ts — Pure SQL builders for memory_list queries
 *
 * Extracted from postgres.ts to enable isolated unit testing.
 * No external dependencies — compiles standalone.
 */
export interface ListParams {
    category?: string;
    record_type?: string;
    parent_id?: number;
    priority_min?: number;
    priority_max?: number;
    created_after?: string;
    created_before?: string;
    tags?: string[];
    tags_include?: string[];
    tags_any?: string[];
    metadata?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    sort?: string;
    sort_order?: "asc" | "desc";
    detail_level?: string;
}
/**
 * Build WHERE conditions for memory_list queries.
 *
 * Always includes `deleted_at IS NULL` as the first condition.
 * All user values are parameterized — no SQL injection risk.
 *
 * @param params   - List filter parameters
 * @param startIdx - First $N parameter index to use (default 1)
 */
export declare function buildListConditions(params: ListParams, startIdx?: number): {
    conditions: string[];
    values: unknown[];
    nextIdx: number;
};
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
export declare function buildSortClause(sort?: string, sort_order?: "asc" | "desc"): string;
