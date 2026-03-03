/**
 * truncate.test.mjs — Unit tests for truncateCleanly
 *
 * Tests smart truncation: section > paragraph > sentence > word > hard cut.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateCleanly } from './dist/store.js';

// ============================================================================
// No truncation needed
// ============================================================================

test('truncateCleanly returns text as-is when within limit', () => {
  const text = 'Short text.';
  assert.equal(truncateCleanly(text, 100), text);
});

test('truncateCleanly returns text as-is at exact limit', () => {
  const text = 'abc';
  assert.equal(truncateCleanly(text, 3), text);
});

test('truncateCleanly handles empty string', () => {
  assert.equal(truncateCleanly('', 100), '');
});

// ============================================================================
// Section boundary break (## heading within last 500 chars of maxChars)
// ============================================================================

test('truncateCleanly breaks at section boundary', () => {
  // Build text where \n## appears within last 500 chars of maxChars=100
  const prefix = 'First section content here. ';  // 28 chars
  const heading = '\n## Second Section';           // 18 chars
  const suffix = ' more content here that pushes past the limit...'.repeat(3); // ~150 chars
  const text = prefix + heading + suffix;

  const result = truncateCleanly(text, prefix.length + heading.length + 10);
  // Should break at the \n## boundary
  assert.ok(result.endsWith('First section content here.'), `got: ${result}`);
});

// ============================================================================
// Paragraph boundary break (\n\n within last 300 chars of maxChars)
// ============================================================================

test('truncateCleanly breaks at paragraph boundary', () => {
  const para1 = 'Paragraph one. ';            // 15 chars
  const para2 = '\n\nParagraph two content.'; // 23 chars
  const extra = ' Extra words.'.repeat(20);   // ~260 chars
  const text = para1 + para2 + extra;

  // maxChars = just past paragraph boundary to trigger para break
  const maxChars = para1.length + para2.length + 5;
  const result = truncateCleanly(text, maxChars);
  assert.ok(result.endsWith('Paragraph one.'), `got: "${result}"`);
});

// ============================================================================
// Sentence boundary break
// ============================================================================

test('truncateCleanly breaks at sentence boundary', () => {
  const sentence1 = 'First sentence. ';       // 16 chars
  const sentence2 = 'Second sentence. ';      // 17 chars
  const extra = 'More text.'.repeat(10);      // 100 chars
  const text = sentence1 + sentence2 + extra;

  // maxChars = just past second sentence boundary (within 200 chars)
  const maxChars = sentence1.length + sentence2.length + 5;
  const result = truncateCleanly(text, maxChars);
  assert.ok(result.includes('First sentence') || result.includes('Second sentence'),
    `got: "${result}"`);
});

// ============================================================================
// Word boundary break (space within last 100 chars of maxChars)
// ============================================================================

test('truncateCleanly breaks at word boundary', () => {
  // No sentence/para/section boundaries — just a long run of words
  const words = 'word '.repeat(40); // 200 chars
  const result = truncateCleanly(words, 50);
  // Should not end mid-word
  assert.ok(!result.endsWith('wor') && !result.endsWith('wo') && !result.endsWith('w'),
    `got mid-word cut: "${result}"`);
  assert.ok(result.trim().length > 0);
});

// ============================================================================
// Hard cut (no clean boundary found)
// ============================================================================

test('truncateCleanly hard-cuts when no boundary found', () => {
  // No spaces, newlines, or punctuation
  const text = 'a'.repeat(200);
  const result = truncateCleanly(text, 50);
  assert.equal(result.length, 50);
  assert.equal(result, 'a'.repeat(50));
});

// ============================================================================
// Result length bounds
// ============================================================================

test('truncateCleanly result is always <= maxChars', () => {
  const texts = [
    'word word word word word word\n\nmore words\n## heading more',
    'First sentence. Second sentence. Third.',
    'NoBreaksAtAllJustOneVeryLongContinuousString',
    'Short',
  ];
  for (const text of texts) {
    const result = truncateCleanly(text, 20);
    assert.ok(result.length <= 20,
      `truncateCleanly("${text}", 20) returned length ${result.length}: "${result}"`);
  }
});
