/**
 * phase0-scoring.test.mjs — TDD tests for Phase 0 scoring functions
 *
 * Tests: computeRecordConfidence, assignRelevanceTier, computeFinalScore,
 *        resolveDecayProfile, filterByTier
 *
 * All functions are pure (no DB, no network) — fast unit tests only.
 * Run with: node --test phase0-scoring.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRecordConfidence,
  assignRelevanceTier,
  computeFinalScore,
  resolveDecayProfile,
  filterByTier,
  TIER_WEIGHTS,
  DECAY_PROFILES,
} from './dist/phase0-scoring.js';

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal record for computeRecordConfidence */
function record({
  confidence = 1.0,
  confidenceDecayRate = 0.0,
  lastVerifiedAt = null,
  isTimeless = false,
  createdAt = new Date('2026-01-01T00:00:00Z'),
} = {}) {
  return { confidence, confidenceDecayRate, lastVerifiedAt, isTimeless, createdAt };
}

/** Build a minimal ScoredResult component set */
function components({
  memoryId = 1,
  vectorScore = 0.9,
  rerankScore = 0.8,
  confidenceWeight = 1.0,
  tierWeight = 1.0,
  isTimeless = false,
} = {}) {
  return { memoryId, vectorScore, rerankScore, confidenceWeight, tierWeight, isTimeless };
}

/** Days ago as a Date */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ============================================================================
// computeRecordConfidence
// ============================================================================

test('computeRecordConfidence returns initial confidence for timeless record regardless of age', () => {
  const r = record({ confidence: 0.95, confidenceDecayRate: 0.1, isTimeless: true, createdAt: daysAgo(365) });
  const result = computeRecordConfidence(r);
  assert.ok(Math.abs(result - 0.95) < 0.001, `expected 0.95, got ${result}`);
});

test('computeRecordConfidence returns 1.0 for fresh record with zero decay rate', () => {
  const r = record({ confidence: 1.0, confidenceDecayRate: 0.0 });
  assert.equal(computeRecordConfidence(r), 1.0);
});

test('computeRecordConfidence decays correctly using exponential formula', () => {
  // Half-life 90 days: decay_rate = ln(2)/90 ≈ 0.007702
  // After 90 days: confidence should be ~0.5
  const r = record({ confidence: 1.0, confidenceDecayRate: 0.007702, createdAt: daysAgo(90) });
  const result = computeRecordConfidence(r);
  assert.ok(result > 0.48 && result < 0.52, `expected ~0.5 after 90 days, got ${result}`);
});

test('computeRecordConfidence uses last_verified_at as decay start when present', () => {
  // Verified 10 days ago — should only decay 10 days, not from createdAt
  const r = record({
    confidence: 1.0,
    confidenceDecayRate: 0.007702,
    createdAt: daysAgo(365),
    lastVerifiedAt: daysAgo(10),
  });
  const result = computeRecordConfidence(r);
  // After 10 days at rate 0.007702: e^(-0.007702*10) ≈ 0.925
  assert.ok(result > 0.90 && result < 0.95, `expected ~0.925 for 10-day decay, got ${result}`);
});

test('computeRecordConfidence accepts asOf parameter for deterministic testing', () => {
  const asOf = new Date('2026-06-01T00:00:00Z');
  const createdAt = new Date('2026-03-01T00:00:00Z'); // 92 days before asOf
  const r = record({ confidence: 1.0, confidenceDecayRate: 0.007702, createdAt });
  const result = computeRecordConfidence(r, asOf);
  // 92 days: e^(-0.007702*92) ≈ 0.494
  assert.ok(result > 0.46 && result < 0.53, `expected ~0.494 at 92 days, got ${result}`);
});

test('computeRecordConfidence never returns below 0', () => {
  const r = record({ confidence: 1.0, confidenceDecayRate: 10.0, createdAt: daysAgo(1000) });
  const result = computeRecordConfidence(r);
  assert.ok(result >= 0, `confidence should not go below 0, got ${result}`);
});

test('computeRecordConfidence never returns above initial confidence', () => {
  const r = record({ confidence: 0.7, confidenceDecayRate: 0.001 });
  const result = computeRecordConfidence(r);
  assert.ok(result <= 0.7, `confidence should not exceed initial value, got ${result}`);
});

// ============================================================================
// assignRelevanceTier
// ============================================================================

