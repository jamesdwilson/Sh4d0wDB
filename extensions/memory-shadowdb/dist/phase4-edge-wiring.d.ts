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
import type { EdgeSignal } from "./phase4-profile-linkedin.js";
import type { ResolvedEntity } from "./phase3b-entity-resolver.js";
/** Minimal resolver interface required by processEdgeSignals */
export interface EdgeResolver {
    resolve(candidate: {
        type: string;
        name?: string;
        companyName?: string;
        linkedinUrl?: string;
        sourceId: string;
        sourceRecordId: string;
        confidence: number;
    }): Promise<ResolvedEntity | null>;
    addEdge(edge: {
        fromId: number;
        toId: number;
        type: string;
        confidence: number;
        sourceId: string;
        evidenceText?: string;
    }): Promise<void>;
}
/** Summary returned by processEdgeSignals */
export interface EdgeWiringSummary {
    /** Number of candidates that resolved to an entity (from + to, counted separately) */
    resolved: number;
    /** Number of edges successfully added */
    edges: number;
    /** Number of signals that failed (resolver threw or returned null for both) */
    errors: number;
}
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
export declare function processEdgeSignals(signals: EdgeSignal[], resolver: EdgeResolver): Promise<EdgeWiringSummary>;
