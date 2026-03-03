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
export declare function buildFilterClauses(filters: SearchFilters | undefined, startIdx: number): {
    clauses: string[];
    values: unknown[];
    nextIdx: number;
};
