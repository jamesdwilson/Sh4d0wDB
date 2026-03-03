/**
 * store.test.mjs — Unit tests for store.ts pure exports
 *
 * Tests: sanitizeString, sanitizeTags, formatRelativeAge, constants
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeString,
  sanitizeTags,
  formatRelativeAge,
  MAX_CONTENT_CHARS,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_CATEGORY_LENGTH,
  RRF_K,
} from './dist/store.js';

// ============================================================================
// Constants
// ============================================================================

test('constants have expected values', () => {
  assert.equal(MAX_CONTENT_CHARS, 100_000);
  assert.equal(MAX_TAGS, 50);
  assert.equal(MAX_TAG_LENGTH, 200);
  assert.equal(MAX_TITLE_LENGTH, 500);
  assert.equal(MAX_CATEGORY_LENGTH, 100);
  assert.equal(RRF_K, 60);
});

// ============================================================================
// sanitizeString
// ============================================================================

test('sanitizeString trims and truncates', () => {
  assert.equal(sanitizeString('  hello  ', 100), 'hello');
  assert.equal(sanitizeString('abcdef', 3), 'abc');
  assert.equal(sanitizeString('exact', 5), 'exact');
});

test('sanitizeString returns empty string for non-string input', () => {
  assert.equal(sanitizeString(null, 100), '');
  assert.equal(sanitizeString(undefined, 100), '');
  assert.equal(sanitizeString(42, 100), '');
  assert.equal(sanitizeString({}, 100), '');
  assert.equal(sanitizeString([], 100), '');
});

test('sanitizeString handles empty string', () => {
  assert.equal(sanitizeString('', 100), '');
  assert.equal(sanitizeString('   ', 100), '');
});

test('sanitizeString respects maxLength boundary exactly', () => {
  const s = 'a'.repeat(200);
  assert.equal(sanitizeString(s, 200).length, 200);
  assert.equal(sanitizeString(s, 100).length, 100);
  assert.equal(sanitizeString(s, 1).length, 1);
});

// ============================================================================
// sanitizeTags
// ============================================================================

test('sanitizeTags returns empty array for non-array input', () => {
  assert.deepEqual(sanitizeTags(null), []);
  assert.deepEqual(sanitizeTags(undefined), []);
  assert.deepEqual(sanitizeTags('tag'), []);
  assert.deepEqual(sanitizeTags(42), []);
  assert.deepEqual(sanitizeTags({}), []);
});

test('sanitizeTags returns empty array for empty input', () => {
  assert.deepEqual(sanitizeTags([]), []);
});

test('sanitizeTags trims whitespace from tags', () => {
  assert.deepEqual(sanitizeTags(['  hello  ', ' world ']), ['hello', 'world']);
});

test('sanitizeTags deduplicates tags', () => {
  assert.deepEqual(sanitizeTags(['foo', 'foo', 'bar']), ['foo', 'bar']);
  assert.deepEqual(sanitizeTags(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

test('sanitizeTags skips non-string elements', () => {
  assert.deepEqual(sanitizeTags(['foo', 42, null, 'bar', undefined, {}]), ['foo', 'bar']);
});

test('sanitizeTags skips empty/whitespace-only tags', () => {
  assert.deepEqual(sanitizeTags(['', '  ', 'valid']), ['valid']);
});

test('sanitizeTags truncates tags longer than MAX_TAG_LENGTH', () => {
  const longTag = 'x'.repeat(MAX_TAG_LENGTH + 50);
  const result = sanitizeTags([longTag]);
  assert.equal(result.length, 1);
  assert.equal(result[0].length, MAX_TAG_LENGTH);
});

test('sanitizeTags caps at MAX_TAGS', () => {
  const tags = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `tag-${i}`);
  const result = sanitizeTags(tags);
  assert.equal(result.length, MAX_TAGS);
});

test('sanitizeTags deduplication is case-sensitive', () => {
  // Tags are case-sensitive — 'Foo' and 'foo' are different
  assert.deepEqual(sanitizeTags(['foo', 'Foo', 'FOO']), ['foo', 'Foo', 'FOO']);
});

// ============================================================================
// formatRelativeAge
// ============================================================================

function msAgo(ms) {
  return new Date(Date.now() - ms);
}

test('formatRelativeAge returns minutes for <1h', () => {
  assert.equal(formatRelativeAge(msAgo(5 * 60_000)), '5m');
  assert.equal(formatRelativeAge(msAgo(59 * 60_000)), '59m');
});

test('formatRelativeAge clamps sub-minute to 1m', () => {
  assert.equal(formatRelativeAge(msAgo(10_000)), '1m');
  assert.equal(formatRelativeAge(msAgo(0)), '1m');
});

test('formatRelativeAge returns hours for 1h-23h', () => {
  assert.equal(formatRelativeAge(msAgo(2 * 3_600_000)), '2h');
  assert.equal(formatRelativeAge(msAgo(23 * 3_600_000)), '23h');
});

test('formatRelativeAge returns days for 1d-13d', () => {
  assert.equal(formatRelativeAge(msAgo(3 * 86_400_000)), '3d');
  assert.equal(formatRelativeAge(msAgo(13 * 86_400_000)), '13d');
});

test('formatRelativeAge returns weeks for 2w-8w', () => {
  assert.equal(formatRelativeAge(msAgo(14 * 86_400_000)), '2w');
  assert.equal(formatRelativeAge(msAgo(56 * 86_400_000)), '8w');
});

test('formatRelativeAge returns months for 2mo-11mo', () => {
  // weeks threshold is <9 — 9 weeks = 63 days → first month boundary
  assert.equal(formatRelativeAge(msAgo(63 * 86_400_000)), '2mo');  // floor(63/30)=2
  assert.equal(formatRelativeAge(msAgo(330 * 86_400_000)), '11mo'); // floor(330/30)=11
});

test('formatRelativeAge returns years for >=1y', () => {
  assert.equal(formatRelativeAge(msAgo(365 * 86_400_000)), '1y');
  assert.equal(formatRelativeAge(msAgo(2 * 365 * 86_400_000)), '2y');
});

test('formatRelativeAge accepts ISO string', () => {
  const ts = new Date(Date.now() - 2 * 3_600_000).toISOString();
  assert.equal(formatRelativeAge(ts), '2h');
});

test('formatRelativeAge returns empty string for invalid input', () => {
  assert.equal(formatRelativeAge('not-a-date'), '');
  assert.equal(formatRelativeAge(new Date('invalid')), '');
});

test('formatRelativeAge returns "now" for future timestamps', () => {
  const future = new Date(Date.now() + 60_000);
  assert.equal(formatRelativeAge(future), 'now');
});
