/**
 * rrf.ts — Reciprocal Rank Fusion merge for memory search
 *
 * Extracted from MemoryStore to enable isolated unit testing.
 * No external dependencies — compiles standalone.
 *
 * RRF Reference: Cormack, Clarke, & Buettcher (2009)
 */
import { type RankedHit, type StoreConfig } from "./store.js";
/**
 * Merge ranked hits from multiple search signals using Reciprocal Rank Fusion.
 *
 * Each signal contributes: weight / (RRF_K + rank)
 * Recency boost adds a small recency-ordered rank signal on top.
 * Results are sorted by descending RRF score, filtered by minScore, and capped at maxResults.
 *
 * @param vectorHits   - Hits from vector similarity search (ranked 1-based)
 * @param ftsHits      - Hits from full-text search (ranked 1-based)
 * @param fuzzyHits    - Hits from trigram fuzzy search (ranked 1-based)
 * @param maxResults   - Maximum number of results to return
 * @param minScore     - Minimum RRF score threshold (exclusive)
 * @param config       - Store config with weight parameters
 */
export declare function mergeRRF(vectorHits: RankedHit[], ftsHits: RankedHit[], fuzzyHits: RankedHit[], maxResults: number, minScore: number, config: Pick<StoreConfig, "vectorWeight" | "textWeight" | "recencyWeight">): Array<RankedHit & {
    rrfScore: number;
}>;
