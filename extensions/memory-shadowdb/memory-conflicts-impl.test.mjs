/**
 * memory-conflicts-impl.test.mjs — Implementation tests for memory_conflicts tool
 *
 * Tests the tool wrapper logic using mock store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectConflicts } from './dist/conflict-detector.js';

// Tool wrapper logic test — doesn't need actual tool registration
test('memory_conflicts tool logic calls detectConflicts with edges', async () => {
  const edges = [
    { id: 1, content: '', tags: [], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'knows', confidence: 80 } },
    { id: 2, content: '', tags: [], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'tension', confidence: 70 } },
  ];
  
  const conflicts = detectConflicts(edges);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].entity_a, 'alice');
  assert.equal(conflicts[0].entity_b, 'bob');
});

test('memory_conflicts tool logic filters by domain when specified', async () => {
  // Domain filter would be applied at query time, not in detectConflicts
  // This test verifies the function works with filtered input
  const edges = [
    { id: 1, content: '', tags: ['domain:civic'], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'knows', confidence: 80 } },
    { id: 2, content: '', tags: ['domain:ma'], metadata: { entity_a: 'carol', entity_b: 'dave', relationship_type: 'allies', confidence: 90 } },
  ];
  
  // Simulate domain filter: only civic edges
  const civicEdges = edges.filter(e => e.tags.includes('domain:civic'));
  const conflicts = detectConflicts(civicEdges);
  assert.equal(conflicts.length, 0); // No conflicts in civic-only set
});

test('memory_conflicts tool logic respects min_confidence threshold', async () => {
  const edges = [
    { id: 1, content: '', tags: [], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'knows', confidence: 90 } },
    { id: 2, content: '', tags: [], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'tension', confidence: 30 } }, // below threshold
  ];
  
  // Simulate min_confidence filter
  const highConfidence = edges.filter(e => (e.metadata?.confidence ?? 0) >= 50);
  const conflicts = detectConflicts(highConfidence);
  assert.equal(conflicts.length, 0); // Tension edge filtered out
});

test('memory_conflicts tool logic returns empty for no conflicts', async () => {
  const edges = [
    { id: 1, content: '', tags: [], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'knows', confidence: 80 } },
  ];
  const conflicts = detectConflicts(edges);
  assert.equal(conflicts.length, 0);
});

test('memory_conflicts tool logic includes edge IDs in results', async () => {
  const edges = [
    { id: 100, content: '', tags: [], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'knows', confidence: 80 } },
    { id: 200, content: '', tags: [], metadata: { entity_a: 'alice', entity_b: 'bob', relationship_type: 'tension', confidence: 70 } },
  ];
  const conflicts = detectConflicts(edges);
  assert.ok(conflicts[0].edge_ids.includes(100));
  assert.ok(conflicts[0].edge_ids.includes(200));
});
