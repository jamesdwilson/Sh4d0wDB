/**
 * authority-sensitivity.test.mjs — TDD vision: authority sensitivity scoring
 *
 * v0.7.0: derive authority sensitivity from psych profile at query time.
 * From GRAPH_SPEC.md: ISTJ/ESTJ/Analyst → weight intro source heavily.
 * Tests written before implementation. All fail until authority-sensitivity.ts exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// import { computeAuthoritySensitivity } from './dist/authority-sensitivity.js';

test('computeAuthoritySensitivity returns high score for ISTJ', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity returns high score for ESTJ', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity returns high score for Analyst (Voss type)', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity returns low score for ENFP', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity returns low score for INFP', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity returns low score for Accommodator (Voss type)', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity returns medium for undefined MBTI', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity handles missing profile gracefully', () => {
  assert.ok(false, 'Not yet implemented');
});

test('computeAuthoritySensitivity combines MBTI + Voss type', () => {
  assert.ok(false, 'Not yet implemented');
});
