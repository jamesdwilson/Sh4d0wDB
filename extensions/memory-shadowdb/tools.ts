/**
 * tools.ts — Tool handlers for v0.7.0 features
 *
 * Tool wrappers that call the logic functions and format responses.
 * These get registered with the OpenClaw plugin system.
 */

import { detectConflicts, type GraphEdge } from "./conflict-detector.js";
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
export async function handleConflictsTool(
  store: PostgresStore,
  params: ConflictsToolParams,
): Promise<{ conflicts: ReturnType<typeof detectConflicts> }> {
  // Query all graph edges
  const edges = await store.queryAllGraphEdges({
    domain: params.domain,
    min_confidence: params.min_confidence,
  });

  // Detect conflicts
  const conflicts = detectConflicts(edges);

  return { conflicts };
}

/**
 * memory_decay_preview tool handler
 *
 * Returns preview of confidence decay for stale edges.
 * Does NOT modify data — just shows what would decay.
 */
export async function handleDecayPreviewTool(
  store: PostgresStore,
  params: DecayPreviewToolParams,
): Promise<{ results: ReturnType<typeof decayConfidence> }> {
  const halfLifeDays = params.half_life_days ?? 30;
  const minConfidence = params.min_confidence ?? 0;

  // Query all graph edges
  const edges = await store.queryAllGraphEdges();

  // Compute decay preview
  const results = decayConfidence(edges, { halfLifeDays, minConfidence });

  return { results };
}
