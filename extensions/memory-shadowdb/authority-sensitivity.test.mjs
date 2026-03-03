/**
 * authority-sensitivity.test.mjs — Unit tests for authority sensitivity scoring
 *
 * v0.7.0: derive authority sensitivity from psych profile at query time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAuthoritySensitivity } from './dist/authority-sensitivity.js';

test('computeAuthoritySensitivity returns high score for ISTJ', () => {
  const score = computeAuthoritySensitivity({ mbti: 'ISTJ' });
  assert.ok(score >= 70, `expected >=70, got ${score}`);
});

test('computeAuthoritySensitivity returns high score for ESTJ', () => {
  const score = computeAuthoritySensitivity({ mbti: 'ESTJ' });
  assert.ok(score >= 70, `expected >=70, got ${score}`);
});

test('computeAuthoritySensitivity returns high score for Analyst (Voss type)', () => {
  const score = computeAuthoritySensitivity({ voss_type: 'Analyst' });
  assert.ok(score >= 65, `expected >=65, got ${score}`);
});

test('computeAuthoritySensitivity returns low score for ENFP', () => {
  const score = computeAuthoritySensitivity({ mbti: 'ENFP' });
  assert.ok(score <= 35, `expected <=35, got ${score}`);
});

test('computeAuthoritySensitivity returns low score for INFP', () => {
  const score = computeAuthoritySensitivity({ mbti: 'INFP' });
  assert.ok(score <= 35, `expected <=35, got ${score}`);
});

test('computeAuthoritySensitivity returns low score for Accommodator (Voss type)', () => {
  const score = computeAuthoritySensitivity({ voss_type: 'Accommodator' });
  assert.ok(score <= 40, `expected <=40, got ${score}`);
});

test('computeAuthoritySensitivity returns medium for undefined MBTI', () => {
  const score = computeAuthoritySensitivity({ mbti: undefined });
  assert.ok(score >= 40 && score <= 60, `expected 40-60, got ${score}`);
});

test('computeAuthoritySensitivity handles missing profile gracefully', () => {
  const score = computeAuthoritySensitivity(null);
  assert.equal(score, 50);
});

test('computeAuthoritySensitivity combines MBTI + Voss type', () => {
  // ISTJ + Analyst = highest sensitivity
  const combined = computeAuthoritySensitivity({ mbti: 'ISTJ', voss_type: 'Analyst' });
  const mbtiOnly = computeAuthoritySensitivity({ mbti: 'ISTJ' });
  assert.ok(combined > mbtiOnly, `combined ${combined} should be > mbti only ${mbtiOnly}`);
});
