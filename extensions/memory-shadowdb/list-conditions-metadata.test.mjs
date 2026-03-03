/**
 * list-conditions-metadata.test.mjs — TDD: metadata_filters in buildListConditions
 *
 * Written before implementation. All tests fail until buildListConditions
 * accepts metadata_filters and delegates to buildMetadataFilters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildListConditions } from './dist/list-filters.js';

test('buildListConditions passes metadata_filters through as SQL clauses', () => {
  const result = buildListConditions({
    metadata_filters: [{ field: 'affinity_score', op: '>=', value: 80 }],
  });
  // deleted_at IS NULL always first, then the metadata filter
  assert.equal(result.conditions[0], 'deleted_at IS NULL');
  assert.ok(result.conditions.some(c => c.includes("metadata->>'affinity_score'")), `got: ${JSON.stringify(result.conditions)}`);
  assert.ok(result.conditions.some(c => c.includes('::numeric')));
  assert.equal(result.values[0], 80);
});

test('buildListConditions combines regular filters + metadata_filters', () => {
  const result = buildListConditions({
    category: 'graph',
    priority_min: 7,
    metadata_filters: [{ field: 'confidence', op: '>', value: 50 }],
  });
  // deleted_at IS NULL + category + priority_min + metadata filter = 4 conditions
  assert.equal(result.conditions.length, 4);
  assert.ok(result.conditions.some(c => c.includes('category')));
  assert.ok(result.conditions.some(c => c.includes('priority >=')));
  assert.ok(result.conditions.some(c => c.includes("metadata->>'confidence'")));
});

test('buildListConditions ignores empty metadata_filters', () => {
  const withEmpty = buildListConditions({ metadata_filters: [] });
  const withNone = buildListConditions({});
  assert.equal(withEmpty.conditions.length, withNone.conditions.length);
});

test('buildListConditions throws for invalid metadata field in filter', () => {
  assert.throws(
    () => buildListConditions({ metadata_filters: [{ field: 'x; DROP TABLE memories', op: '=', value: 'x' }] }),
    /invalid.*field/i,
  );
});
