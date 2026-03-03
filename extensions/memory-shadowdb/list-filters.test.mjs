/**
 * list-filters.test.mjs — Unit tests for buildListConditions + buildSortClause
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildListConditions, buildSortClause } from './dist/list-filters.js';

// ============================================================================
// buildListConditions
// ============================================================================

test('buildListConditions always includes deleted_at IS NULL', () => {
  const { conditions } = buildListConditions({});
  assert.equal(conditions[0], 'deleted_at IS NULL');
});

test('buildListConditions returns only deleted_at IS NULL for empty params', () => {
  const { conditions, values, nextIdx } = buildListConditions({});
  assert.equal(conditions.length, 1);
  assert.equal(values.length, 0);
  assert.equal(nextIdx, 1);
});

test('buildListConditions handles tags (exact), tags_include, tags_any', () => {
  const { conditions, values } = buildListConditions({
    tags: ['a'],
    tags_include: ['b'],
    tags_any: ['c', 'd'],
  });
  assert.ok(conditions.some(c => c.includes('tags @> $') && !c.includes('&&')));
  assert.ok(conditions.some(c => c.includes('tags && $')));
  assert.equal(values.filter(v => Array.isArray(v)).length, 3);
});

test('buildListConditions serializes metadata as JSON string', () => {
  const { conditions, values } = buildListConditions({ metadata: { tier: 'vip' } });
  assert.ok(conditions.some(c => c.includes('metadata @> $') && c.includes('::jsonb')));
  const jsonVal = values.find(v => typeof v === 'string' && v.includes('vip'));
  assert.ok(jsonVal, 'metadata value should be JSON string');
  assert.deepEqual(JSON.parse(jsonVal), { tier: 'vip' });
});

test('buildListConditions sequences indices from startIdx', () => {
  const { conditions, nextIdx } = buildListConditions({ category: 'domain', priority_min: 5 }, 3);
  assert.ok(conditions.some(c => c.includes('$3')));
  assert.ok(conditions.some(c => c.includes('$4')));
  assert.equal(nextIdx, 5);
});

// ============================================================================
// buildSortClause
// ============================================================================

test('buildSortClause defaults to created_at DESC', () => {
  assert.equal(buildSortClause(), 'ORDER BY created_at DESC');
});

test('buildSortClause respects asc direction', () => {
  assert.equal(buildSortClause('priority', 'asc'), 'ORDER BY priority ASC');
});

test('buildSortClause falls back to created_at for unknown column', () => {
  assert.equal(buildSortClause('unknown_col', 'desc'), 'ORDER BY created_at DESC');
});

test('buildSortClause generates metadata CASE expression', () => {
  const clause = buildSortClause('metadata.confidence', 'desc');
  assert.ok(clause.includes("metadata->>'confidence'"));
  assert.ok(clause.includes('NULLS LAST'));
});

test('buildSortClause throws for invalid metadata field name', () => {
  assert.throws(() => buildSortClause('metadata.bad;drop', 'asc'), /invalid metadata sort field/i);
  assert.throws(() => buildSortClause('metadata.has space', 'asc'), /invalid metadata sort field/i);
});
