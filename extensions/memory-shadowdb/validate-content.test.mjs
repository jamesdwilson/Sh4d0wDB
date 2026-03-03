/**
 * validate-content.test.mjs — Unit tests for validateContent
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContent, MAX_CONTENT_CHARS } from './dist/store.js';

test('validateContent returns trimmed string for valid input', () => {
  assert.equal(validateContent('  hello world  '), 'hello world');
});

test('validateContent throws for empty string', () => {
  assert.throws(() => validateContent(''), /required/i);
});

test('validateContent throws for whitespace-only string', () => {
  assert.throws(() => validateContent('   '), /required/i);
});

test('validateContent throws for non-string input', () => {
  assert.throws(() => validateContent(null), /required/i);
  assert.throws(() => validateContent(undefined), /required/i);
  assert.throws(() => validateContent(42), /required/i);
});

test('validateContent throws when content exceeds MAX_CONTENT_CHARS', () => {
  const oversized = 'x'.repeat(MAX_CONTENT_CHARS + 1);
  assert.throws(() => validateContent(oversized), /maximum length/i);
});

test('validateContent accepts content at exactly MAX_CONTENT_CHARS', () => {
  const exact = 'x'.repeat(MAX_CONTENT_CHARS);
  assert.equal(validateContent(exact).length, MAX_CONTENT_CHARS);
});
