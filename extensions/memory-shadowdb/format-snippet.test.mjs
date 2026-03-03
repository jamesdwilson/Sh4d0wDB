/**
 * format-snippet.test.mjs — Unit tests for formatSnippet
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// formatSnippet is a method on MemoryStore (abstract class).
// We access it via a minimal concrete subclass.
import { MemoryStore } from './dist/store.js';

class TestStore extends MemoryStore {
  constructor() {
    super(null, { vectorWeight: 1, textWeight: 1, recencyWeight: 0.1, autoEmbed: false, purgeAfterDays: 0, table: 'memories' }, { info: () => {}, warn: () => {} });
  }
  // Implement abstract methods as no-ops
  async vectorSearch() { return []; }
  async ftsSearch() { return []; }
  async fuzzySearch() { return []; }
  async insertRecord() { return { id: 1, path: 'shadowdb/test/1' }; }
  async updateRecord() {}
  async getRecord() { return null; }
  async listRecords() { return []; }
  async softDelete() {}
  async purgeExpired() { return 0; }
  async getPrimerRows() { return []; }
}

const store = new TestStore();

test('formatSnippet returns category|age header + content body', () => {
  const past = new Date(Date.now() - 2 * 3600 * 1000); // 2h ago
  const result = store.formatSnippet({
    id: 1,
    content: 'Some content here.',
    category: 'domain',
    created_at: past,
  });
  assert.ok(result.startsWith('domain|'), `missing header: ${result}`);
  assert.ok(result.includes('Some content here.'));
});

test('formatSnippet omits header when category and created_at are null', () => {
  const result = store.formatSnippet({
    id: 1,
    content: 'Bare content.',
    category: null,
    created_at: null,
  });
  assert.equal(result, 'Bare content.');
});

test('formatSnippet truncates content to ~700 chars', () => {
  const longContent = 'x'.repeat(800);
  const result = store.formatSnippet({ id: 1, content: longContent, category: null, created_at: null });
  assert.ok(result.length <= 700, `got ${result.length} chars`);
});
