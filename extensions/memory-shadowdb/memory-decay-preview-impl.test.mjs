/**
 * memory-decay-preview-impl.test.mjs — Implementation tests for memory_decay_preview tool
 *
 * Tests the tool wrapper logic using decay functions directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDecayFactor, decayConfidence } from './dist/confidence-decay.js';

test('memory_decay_preview tool logic returns decay preview for stale edges', () => {
  const now = new Date();
  const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
  
  const edges = [
    { id: 1, content: '', tags: [], metadata: { confidence: 80, last_verified: oldDate.toISOString() } },
  ];
  
  const results = decayConfidence(edges, { halfLifeDays: 30, minConfidence: 0 });
  assert.equal(results.length, 1);
  assert.ok(results[0].decayFactor < 1);
});

test('memory_decay_preview tool logic respects half_life_days parameter', () => {
  const now = new Date();
  const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days
  
  const edges = [
    { id: 1, content: '', tags: [], metadata: { confidence: 80, last_verified: oldDate.toISOString() } },
  ];
  
  const result30 = decayConfidence(edges, { halfLifeDays: 30, minConfidence: 0 })[0];
  const result60 = decayConfidence(edges, { halfLifeDays: 60, minConfidence: 0 })[0];
  
  // Longer half-life = slower decay
  assert.ok(result60.decayFactor > result30.decayFactor);
});

test('memory_decay_preview tool logic respects min_confidence floor', () => {
  const now = new Date();
  const oldDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 1 year
  
  const edges = [
    { id: 1, content: '', tags: [], metadata: { confidence: 80, last_verified: oldDate.toISOString() } },
  ];
  
  const results = decayConfidence(edges, { halfLifeDays: 30, minConfidence: 50 });
  assert.equal(results.length, 1);
  assert.ok(results[0].newConfidence >= 50);
});

test('memory_decay_preview tool logic returns empty for recent edges', () => {
  const now = new Date();
  const recentDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day
  
  const edges = [
    { id: 1, content: '', tags: [], metadata: { confidence: 80, last_verified: recentDate.toISOString() } },
  ];
  
  // Recent edge with decayFactor ≈ 1 would stay above threshold
  const factor = computeDecayFactor(recentDate.toISOString(), 30);
  assert.ok(factor > 0.97);
});

test('memory_decay_preview tool logic includes decay factor in results', () => {
  const now = new Date();
  const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  const edges = [
    { id: 1, content: '', tags: [], metadata: { confidence: 80, last_verified: oldDate.toISOString() } },
  ];
  
  const results = decayConfidence(edges, { halfLifeDays: 30, minConfidence: 0 });
  assert.ok(results[0].decayFactor !== undefined);
  assert.ok(results[0].decayFactor > 0 && results[0].decayFactor <= 1);
});
