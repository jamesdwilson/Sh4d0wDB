/**
 * filters.ts — Pure SQL filter clause builder for memory search
 *
 * Extracted from postgres.ts to enable isolated unit testing.
 * No external dependencies — compiles standalone.
 *
 * Used by postgres.ts and testable without pg/mysql/sqlite deps.
 */

import type { SearchFilters } from "./types.js";

/**
 * Build additional WHERE conditions from SearchFilters.
 *
 * Returns parameterized SQL clauses and their bound values.
 * Caller provides startIdx — the next $N parameter index to use.
 *
 * All user values are parameterized — no SQL injection risk.
 * Table/column names are hardcoded — no user input in structure.
 *
 * @example
 *   const { clauses, values, nextIdx } = buildFilterClauses(filters, 3);
 *   // Produces: ["category = $3", "tags @> $4::text[]"]
 *   //           [["my-category"], ["tag1","tag2"]]
 */
export function buildFilterClauses(
  filters: SearchFilters | undefined,
  startIdx: number,
): {
  clauses: string[];
  values: unknown[];
  nextIdx: number;
} {
  if (!filters) return { clauses: [], values: [], nextIdx: startIdx };

  const clauses: string[] = [];
  const values: unknown[] = [];
  let idx = startIdx;

  if (filters.category) {
    clauses.push(`category = $${idx++}`);
    values.push(filters.category);
  }
  if (filters.record_type) {
    clauses.push(`record_type = $${idx++}`);
    values.push(filters.record_type);
  }
  if (filters.tags_include && filters.tags_include.length > 0) {
    clauses.push(`tags @> $${idx++}::text[]`);
    values.push(filters.tags_include);
  }
  if (filters.tags_any && filters.tags_any.length > 0) {
    clauses.push(`tags && $${idx++}::text[]`);
    values.push(filters.tags_any);
  }
  if (filters.priority_min !== undefined) {
    clauses.push(`priority >= $${idx++}`);
    values.push(filters.priority_min);
  }
  if (filters.priority_max !== undefined) {
    clauses.push(`priority <= $${idx++}`);
    values.push(filters.priority_max);
  }
  if (filters.created_after) {
    clauses.push(`created_at >= $${idx++}`);
    values.push(filters.created_after);
  }
  if (filters.created_before) {
    clauses.push(`created_at <= $${idx++}`);
    values.push(filters.created_before);
  }
  if (filters.parent_id !== undefined) {
    clauses.push(`parent_id = $${idx++}`);
    values.push(filters.parent_id);
  }

  return { clauses, values, nextIdx: idx };
}
