/**
 * tag-namespace.test.mjs — TDD: tag namespace validation
 *
 * Sprint v0.5.0: enforce tag prefixes on write.
 * Valid namespaces: entity:, domain:, loc:, sector:, status:, interest:
 *
 * Written before implementation. All tests fail until tag-validator.ts exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTags, VALID_NAMESPACES } from './dist/tag-validator.js';

// ============================================================================
// Constants
// ============================================================================

test('VALID_NAMESPACES includes all required prefixes', () => {
  assert.ok(VALID_NAMESPACES.has('entity'));
  assert.ok(VALID_NAMESPACES.has('domain'));
  assert.ok(VALID_NAMESPACES.has('loc'));
  assert.ok(VALID_NAMESPACES.has('sector'));
  assert.ok(VALID_NAMESPACES.has('status'));
  assert.ok(VALID_NAMESPACES.has('interest'));
});

// ============================================================================
// Valid tags
// ============================================================================

test('validateTags accepts valid entity tag', () => {
  const result = validateTags(['entity:james-wilson']);
  assert.equal(result.valid, true);
  assert.deepEqual(result.invalid, []);
});

test('validateTags accepts multiple valid tags from different namespaces', () => {
  const result = validateTags([
    'entity:james-wilson',
    'domain:civic',
    'loc:tyler-tx',
    'sector:broadband',
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.invalid, []);
});

test('validateTags accepts tag without namespace (allowed by default)', () => {
  // Tags without colons are allowed — not everything needs a namespace
  const result = validateTags(['some-random-tag']);
  assert.equal(result.valid, true);
});

// ============================================================================
// Invalid tags
// ============================================================================

test('validateTags rejects unknown namespace prefix', () => {
  const result = validateTags(['foo:bar']);
  assert.equal(result.valid, false);
  assert.equal(result.invalid.length, 1);
  assert.ok(result.invalid[0].tag === 'foo:bar');
  assert.ok(result.invalid[0].reason.includes('unknown namespace'));
});

test('validateTags reports all invalid tags', () => {
  const result = validateTags([
    'entity:valid',
    'bad:value',
    'unknown:tag',
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.invalid.length, 2);
});

test('validateTags rejects empty namespace (trailing colon)', () => {
  const result = validateTags(['entity:']);
  assert.equal(result.valid, false);
  assert.ok(result.invalid[0].reason.includes('empty'));
});

test('validateTags rejects whitespace in namespace', () => {
  const result = validateTags(['entity :james']);
  assert.equal(result.valid, false);
});

// ============================================================================
// Options
// ============================================================================

test('validateTags with strict=true rejects tag without namespace', () => {
  const result = validateTags(['plain-tag'], { strict: true });
  assert.equal(result.valid, false);
  assert.ok(result.invalid[0].reason.includes('no namespace prefix'));
});

test('validateTags with strict=false allows tag without namespace', () => {
  const result = validateTags(['plain-tag'], { strict: false });
  assert.equal(result.valid, true);
});

// ============================================================================
// Normalization
// ============================================================================

test('validateTags normalizes tag to lowercase', () => {
  const result = validateTags(['Entity:James-Wilson']);
  assert.equal(result.valid, true);
  // Note: normalization is applied before validation
});

test('validateTags trims whitespace from tag', () => {
  const result = validateTags(['  entity:james  ']);
  assert.equal(result.valid, true);
});
