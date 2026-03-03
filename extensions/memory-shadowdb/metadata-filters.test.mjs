/**
 * metadata-filters.test.mjs — TDD tests for buildMetadataFilters()
 *
 * Written BEFORE implementation. All tests should fail until
 * metadata-filters.ts is implemented.
 *
 * Sprint 5: typed metadata comparisons
 * Goal: support metadata.confidence > 70, metadata.tier = 'vip', etc.
 * as parameterized SQL — no string interpolation on values.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadataFilters } from './dist/metadata-filters.js';

// ============================================================================
// Empty / no-op
// ============================================================================

test('buildMetadataFilters returns empty result for undefined', () => {
  const result = buildMetadataFilters(undefined, 1);
  assert.deepEqual(result.clauses, []);
  assert.deepEqual(result.values, []);
  assert.equal(result.nextIdx, 1);
});

test('buildMetadataFilters returns empty result for empty array', () => {
  const result = buildMetadataFilters([], 1);
  assert.deepEqual(result.clauses, []);
  assert.deepEqual(result.values, []);
  assert.equal(result.nextIdx, 1);
});

// ============================================================================
// Numeric comparisons
// ============================================================================

test('buildMetadataFilters handles > operator (numeric)', () => {
  const result = buildMetadataFilters([{ field: 'confidence', op: '>', value: 70 }], 1);
  assert.equal(result.clauses.length, 1);
  assert.ok(result.clauses[0].includes("metadata->>'confidence'"), `got: ${result.clauses[0]}`);
  assert.ok(result.clauses[0].includes('::numeric'), `missing cast: ${result.clauses[0]}`);
  assert.ok(result.clauses[0].includes('> $1'), `missing op: ${result.clauses[0]}`);
  assert.equal(result.values[0], 70);
  assert.equal(result.nextIdx, 2);
});

test('buildMetadataFilters handles >= operator', () => {
  const result = buildMetadataFilters([{ field: 'confidence', op: '>=', value: 50 }], 1);
  assert.ok(result.clauses[0].includes('>= $1'));
  assert.equal(result.values[0], 50);
});

test('buildMetadataFilters handles < operator', () => {
  const result = buildMetadataFilters([{ field: 'confidence', op: '<', value: 30 }], 1);
  assert.ok(result.clauses[0].includes('< $1'));
});

test('buildMetadataFilters handles <= operator', () => {
  const result = buildMetadataFilters([{ field: 'confidence', op: '<=', value: 90 }], 1);
  assert.ok(result.clauses[0].includes('<= $1'));
});

test('buildMetadataFilters handles != operator (numeric)', () => {
  const result = buildMetadataFilters([{ field: 'priority_score', op: '!=', value: 5 }], 1);
  assert.ok(result.clauses[0].includes('!= $1') || result.clauses[0].includes('<> $1'));
});

// ============================================================================
// String equality
// ============================================================================

test('buildMetadataFilters handles = operator (string)', () => {
  const result = buildMetadataFilters([{ field: 'tier', op: '=', value: 'vip' }], 1);
  assert.equal(result.clauses.length, 1);
  assert.ok(result.clauses[0].includes("metadata->>'tier'"), `got: ${result.clauses[0]}`);
  // String: no ::numeric cast
  assert.ok(!result.clauses[0].includes('::numeric'), `unexpected cast: ${result.clauses[0]}`);
  assert.ok(result.clauses[0].includes('= $1'));
  assert.equal(result.values[0], 'vip');
});

test('buildMetadataFilters handles != operator (string)', () => {
  const result = buildMetadataFilters([{ field: 'status', op: '!=', value: 'closed' }], 1);
  assert.ok(result.clauses[0].includes("metadata->>'status'"));
  assert.ok(result.clauses[0].includes('!= $1') || result.clauses[0].includes('<> $1'));
  assert.equal(result.values[0], 'closed');
});

// ============================================================================
// Multiple filters + index sequencing
// ============================================================================

test('buildMetadataFilters handles multiple filters with correct index sequencing', () => {
  const result = buildMetadataFilters([
    { field: 'confidence', op: '>=', value: 60 },
    { field: 'tier', op: '=', value: 'vip' },
  ], 3);
  assert.equal(result.clauses.length, 2);
  assert.ok(result.clauses[0].includes('$3'));
  assert.ok(result.clauses[1].includes('$4'));
  assert.equal(result.values[0], 60);
  assert.equal(result.values[1], 'vip');
  assert.equal(result.nextIdx, 5);
});

// ============================================================================
// Security: injection guard on field names
// ============================================================================

test('buildMetadataFilters throws for invalid field name (SQL injection attempt)', () => {
  assert.throws(
    () => buildMetadataFilters([{ field: "confidence'; DROP TABLE memories;--", op: '>', value: 0 }], 1),
    /invalid.*field/i,
  );
});

test('buildMetadataFilters throws for field name with spaces', () => {
  assert.throws(
    () => buildMetadataFilters([{ field: 'has space', op: '=', value: 'x' }], 1),
    /invalid.*field/i,
  );
});

test('buildMetadataFilters throws for invalid operator', () => {
  assert.throws(
    () => buildMetadataFilters([{ field: 'confidence', op: 'LIKE', value: 70 }], 1),
    /invalid.*op/i,
  );
});
