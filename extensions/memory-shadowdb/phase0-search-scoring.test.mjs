/**
 * phase0-search-scoring.test.mjs — Unit tests for Phase 0 scoring
 * integrated into the search pipeline.
 *
 * Tests the applySearchScoring() function which:
 *   1. Reads relevance_tier, confidence, is_timeless from each RankedHit
 *   2. Computes confidenceWeight via computeRecordConfidence()
 *   3. Computes tierWeight from TIER_WEIGHTS
 *   4. Applies computeFinalScore() to produce final ranked order
 *
 * These are pure unit tests — no DB, no network.
 * Run with: node --test phase0-search-scoring.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applySearchScoring } from './dist/phase0-search-scoring.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a ScoredRankedHit — a RankedHit extended with confidence/tier fields
 * and an optional rerankScore (from reranker).
 */
function hit({
  id = 1,
  content = 'test content',
  rrfScore = 0.5,
  rerankScore = null,
  relevanceTier = 1,
  confidence = 1.0,
  confidenceDecayRate = 0.0,
  isTimeless = false,
  createdAt = new Date(),
} = {}) {
  return {
    id,
    content,
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
  };
}

// ============================================================================
// applySearchScoring — basic operation
// ============================================================================

test('applySearchScoring returns same count of hits as input', () => {
  const hits = [hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3 })];
  const result = applySearchScoring(hits);
  assert.equal(result.length, 3);
});

test('applySearchScoring returns hits with finalScore field', () => {
  const hits = [hit({ id: 1 })];
  const result = applySearchScoring(hits);
  assert.ok(typeof result[0].finalScore === 'number', 'should have finalScore');
  assert.ok(result[0].finalScore >= 0 && result[0].finalScore <= 1, 'finalScore in [0,1]');
});

test('applySearchScoring sorts results by finalScore descending', () => {
  const hits = [
    hit({ id: 1, rrfScore: 0.3, relevanceTier: 4, confidence: 0.5 }), // low score
    hit({ id: 2, rrfScore: 0.9, relevanceTier: 1, confidence: 1.0 }), // high score
    hit({ id: 3, rrfScore: 0.6, relevanceTier: 2, confidence: 0.8 }), // mid score
  ];
  const result = applySearchScoring(hits);
  assert.equal(result[0].id, 2, 'highest scoring hit should be first');
  assert.equal(result[2].id, 1, 'lowest scoring hit should be last');
});

test('applySearchScoring returns empty array for empty input', () => {
  assert.deepEqual(applySearchScoring([]), []);
});

// ============================================================================
// Tier weighting
// ============================================================================

test('applySearchScoring applies tier 1 weight (1.00) for fresh records', () => {
  const h = hit({ id: 1, rrfScore: 1.0, relevanceTier: 1, confidence: 1.0 });
  const result = applySearchScoring([h]);
  // finalScore = rrfScore * 1.0 (no rerank) * 1.0 (confidence) * 1.0 (tier 1)
  assert.ok(Math.abs(result[0].finalScore - 1.0) < 0.01);
});

test('applySearchScoring applies tier 2 weight (0.70) for 10-30 day records', () => {
  const h = hit({ id: 1, rrfScore: 1.0, relevanceTier: 2, confidence: 1.0 });
  const result = applySearchScoring([h]);
  assert.ok(Math.abs(result[0].finalScore - 0.70) < 0.01, `expected ~0.70, got ${result[0].finalScore}`);
});

test('applySearchScoring applies tier 3 weight (0.40) for 30-90 day records', () => {
  const h = hit({ id: 1, rrfScore: 1.0, relevanceTier: 3, confidence: 1.0 });
  const result = applySearchScoring([h]);
  assert.ok(Math.abs(result[0].finalScore - 0.40) < 0.01, `expected ~0.40, got ${result[0].finalScore}`);
});

test('applySearchScoring applies tier 4 weight (0.15) for 90-365 day records', () => {
  const h = hit({ id: 1, rrfScore: 1.0, relevanceTier: 4, confidence: 1.0 });
  const result = applySearchScoring([h]);
  assert.ok(Math.abs(result[0].finalScore - 0.15) < 0.01, `expected ~0.15, got ${result[0].finalScore}`);
});

