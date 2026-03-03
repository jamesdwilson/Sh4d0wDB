/**
 * graph-queries.test.mjs — Unit tests for graph-queries.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEdgeQuery, extractConnectedEntity, normalizeEntitySlug } from './dist/graph-queries.js';

// ============================================================================
// buildEdgeQuery
// ============================================================================

test('buildEdgeQuery produces correct tag filter', () => {
  const { sql, values } = buildEdgeQuery('james-wilson');
  assert.ok(sql.includes("tags @> ARRAY[$1]::text[]"));
  assert.equal(values[0], 'entity:james-wilson');
});

test('buildEdgeQuery always filters category=graph and record_type=atom', () => {
  const { sql } = buildEdgeQuery('james-wilson');
  assert.ok(sql.includes("category = 'graph'"));
  assert.ok(sql.includes("record_type = 'atom'"));
  assert.ok(sql.includes("deleted_at IS NULL"));
});

test('buildEdgeQuery adds confidence filter when min_confidence > 0', () => {
  const { sql, values } = buildEdgeQuery('james-wilson', { min_confidence: 60 });
  assert.ok(sql.includes("confidence')::numeric >= $2"));
  assert.equal(values[1], 60);
});

test('buildEdgeQuery skips confidence filter when min_confidence is 0', () => {
  const { sql, values } = buildEdgeQuery('james-wilson', { min_confidence: 0 });
  // Only the tag value should be in values — no numeric confidence param
  assert.equal(values.length, 1);
  assert.ok(!sql.includes('::numeric >='));
});

test('buildEdgeQuery adds relationship_type filter', () => {
  const { sql, values } = buildEdgeQuery('james-wilson', { relationship_type: 'knows' });
  assert.ok(sql.includes("relationship_type' = $"));
  assert.ok(values.includes('knows'));
});

test('buildEdgeQuery sequences params correctly with both filters', () => {
  const { values } = buildEdgeQuery('slug', { min_confidence: 70, relationship_type: 'tension' });
  assert.equal(values[0], 'entity:slug');
  assert.equal(values[1], 70);
  assert.equal(values[2], 'tension');
});

test('buildEdgeQuery uses custom table name', () => {
  const { sql } = buildEdgeQuery('slug', { table: 'custom_table' });
  assert.ok(sql.includes('FROM custom_table'));
});

// ============================================================================
// extractConnectedEntity
// ============================================================================

function edge(entity_a, entity_b, extra = {}) {
  return {
    id: 1,
    content: 'test edge',
    tags: [`entity:${entity_a}`, `entity:${entity_b}`],
    metadata: { entity_a, entity_b, ...extra },
  };
}

test('extractConnectedEntity returns entity_b when querying from entity_a', () => {
  const result = extractConnectedEntity(edge('alice', 'bob'), 'alice');
  assert.equal(result, 'bob');
});

test('extractConnectedEntity returns entity_a when querying from entity_b', () => {
  const result = extractConnectedEntity(edge('alice', 'bob'), 'bob');
  assert.equal(result, 'alice');
});

test('extractConnectedEntity returns null when slug not in edge', () => {
  const result = extractConnectedEntity(edge('alice', 'bob'), 'charlie');
  assert.equal(result, null);
});

test('extractConnectedEntity returns null for malformed edge (missing entity_b)', () => {
  const result = extractConnectedEntity({ id: 1, content: '', tags: [], metadata: { entity_a: 'alice' } }, 'alice');
  assert.equal(result, null);
});

// ============================================================================
// normalizeEntitySlug
// ============================================================================

test('normalizeEntitySlug lowercases', () => {
  assert.equal(normalizeEntitySlug('James-Wilson'), 'james-wilson');
});

test('normalizeEntitySlug trims whitespace', () => {
  assert.equal(normalizeEntitySlug('  james-wilson  '), 'james-wilson');
});

test('normalizeEntitySlug replaces spaces with hyphens', () => {
  assert.equal(normalizeEntitySlug('james wilson'), 'james-wilson');
});