test('assignRelevanceTier returns 1 for documents within 10 days', () => {
  assert.equal(assignRelevanceTier(daysAgo(5)), 1);
  assert.equal(assignRelevanceTier(daysAgo(0)), 1);
  assert.equal(assignRelevanceTier(daysAgo(9)), 1);
});

test('assignRelevanceTier returns 2 for documents 10–30 days old', () => {
  assert.equal(assignRelevanceTier(daysAgo(10)), 2);
  assert.equal(assignRelevanceTier(daysAgo(20)), 2);
  assert.equal(assignRelevanceTier(daysAgo(29)), 2);
});

test('assignRelevanceTier returns 3 for documents 30–90 days old', () => {
  assert.equal(assignRelevanceTier(daysAgo(30)), 3);
  assert.equal(assignRelevanceTier(daysAgo(60)), 3);
  assert.equal(assignRelevanceTier(daysAgo(89)), 3);
});

test('assignRelevanceTier returns 4 for documents 90–365 days old', () => {
  assert.equal(assignRelevanceTier(daysAgo(90)), 4);
  assert.equal(assignRelevanceTier(daysAgo(200)), 4);
  assert.equal(assignRelevanceTier(daysAgo(364)), 4);
});

test('assignRelevanceTier returns null for documents older than 365 days (archive)', () => {
  assert.equal(assignRelevanceTier(daysAgo(365)), null);
  assert.equal(assignRelevanceTier(daysAgo(500)), null);
});

test('assignRelevanceTier accepts asOf parameter for deterministic testing', () => {
  const asOf = new Date('2026-06-01T00:00:00Z');
  const fiveDaysBeforeAsOf = new Date('2026-05-27T00:00:00Z');
  assert.equal(assignRelevanceTier(fiveDaysBeforeAsOf, asOf), 1);
});

// ============================================================================
// TIER_WEIGHTS — verify the constants are correct
// ============================================================================

test('TIER_WEIGHTS has correct values for all tiers', () => {
  assert.equal(TIER_WEIGHTS[1], 1.00);
  assert.equal(TIER_WEIGHTS[2], 0.70);
  assert.equal(TIER_WEIGHTS[3], 0.40);
  assert.equal(TIER_WEIGHTS[4], 0.15);
});

// ============================================================================
// computeFinalScore
// ============================================================================

test('computeFinalScore multiplies all components correctly', () => {
  const result = computeFinalScore(components({
    vectorScore: 0.8,
    rerankScore: 0.9,
    confidenceWeight: 0.7,
    tierWeight: 0.5,
  }));
  // 0.8 * 0.9 * 0.7 * 0.5 = 0.252
  assert.ok(Math.abs(result.finalScore - 0.252) < 0.001, `expected 0.252, got ${result.finalScore}`);
});

test('computeFinalScore uses vectorScore only when rerankScore is null', () => {
  const result = computeFinalScore(components({
    vectorScore: 0.8,
    rerankScore: null,
    confidenceWeight: 1.0,
    tierWeight: 1.0,
  }));
  assert.ok(Math.abs(result.finalScore - 0.8) < 0.001, `expected 0.8, got ${result.finalScore}`);
});

test('computeFinalScore sets confidenceWeight=1 and tierWeight=1 for timeless records', () => {
  const result = computeFinalScore(components({
    vectorScore: 0.6,
    rerankScore: 0.7,
    confidenceWeight: 0.2,  // would suppress a non-timeless record
    tierWeight: 0.15,        // would suppress a non-timeless record
    isTimeless: true,
  }));
  // timeless: finalScore = vectorScore * rerankScore * 1.0 * 1.0
  assert.ok(Math.abs(result.finalScore - 0.42) < 0.001, `expected 0.42 for timeless, got ${result.finalScore}`);
});

test('computeFinalScore returns ScoredResult with all input fields preserved', () => {
  const c = components({ memoryId: 42, vectorScore: 0.9, rerankScore: 0.8 });
  const result = computeFinalScore(c);
  assert.equal(result.memoryId, 42);
  assert.equal(result.vectorScore, 0.9);
  assert.equal(result.rerankScore, 0.8);
  assert.ok(typeof result.finalScore === 'number');
});

test('computeFinalScore finalScore is in [0, 1]', () => {
  const result = computeFinalScore(components({
    vectorScore: 1.0, rerankScore: 1.0, confidenceWeight: 1.0, tierWeight: 1.0,
  }));
  assert.ok(result.finalScore >= 0 && result.finalScore <= 1);
});