test('applySearchScoring gives timeless records full weight regardless of tier', () => {
  const aged = hit({ id: 1, rrfScore: 1.0, relevanceTier: 4, confidence: 0.1, isTimeless: true });
  const result = applySearchScoring([aged]);
  // isTimeless=true: tierWeight=1.0, confidenceWeight=1.0
  assert.ok(Math.abs(result[0].finalScore - 1.0) < 0.01,
    `timeless record should score 1.0, got ${result[0].finalScore}`);
});

// ============================================================================
// Confidence weighting
// ============================================================================

test('applySearchScoring reduces score for low-confidence records', () => {
  const fresh = hit({ id: 1, rrfScore: 1.0, relevanceTier: 1, confidence: 1.0 });
  const stale = hit({ id: 2, rrfScore: 1.0, relevanceTier: 1, confidence: 0.3, confidenceDecayRate: 0.007702 });
  const result = applySearchScoring([fresh, stale]);
  assert.ok(result[0].id === 1, 'fresh record should outscore stale with same rrfScore');
  assert.ok(result[0].finalScore > result[1].finalScore);
});

test('applySearchScoring uses current time for decay — fully decayed record scores lower', () => {
  // 365-day-old record with fast decay rate
  const old = new Date();
  old.setFullYear(old.getFullYear() - 1);
  const h = hit({ id: 1, rrfScore: 1.0, relevanceTier: 4, confidence: 1.0, confidenceDecayRate: 0.007702, createdAt: old });
  const result = applySearchScoring([h]);
  // After 365 days at 0.007702: e^(-0.007702*365) ≈ 0.059 confidence
  // tier 4 weight: 0.15
  // finalScore ≈ 1.0 * 0.059 * 0.15 ≈ 0.009
  assert.ok(result[0].finalScore < 0.05, `old record should score low, got ${result[0].finalScore}`);
});

// ============================================================================
// Rerank score integration
// ============================================================================

test('applySearchScoring multiplies rerankScore into final score when present', () => {
  const h = hit({ id: 1, rrfScore: 1.0, rerankScore: 0.5, relevanceTier: 1, confidence: 1.0 });
  const result = applySearchScoring([h]);
  // finalScore = rrfScore * rerankScore * confidence * tier = 1.0 * 0.5 * 1.0 * 1.0 = 0.5
  assert.ok(Math.abs(result[0].finalScore - 0.5) < 0.01, `expected 0.5, got ${result[0].finalScore}`);
});

test('applySearchScoring uses rrfScore only when rerankScore is null', () => {
  const h = hit({ id: 1, rrfScore: 0.8, rerankScore: null, relevanceTier: 1, confidence: 1.0 });
  const result = applySearchScoring([h]);
  assert.ok(Math.abs(result[0].finalScore - 0.8) < 0.01, `expected 0.8, got ${result[0].finalScore}`);
});

test('applySearchScoring reranker can flip ordering from rrfScore order', () => {
  const hits = [
    hit({ id: 1, rrfScore: 0.9, rerankScore: 0.1, relevanceTier: 1, confidence: 1.0 }), // high RRF, low rerank
    hit({ id: 2, rrfScore: 0.5, rerankScore: 0.99, relevanceTier: 1, confidence: 1.0 }), // low RRF, high rerank
  ];
  const result = applySearchScoring(hits);
  // id=2 should win: 0.5 * 0.99 = 0.495 > id=1: 0.9 * 0.1 = 0.09
  assert.equal(result[0].id, 2, 'high-rerank record should outscore high-rrf record');
});

// ============================================================================
// Null/missing tier handling
// ============================================================================

test('applySearchScoring handles null relevanceTier (archived) as tier 4 weight for non-timeless', () => {
  const h = hit({ id: 1, rrfScore: 1.0, relevanceTier: null, confidence: 1.0, isTimeless: false });
  const result = applySearchScoring([h]);
  // null tier = archived, apply minimum weight (0.15) same as tier 4
  assert.ok(result[0].finalScore <= 0.20, `archived record should score very low, got ${result[0].finalScore}`);
});
