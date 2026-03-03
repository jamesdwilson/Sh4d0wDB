/**
 * conflict-detection.test.mjs — TDD: detect contradictory relationship edges
 *
 * v0.6.0: conflict detection — find edges where same entity pair has
 * contradictory relationship types (e.g., "knows" AND "tension", "allies" AND "rivals").
 *
 * Written before implementation. All tests fail until conflict-detector.ts exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectConflicts, CONFLICT_PAIRS } from './dist/conflict-detector.js';

// ============================================================================
// Constants
// ============================================================================

test('CONFLICT_PAIRS includes known contradictory types', () => {
  // knows vs tension
  assert.ok(CONFLICT_PAIRS.some(p => p.includes('knows') && p.includes('tension')));
  // allies vs rivals
  assert.ok(CONFLICT_PAIRS.some(p => p.includes('allies') && p.includes('rivals')));
  // probable-allies vs tension
  assert.ok(CONFLICT_PAIRS.some(p => p.includes('probable-allies') && p.includes('tension')));
});

// ============================================================================
// Conflict detection
// ============================================================================

function edge(id, entity_a, entity_b, relationship_type, confidence = 80) {
  return {
    id,
    content: `${entity_a} — ${entity_b}`,
    tags: [`entity:${entity_a}`, `entity:${entity_b}`],
    metadata: { entity_a, entity_b, relationship_type, confidence },
  };
}

test('detectConflicts returns empty array for no conflicts', () => {
  const edges = [
    edge(1, 'alice', 'bob', 'knows'),
    edge(2, 'alice', 'carol', 'knows'),
  ];
  const result = detectConflicts(edges);
  assert.equal(result.length, 0);
});

test('detectConflicts detects knows+tension for same entity pair', () => {
  const edges = [
    edge(1, 'alice', 'bob', 'knows'),
    edge(2, 'alice', 'bob', 'tension'),
  ];
  const result = detectConflicts(edges);
  assert.equal(result.length, 1);
  assert.equal(result[0].entity_a, 'alice');
  assert.equal(result[0].entity_b, 'bob');
  assert.ok(result[0].types.includes('knows'));
  assert.ok(result[0].types.includes('tension'));
  assert.ok(result[0].edge_ids.includes(1));
  assert.ok(result[0].edge_ids.includes(2));
});

test('detectConflicts normalizes entity order (a→b same as b→a)', () => {
  const edges = [
    edge(1, 'alice', 'bob', 'knows'),
    edge(2, 'bob', 'alice', 'tension'), // reversed order
  ];
  const result = detectConflicts(edges);
  assert.equal(result.length, 1);
  // Should normalize to alphabetical order
  assert.ok(result[0].entity_a < result[0].entity_b);
});

test('detectConflicts returns multiple conflicts for different pairs', () => {
  const edges = [
    edge(1, 'alice', 'bob', 'knows'),
    edge(2, 'alice', 'bob', 'tension'),
    edge(3, 'carol', 'dave', 'allies'),
    edge(4, 'carol', 'dave', 'rivals'),
  ];
  const result = detectConflicts(edges);
  assert.equal(result.length, 2);
});

test('detectConflicts ignores non-conflicting types for same pair', () => {
  const edges = [
    edge(1, 'alice', 'bob', 'knows'),
    edge(2, 'alice', 'bob', 'colleagues'), // not a conflict
  ];
  const result = detectConflicts(edges);
  assert.equal(result.length, 0);
});

test('detectConflicts handles empty input', () => {
  const result = detectConflicts([]);
  assert.equal(result.length, 0);
});
