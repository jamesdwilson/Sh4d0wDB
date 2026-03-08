/**
 * phase4-edge-wiring.ts — LinkedIn edge signal → EntityResolver pipeline
 *
 * Glue between Phase 4 (LinkedIn profile scraping) and Phase 3b (entity graph).
 *
 * When a LinkedIn profile is ingested:
 *   1. extractEdgeSignals(profile, selfName) → EdgeSignal[]
 *   2. processEdgeSignals(signals, resolver) → resolves both endpoints,
 *      calls addEdge() for each pair that resolves successfully
 *
 * Design:
 *   - Never throws — per-signal errors are caught and counted
 *   - Fire-and-forget safe — caller can await or not
 *   - Returns a summary for logging: { resolved, edges, errors }
 *   - Resolver is injected — fully testable with mock
 *
 * See: ARCHITECTURE.md § 7.5, phase4-profile-linkedin.ts, phase3b-entity-resolver.ts
 */
// ============================================================================
// processEdgeSignals
// ============================================================================
/**
 * Process a list of EdgeSignals through an EntityResolver.
 *
 * For each signal:
 *   1. Resolve fromCandidate → ResolvedEntity (or null)
 *   2. Resolve toCandidate   → ResolvedEntity (or null)
 *   3. If both resolve: call resolver.addEdge()
 *   4. If either fails to resolve: skip edge (log as error)
 *
 * Never throws. Per-signal errors are counted in summary.errors.
 *
 * @param signals  - EdgeSignal[] from extractEdgeSignals()
 * @param resolver - EntityResolver (real or mock)
 * @returns        - Summary of what was resolved/added/failed
 */
export async function processEdgeSignals(signals, resolver) {
    const summary = { resolved: 0, edges: 0, errors: 0 };
    if (signals.length === 0)
        return summary;
    for (const signal of signals) {
        try {
            // Resolve both endpoints in parallel
            const [fromEntity, toEntity] = await Promise.all([
                resolver.resolve({
                    type: signal.fromCandidate.type,
                    name: signal.fromCandidate.name,
                    companyName: signal.fromCandidate.companyName,
                    linkedinUrl: signal.fromCandidate.linkedinUrl,
                    sourceId: signal.fromCandidate.sourceId,
                    sourceRecordId: signal.fromCandidate.sourceRecordId,
                    confidence: signal.fromCandidate.confidence,
                }).catch(() => null),
                resolver.resolve({
                    type: signal.toCandidate.type,
                    name: signal.toCandidate.name,
                    companyName: signal.toCandidate.companyName,
                    linkedinUrl: signal.toCandidate.linkedinUrl,
                    sourceId: signal.toCandidate.sourceId,
                    sourceRecordId: signal.toCandidate.sourceRecordId,
                    confidence: signal.toCandidate.confidence,
                }).catch(() => null),
            ]);
            if (fromEntity)
                summary.resolved++;
            if (toEntity)
                summary.resolved++;
            if (!fromEntity || !toEntity) {
                // One or both endpoints couldn't be resolved — skip edge
                summary.errors++;
                continue;
            }
            await resolver.addEdge({
                fromId: fromEntity.id,
                toId: toEntity.id,
                type: signal.type,
                confidence: signal.confidence,
                sourceId: signal.sourceId,
                evidenceText: signal.evidenceText,
            }).catch(() => { summary.errors++; });
            summary.edges++;
        }
        catch {
            summary.errors++;
        }
    }
    return summary;
}
//# sourceMappingURL=phase4-edge-wiring.js.map