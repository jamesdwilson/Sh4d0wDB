/**
 * rrf.ts — Reciprocal Rank Fusion merge for memory search
 *
 * Extracted from MemoryStore to enable isolated unit testing.
 * No external dependencies — compiles standalone.
 *
 * RRF Reference: Cormack, Clarke, & Buettcher (2009)
 */
import { RRF_K } from "./store.js";
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
export function mergeRRF(vectorHits, ftsHits, fuzzyHits, maxResults, minScore, config) {
    const scoreMap = new Map();
    const addSignal = (hits, weight) => {
        for (const hit of hits) {
            const contribution = weight / (RRF_K + hit.rank);
            const existing = scoreMap.get(hit.id);
            if (existing) {
                existing.rrfScore += contribution;
            }
            else {
                scoreMap.set(hit.id, { hit, rrfScore: contribution });
            }
        }
    };
    addSignal(vectorHits, config.vectorWeight);
    addSignal(ftsHits, config.textWeight);
    addSignal(fuzzyHits, 0.2); // fixed trigram weight
    // Recency boost: rank all seen records by created_at (newest first), apply RRF
    const allEntries = [...scoreMap.values()];
    const byRecency = [...allEntries]
        .filter((e) => e.hit.created_at != null)
        .sort((a, b) => {
        const dateA = a.hit.created_at instanceof Date
            ? a.hit.created_at
            : new Date(a.hit.created_at);
        const dateB = b.hit.created_at instanceof Date
            ? b.hit.created_at
            : new Date(b.hit.created_at);
        return dateB.getTime() - dateA.getTime(); // newest first
    });
    byRecency.forEach((entry, idx) => {
        entry.rrfScore += config.recencyWeight / (RRF_K + idx + 1);
    });
    return allEntries
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .filter((e) => e.rrfScore > Math.max(minScore, 0.001))
        .slice(0, maxResults)
        .map((e) => ({ ...e.hit, rrfScore: e.rrfScore }));
}
//# sourceMappingURL=rrf.js.map