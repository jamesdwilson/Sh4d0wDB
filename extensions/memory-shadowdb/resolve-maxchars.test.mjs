/**
 * resolve-maxchars.test.mjs — Unit tests for resolveMaxCharsForModel
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from './dist/index.js';

const { resolveMaxCharsForModel } = __test__;

const cfg = {
  maxChars: 4000,
  maxCharsByModel: {
    'ministral': 1200,
    'qwen': 1500,
    'opus': 8000,
  },
};

test('resolveMaxCharsForModel returns default when no model provided', () => {
  assert.equal(resolveMaxCharsForModel(cfg, undefined), 4000);
  assert.equal(resolveMaxCharsForModel(cfg, ''), 4000);
});

test('resolveMaxCharsForModel returns default when maxCharsByModel is empty', () => {
  assert.equal(resolveMaxCharsForModel({ maxChars: 4000, maxCharsByModel: {} }, 'opus'), 4000);
});

test('resolveMaxCharsForModel matches pattern as substring', () => {
  assert.equal(resolveMaxCharsForModel(cfg, 'ministral-8b'), 1200);
  assert.equal(resolveMaxCharsForModel(cfg, 'qwen3-32b'), 1500);
  assert.equal(resolveMaxCharsForModel(cfg, 'claude-opus-4'), 8000);
});

test('resolveMaxCharsForModel matching is case-insensitive', () => {
  assert.equal(resolveMaxCharsForModel(cfg, 'MINISTRAL-8B'), 1200);
  assert.equal(resolveMaxCharsForModel(cfg, 'Qwen3'), 1500);
});

test('resolveMaxCharsForModel returns default when no pattern matches', () => {
  assert.equal(resolveMaxCharsForModel(cfg, 'gemini-flash'), 4000);
});

test('resolveMaxCharsForModel first match wins', () => {
  const ambiguous = {
    maxChars: 4000,
    maxCharsByModel: { 'claude': 2000, 'claude-opus': 8000 },
  };
  // 'claude-opus-4' matches 'claude' first
  assert.equal(resolveMaxCharsForModel(ambiguous, 'claude-opus-4'), 2000);
});
