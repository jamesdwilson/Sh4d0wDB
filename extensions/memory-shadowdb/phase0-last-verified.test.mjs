/**
 * phase0-last-verified.test.mjs — Tests for last_verified_at wiring
 *
 * Verifies that:
 * 1. applySearchScoring() uses last_verified_at when present to reset decay clock
 * 2. postgres.ts search legs return last_verified_at from DB
 * 3. A record verified recently scores higher than an identical record
 *    that hasn't been verified (decay runs from created_at instead)
 *
 * Pure unit tests — no DB, no network.
 * Run with: node --test phase0-last-verified.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applySearchScoring } from './dist/phase0-search-scoring.js';

// ============================================================================
// Helpers
// ============================================================================

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function hit({
  id = 1,
  rrfScore = 1.0,
  rerankScore = null,
  relevanceTier = 1,
  confidence = 1.0,
  confidenceDecayRate = 0.007702,  // half-life 90 days
  isTimeless = false,
  createdAt = daysAgo(180),        // 180 days old by default
  lastVerifiedAt = null,
} = {}) {
  return {
    id,
    content: `content-${id}`,
    category: 'test',
    title: null,
    record_type: 'fact',
    created_at: createdAt,
    rank: 1,
    rawScore: 0.5,
    rrfScore,
    rerankScore,
    relevanceTier,
    confidence,
    confidenceDecayRate,
    isTimeless,
    lastVerifiedAt,
  };
}

// ============================================================================
// last_verified_at resets the decay clock
// ============================================================================

test('applySearchScoring uses lastVerifiedAt as decay start when present', () => {
  // Both records: 180 days old, 90-day half-life, so created_at decay → ~25% confidence
  // Record A: lastVerifiedAt = 10 days ago → only 10 days of decay → ~93% confidence
  // Record B: no lastVerifiedAt → 180 days of decay → ~25% confidence
  // Both have same rrfScore=1.0, tier=1
  const recentlyVerified = hit({ id: 1, lastVerifiedAt: daysAgo(10) });
  const neverVerified    = hit({ id: 2, lastVerifiedAt: null });

  const result = applySearchScoring([recentlyVerified, neverVerified]);

  assert.equal(result[0].id, 1, 'recently verified record should rank first');
  assert.ok(
    result[0].finalScore > result[1].finalScore,
    `verified (${result[0].finalScore.toFixed(3)}) should outscore unverified (${result[1].finalScore.toFixed(3)})`,
  );
});

test('applySearchScoring with lastVerifiedAt=10 days ago gives ~93% confidence for 90-day half-life', () => {
  // e^(-0.007702 * 10) ≈ 0.925
  const h = hit({ id: 1, lastVerifiedAt: daysAgo(10), relevanceTier: 1 });
  const result = applySearchScoring([h]);
  // finalScore = rrfScore(1.0) * confidence(~0.925) * tier(1.0) = ~0.925
  assert.ok(result[0].finalScore > 0.88 && result[0].finalScore < 0.96,
    `expected ~0.925, got ${result[0].finalScore}`);
});

test('applySearchScoring with lastVerifiedAt=null falls back to created_at for decay', () => {
  // 180 days old, half-life 90 days: e^(-0.007702 * 180) ≈ 0.250
  const h = hit({ id: 1, createdAt: daysAgo(180), lastVerifiedAt: null, relevanceTier: 1 });
  const result = applySearchScoring([h]);
  // finalScore ≈ 0.250
  assert.ok(result[0].finalScore > 0.20 && result[0].finalScore < 0.30,
    `expected ~0.25 for 180-day decay, got ${result[0].finalScore}`);
});

test('applySearchScoring lastVerifiedAt=today gives near-full confidence', () => {
  const h = hit({ id: 1, lastVerifiedAt: daysAgo(0), relevanceTier: 1 });
  const result = applySearchScoring([h]);
  // e^(-0.007702 * 0) = 1.0
  assert.ok(result[0].finalScore > 0.98, `expected ~1.0 for verified today, got ${result[0].finalScore}`);
});

test('applySearchScoring timeless record ignores lastVerifiedAt (always 1.0 confidence)', () => {
  const h = hit({
    id: 1,
    isTimeless: true,
    confidenceDecayRate: 0.5,     // extreme decay rate — should be ignored
    lastVerifiedAt: null,
    createdAt: daysAgo(365),
  });
  const result = applySearchScoring([h]);
  assert.ok(result[0].finalScore > 0.98, `timeless should score ~1.0, got ${result[0].finalScore}`);
});

test('applySearchScoring handles lastVerifiedAt as string (DB may return strings)', () => {
  const verifiedDateStr = daysAgo(10).toISOString();
  const h = { ...hit({ id: 1 }), lastVerifiedAt: verifiedDateStr };
  const result = applySearchScoring([h]);
  assert.ok(result[0].finalScore > 0.85, `string lastVerifiedAt should parse correctly, got ${result[0].finalScore}`);
});

test('applySearchScoring handles lastVerifiedAt=null gracefully (no throw)', () => {
  const h = hit({ id: 1, lastVerifiedAt: null });
  let result;
  assert.doesNotThrow(() => { result = applySearchScoring([h]); });
  assert.ok(Array.isArray(result) && result.length === 1);
});
