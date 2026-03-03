/**
 * embedding-fingerprint.test.mjs — Unit tests for computeEmbeddingFingerprint
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from './dist/index.js';

const { computeEmbeddingFingerprint } = __test__;

test('computeEmbeddingFingerprint returns 16-char hex string', () => {
  const result = computeEmbeddingFingerprint({ provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 });
  assert.equal(typeof result, 'string');
  assert.equal(result.length, 16);
  assert.match(result, /^[0-9a-f]{16}$/);
});

test('computeEmbeddingFingerprint is deterministic', () => {
  const cfg = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };
  assert.equal(computeEmbeddingFingerprint(cfg), computeEmbeddingFingerprint(cfg));
});

test('computeEmbeddingFingerprint differs when provider changes', () => {
  const a = computeEmbeddingFingerprint({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
  const b = computeEmbeddingFingerprint({ provider: 'voyage', model: 'text-embedding-3-small', dimensions: 1536 });
  assert.notEqual(a, b);
});

test('computeEmbeddingFingerprint differs when model changes', () => {
  const a = computeEmbeddingFingerprint({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
  const b = computeEmbeddingFingerprint({ provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536 });
  assert.notEqual(a, b);
});

test('computeEmbeddingFingerprint differs when dimensions change', () => {
  const a = computeEmbeddingFingerprint({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 512 });
  const b = computeEmbeddingFingerprint({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
  assert.notEqual(a, b);
});

test('computeEmbeddingFingerprint uses task-prefix for nomic models', () => {
  const nomic = computeEmbeddingFingerprint({ provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 });
  const other = computeEmbeddingFingerprint({ provider: 'ollama', model: 'mxbai-embed-large', dimensions: 768 });
  assert.notEqual(nomic, other);
});
