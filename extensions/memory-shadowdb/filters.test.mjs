/**
 * filters.test.mjs — Unit tests for buildFilterClauses
 *
 * Tests SQL clause generation for all SearchFilter fields.
 * Verifies parameterized values, clause text, and index sequencing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterClauses } from './dist/filters.js';

// ============================================================================
// No filters
// ============================================================================

test('buildFilterClauses returns empty result for undefined filters', () => {
  const result = buildFilterClauses(undefined, 1);
  assert.deepEqual(result.clauses, []);
  assert.deepEqual(result.values, []);
  assert.equal(result.nextIdx, 1);
});

test('buildFilterClauses returns empty result for empty filter object', () => {
  const result = buildFilterClauses({}, 1);
  assert.deepEqual(result.clauses, []);
  assert.deepEqual(result.values, []);
  assert.equal(result.nextIdx, 1);
});

// ============================================================================
// category
// ============================================================================

test('buildFilterClauses handles category filter', () => {
  const result = buildFilterClauses({ category: 'domain' }, 1);
  assert.deepEqual(result.clauses, ['category = $1']);
  assert.deepEqual(result.values, ['domain']);
  assert.equal(result.nextIdx, 2);
});

// ============================================================================
// record_type
// ============================================================================

test('buildFilterClauses handles record_type filter', () => {
  const result = buildFilterClauses({ record_type: 'atom' }, 1);
  assert.deepEqual(result.clauses, ['record_type = $1']);
  assert.deepEqual(result.values, ['atom']);
  assert.equal(result.nextIdx, 2);
});

// ============================================================================
// tags_include
// ============================================================================

test('buildFilterClauses handles tags_include', () => {
  const result = buildFilterClauses({ tags_include: ['james', 'deal'] }, 1);
  assert.deepEqual(result.clauses, ['tags @> $1::text[]']);
  assert.deepEqual(result.values, [['james', 'deal']]);
  assert.equal(result.nextIdx, 2);
});

test('buildFilterClauses skips empty tags_include array', () => {
  const result = buildFilterClauses({ tags_include: [] }, 1);
  assert.deepEqual(result.clauses, []);
  assert.deepEqual(result.values, []);
});

// ============================================================================
// tags_any
// ============================================================================

test('buildFilterClauses handles tags_any', () => {
  const result = buildFilterClauses({ tags_any: ['contact', 'lead'] }, 1);
  assert.deepEqual(result.clauses, ['tags && $1::text[]']);
  assert.deepEqual(result.values, [['contact', 'lead']]);
  assert.equal(result.nextIdx, 2);
});

test('buildFilterClauses skips empty tags_any array', () => {
  const result = buildFilterClauses({ tags_any: [] }, 1);
  assert.deepEqual(result.clauses, []);
  assert.deepEqual(result.values, []);
});

// ============================================================================
// priority_min / priority_max
// ============================================================================

test('buildFilterClauses handles priority_min', () => {
  const result = buildFilterClauses({ priority_min: 7 }, 1);
  assert.deepEqual(result.clauses, ['priority >= $1']);
  assert.deepEqual(result.values, [7]);
  assert.equal(result.nextIdx, 2);
});

test('buildFilterClauses handles priority_max', () => {
  const result = buildFilterClauses({ priority_max: 3 }, 1);
  assert.deepEqual(result.clauses, ['priority <= $1']);
  assert.deepEqual(result.values, [3]);
  assert.equal(result.nextIdx, 2);
});

test('buildFilterClauses handles priority range (min + max)', () => {
  const result = buildFilterClauses({ priority_min: 3, priority_max: 8 }, 1);
  assert.deepEqual(result.clauses, ['priority >= $1', 'priority <= $2']);
  assert.deepEqual(result.values, [3, 8]);
  assert.equal(result.nextIdx, 3);
});

test('buildFilterClauses includes priority_min: 0 (falsy but valid)', () => {
  const result = buildFilterClauses({ priority_min: 0 }, 1);
  assert.deepEqual(result.clauses, ['priority >= $1']);
  assert.deepEqual(result.values, [0]);
});

// ============================================================================
// created_after / created_before
// ============================================================================

test('buildFilterClauses handles created_after', () => {
  const result = buildFilterClauses({ created_after: '2026-01-01' }, 1);
  assert.deepEqual(result.clauses, ['created_at >= $1']);
  assert.deepEqual(result.values, ['2026-01-01']);
  assert.equal(result.nextIdx, 2);
});

test('buildFilterClauses handles created_before', () => {
  const result = buildFilterClauses({ created_before: '2026-03-01' }, 1);
  assert.deepEqual(result.clauses, ['created_at <= $1']);
  assert.deepEqual(result.values, ['2026-03-01']);
  assert.equal(result.nextIdx, 2);
});

// ============================================================================
// parent_id
// ============================================================================

test('buildFilterClauses handles parent_id', () => {
  const result = buildFilterClauses({ parent_id: 42 }, 1);
  assert.deepEqual(result.clauses, ['parent_id = $1']);
  assert.deepEqual(result.values, [42]);
  assert.equal(result.nextIdx, 2);
});

test('buildFilterClauses includes parent_id: 0 (falsy but valid)', () => {
  const result = buildFilterClauses({ parent_id: 0 }, 1);
  assert.deepEqual(result.clauses, ['parent_id = $1']);
  assert.deepEqual(result.values, [0]);
});

// ============================================================================
// startIdx sequencing
// ============================================================================

test('buildFilterClauses respects non-1 startIdx', () => {
  const result = buildFilterClauses({ category: 'test' }, 5);
  assert.deepEqual(result.clauses, ['category = $5']);
  assert.equal(result.nextIdx, 6);
});

test('buildFilterClauses sequences indices correctly with multiple filters', () => {
  const result = buildFilterClauses({
    category: 'domain',
    record_type: 'atom',
    priority_min: 5,
  }, 3);
  assert.deepEqual(result.clauses, [
    'category = $3',
    'record_type = $4',
    'priority >= $5',
  ]);
  assert.deepEqual(result.values, ['domain', 'atom', 5]);
  assert.equal(result.nextIdx, 6);
});

// ============================================================================
// Combined filters
// ============================================================================

test('buildFilterClauses handles all filters combined', () => {
  const result = buildFilterClauses({
    category: 'domain',
    record_type: 'section',
    tags_include: ['vip'],
    tags_any: ['deal', 'lead'],
    priority_min: 6,
    priority_max: 9,
    created_after: '2026-01-01',
    created_before: '2026-12-31',
    parent_id: 100,
  }, 1);

  assert.equal(result.clauses.length, 9);
  assert.equal(result.values.length, 9);
  assert.equal(result.nextIdx, 10);

  assert.equal(result.clauses[0], 'category = $1');
  assert.equal(result.clauses[1], 'record_type = $2');
  assert.equal(result.clauses[2], 'tags @> $3::text[]');
  assert.equal(result.clauses[3], 'tags && $4::text[]');
  assert.equal(result.clauses[4], 'priority >= $5');
  assert.equal(result.clauses[5], 'priority <= $6');
  assert.equal(result.clauses[6], 'created_at >= $7');
  assert.equal(result.clauses[7], 'created_at <= $8');
  assert.equal(result.clauses[8], 'parent_id = $9');
});
