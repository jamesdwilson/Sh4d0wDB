/**
 * phase1-parties.ts — Party resolution: fuzzy-match extracted names to ShadowDB contacts
 *
 * Resolves named parties extracted from ingested documents (email From headers,
 * PDF signatories, etc.) against existing ShadowDB contact records.
 *
 * Contact title format in DB: "First Last — Dossier (Type)"
 * Name is extracted as everything before the " — " (em dash) separator.
 *
 * Matching strategy (in order):
 *   1. Exact match (case-insensitive) on extracted name → score 1.0
 *   2. Exact match after stripping suffixes (PhD, Jr, III, etc.) → score 0.95
 *   3. All query tokens appear in contact name → score 0.80
 *   4. Single token match (last name only) — only if unambiguous → score 0.70
 *   5. No match → memoryId null, score 0
 *
 * NEVER throws — DB errors yield null memoryId for all parties.
 *
 * @module phase1-parties
 */
/**
 * Minimal DB client interface for resolveParties().
 * Inject a real pg.Pool or a mock for testing.
 */
export interface DbClient {
    /**
     * Execute a parameterized SQL query.
     * @param sql    - SQL string with $1, $2 placeholders
     * @param params - Parameter values
     * @returns      - Result with rows array
     */
    query(sql: string, params?: unknown[]): Promise<{
        rows: ContactRow[];
    }>;
}
/** A row from the memories table representing a contact */
interface ContactRow {
    readonly id: number;
    readonly title: string;
    readonly category: string;
}
/**
 * A resolved party reference.
 * memoryId is null if no match was found.
 * matchScore is 0 if no match, 0.70–1.0 if matched.
 */
export interface ResolvedParty {
    /** The original extracted name from the document */
    readonly name: string;
    /** ShadowDB memory id of the matched contact, or null */
    readonly memoryId: number | null;
    /** Match confidence [0, 1] — 0 = no match, 1.0 = exact */
    readonly matchScore: number;
}
/**
 * Resolve extracted party names to existing ShadowDB contact records.
 *
 * Queries the DB for all contact-category records, then fuzzy-matches each
 * party name against the extracted contact name (title prefix before " — ").
 *
 * Returns one ResolvedParty per input name, in the same order.
 * memoryId is null if no confident match exists.
 *
 * NEVER throws — on DB failure, returns all null memoryIds.
 *
 * @param parties - Extracted party names from a document
 * @param db      - Database client (injected for testability)
 * @returns       - Resolved party references, same length as input
 */
export declare function resolveParties(parties: string[], db: DbClient): Promise<ResolvedParty[]>;
export {};
