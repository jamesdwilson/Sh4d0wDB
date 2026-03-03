/**
 * confidence-decay.test.mjs — TDD: decay stale edge confidence
 *
 * v0.6.0: confidence decay — lower confidence on edges where
 * last_verified is older than a threshold.
 *
 * Written before implementation. All tests fail until confidence-decay.ts exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decayConfidence, computeDecayFactor } from './dist/confidence-decay.js';

// ============================================================================
// computeDecayFactor
// ============================================================================

test('computeDecayFactor returns ~1.0 for recent date', () => {
  const recent = new Date().toISOString();
  const factor = computeDecayFactor(recent, { halfLifeDays: 30 });
  assert.ok(factor > 0.99, `expected ~1.0, got ${factor}`);
});

test('computeDecayFactor returns <1 for stale date', () => {
  const stale = new Date(Date.now() - 60 * 86400 * 1000).toISOString(); // 60 days ago
  const factor = computeDecayFactor(stale, { halfLifeDays: 30 });
  assert.ok(factor < 1.0, `expected <1, got ${factor}`);
  assert.ok(factor > 0, `expected >0, got ${factor}`);
});

test('computeDecayFactor follows half-life curve', () => {
  // At halfLifeDays, factor should be ~0.5
  const halfLifeDate = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const factor = computeDecayFactor(halfLifeDate, { halfLifeDays: 30 });
  assert.ok(Math.abs(factor - 0.5) < 0.1, `expected ~0.5, got ${factor}`);
});

test('computeDecayFactor returns 0 for null/undefined date', () => {
  assert.equal(computeDecayFactor(null, { halfLifeDays: 30 }), 0);
  assert.equal(computeDecayFactor(undefined, { halfLifeDays: 30 }), 0);
});

test('computeDecayFactor clamps minimum to 0', () => {
  const veryStale = new Date(Date.now() - 365 * 86400 * 1000).toISOString(); // 1 year
  const factor = computeDecayFactor(veryStale, { halfLifeDays: 30, minFactor: 0 });
  assert.ok(factor >= 0, `expected >=0, got ${factor}`);
});

// ============================================================================
// decayConfidence
// ============================================================================

function edge(id, last_verified, confidence = 80) {
  return {
    id,
    content: 'test edge',
    tags: [],
    metadata: { last_verified, confidence },
  };
}

test('decayConfidence returns empty array for no edges', () => {
  const result = decayConfidence([], { halfLifeDays: 30 });
  assert.deepEqual(result, []);
});

test('decayConfidence skips edges without confidence', () => {
  const edges = [{ id: 1, content: '', tags: [], metadata: { last_verified: new Date().toISOString() } }];
  const result = decayConfidence(edges, { halfLifeDays: 30 });
  assert.deepEqual(result, []);
});

test('decayConfidence returns unchanged for recent edges', () => {
  // Use a date 1 hour ago — should have negligible decay
  const recent = new Date(Date.now() - 3600 * 1000).toISOString();
  const edges = [edge(1, recent, 80)];
  const result = decayConfidence(edges, { halfLifeDays: 30 });
  assert.equal(result.length, 0); // no appreciable decay
});

test('decayConfidence returns decayed value for stale edge', () => {
  const stale = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
  const edges = [edge(1, stale, 80)];
  const result = decayConfidence(edges, { halfLifeDays: 30 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.ok(result[0].newConfidence < 80, `expected <80, got ${result[0].newConfidence}`);
  assert.ok(result[0].newConfidence > 0, `expected >0, got ${result[0].newConfidence}`);
});

test('decayConfidence respects minConfidence floor', () => {
  const veryStale = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
  const edges = [edge(1, veryStale, 80)];
  const result = decayConfidence(edges, { halfLifeDays: 30, minConfidence: 10 });
  assert.ok(result[0].newConfidence >= 10, `expected >=10, got ${result[0].newConfidence}`);
});

test('decayConfidence rounds to integer', () => {
  const stale = new Date(Date.now() - 45 * 86400 * 1000).toISOString();
  const edges = [edge(1, stale, 80)];
  const result = decayConfidence(edges, { halfLifeDays: 30 });
  assert.equal(Number.isInteger(result[0].newConfidence), true);
});
