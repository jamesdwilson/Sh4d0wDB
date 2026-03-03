/**
 * filter-clauses-metadata.test.mjs — TDD: metadata_filters in buildFilterClauses
 *
 * Written before implementation. All tests fail until buildFilterClauses
 * accepts and delegates metadata_filters to buildMetadataFilters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterClauses } from './dist/filters.js';

test('buildFilterClauses passes metadata_filters through as SQL clauses', () => {
  const result = buildFilterClauses({
    metadata_filters: [{ field: 'confidence', op: '>', value: 70 }],
  }, 1);
  assert.equal(result.clauses.length, 1);
  assert.ok(result.clauses[0].includes("metadata->>'confidence'"), `got: ${result.clauses[0]}`);
  assert.ok(result.clauses[0].includes('::numeric'));
  assert.ok(result.clauses[0].includes('> $1'));
  assert.equal(result.values[0], 70);
  assert.equal(result.nextIdx, 2);
});

test('buildFilterClauses combines regular filters + metadata_filters correctly', () => {
  const result = buildFilterClauses({
    category: 'graph',
    metadata_filters: [
      { field: 'confidence', op: '>=', value: 60 },
      { field: 'tier', op: '=', value: 'vip' },
    ],
  }, 1);
  // category=$1, confidence>=$2, tier=$3
  assert.equal(result.clauses.length, 3);
  assert.ok(result.clauses[0].includes('category = $1'));
  assert.ok(result.clauses[1].includes('$2'));
  assert.ok(result.clauses[2].includes('$3'));
  assert.equal(result.values[0], 'graph');
  assert.equal(result.values[1], 60);
  assert.equal(result.values[2], 'vip');
  assert.equal(result.nextIdx, 4);
});

test('buildFilterClauses ignores empty metadata_filters array', () => {
  const result = buildFilterClauses({ metadata_filters: [] }, 1);
  assert.deepEqual(result.clauses, []);
  assert.equal(result.nextIdx, 1);
});

test('buildFilterClauses throws for invalid metadata field name', () => {
  assert.throws(
    () => buildFilterClauses({ metadata_filters: [{ field: 'bad;field', op: '=', value: 'x' }] }, 1),
    /invalid.*field/i,
  );
});