// ============================================================================
// resolveDecayProfile
// ============================================================================

test('resolveDecayProfile returns timeless=true for rule record_type', () => {
  const p = resolveDecayProfile('rule', null);
  assert.equal(p.isTimeless, true);
  assert.equal(p.halfLifeDays, 0);
});

test('resolveDecayProfile returns timeless=true for directive and playbook', () => {
  assert.equal(resolveDecayProfile('directive', null).isTimeless, true);
  assert.equal(resolveDecayProfile('playbook', null).isTimeless, true);
});

test('resolveDecayProfile returns 180-day half-life for contact record_type', () => {
  const p = resolveDecayProfile('contact', null);
  assert.equal(p.isTimeless, false);
  assert.equal(p.halfLifeDays, 180);
});

test('resolveDecayProfile returns 180-day half-life for dossier and person', () => {
  assert.equal(resolveDecayProfile('dossier', null).halfLifeDays, 180);
  assert.equal(resolveDecayProfile('person', null).halfLifeDays, 180);
});

test('resolveDecayProfile returns 90-day half-life for fact and section', () => {
  assert.equal(resolveDecayProfile('fact', null).halfLifeDays, 90);
  assert.equal(resolveDecayProfile('section', null).halfLifeDays, 90);
});

test('resolveDecayProfile returns 30-day half-life for document and chunk', () => {
  assert.equal(resolveDecayProfile('document', null).halfLifeDays, 30);
  assert.equal(resolveDecayProfile('chunk', null).halfLifeDays, 30);
});

test('resolveDecayProfile falls back to fact profile for unknown record_type', () => {
  const p = resolveDecayProfile('unknown_type', null);
  assert.equal(p.halfLifeDays, 90);
  assert.equal(p.isTimeless, false);
});

test('resolveDecayProfile returns timeless for rules category regardless of record_type', () => {
  const p = resolveDecayProfile('atom', 'rules');
  assert.equal(p.isTimeless, true);
});

test('resolveDecayProfile returns timeless for system and config categories', () => {
  assert.equal(resolveDecayProfile('fact', 'system').isTimeless, true);
  assert.equal(resolveDecayProfile('fact', 'config').isTimeless, true);
  assert.equal(resolveDecayProfile('fact', 'skills').isTimeless, true);
});

// ============================================================================
// filterByTier
// ============================================================================

function makeRecord(id, relevanceTier, isTimeless = false) {
  return { id, relevanceTier, isTimeless, content: `content-${id}`, category: 'test',
           title: null, record_type: 'fact', created_at: new Date(), rank: id, rrfScore: 0.5 };
}

test('filterByTier includes tier 1, 2, 3, 4 records by default', () => {
  const records = [
    makeRecord(1, 1), makeRecord(2, 2), makeRecord(3, 3), makeRecord(4, 4),
  ];
  const result = filterByTier(records);
  assert.equal(result.length, 4);
});

test('filterByTier excludes null-tier (archived) records by default', () => {
  const records = [
    makeRecord(1, 1), makeRecord(2, null), makeRecord(3, 3),
  ];
  const result = filterByTier(records);
  assert.equal(result.length, 2);
  assert.ok(!result.find(r => r.id === 2), 'archived record should be excluded');
});

test('filterByTier includes archived records when includeArchived=true', () => {
  const records = [makeRecord(1, null), makeRecord(2, 1)];
  const result = filterByTier(records, true);
  assert.equal(result.length, 2);
});

test('filterByTier always includes timeless records regardless of tier', () => {
  const records = [
    makeRecord(1, null, true),   // archived but timeless — must include
    makeRecord(2, 4, true),      // tier 4 but timeless — must include
    makeRecord(3, null, false),  // archived, not timeless — must exclude
  ];
  const result = filterByTier(records);
  assert.equal(result.length, 2);
  assert.ok(result.find(r => r.id === 1), 'timeless archived record must be included');
  assert.ok(result.find(r => r.id === 2), 'timeless tier-4 record must be included');
  assert.ok(!result.find(r => r.id === 3), 'non-timeless archived record must be excluded');
});

test('filterByTier returns empty array for empty input', () => {
  assert.deepEqual(filterByTier([]), []);
});

test('filterByTier preserves order of input records', () => {
  const records = [makeRecord(3, 2), makeRecord(1, 1), makeRecord(2, 3)];
  const result = filterByTier(records);
  assert.deepEqual(result.map(r => r.id), [3, 1, 2]);
});
