/**
 * tools.ts — Tool handlers for v0.7.0 features
 *
 * Tool wrappers that call the logic functions and format responses.
 * These get registered with the OpenClaw plugin system.
 */
import { detectConflicts } from "./conflict-detector.js";
import { decayConfidence } from "./confidence-decay.js";
import type { PostgresStore } from "./postgres.js";
export interface ConflictsToolParams {
    domain?: string;
    min_confidence?: number;
}
export interface DecayPreviewToolParams {
    half_life_days?: number;
    min_confidence?: number;
}
/**
 * memory_conflicts tool handler
 *
 * Returns contradictory edges from the graph.
 */
export declare function handleConflictsTool(store: PostgresStore, params: ConflictsToolParams): Promise<{
    conflicts: ReturnType<typeof detectConflicts>;
}>;
/**
 * memory_decay_preview tool handler
 *
 * Returns preview of confidence decay for stale edges.
 * Does NOT modify data — just shows what would decay.
 */
export declare function handleDecayPreviewTool(store: PostgresStore, params: DecayPreviewToolParams): Promise<{
    results: ReturnType<typeof decayConfidence>;
}>;
