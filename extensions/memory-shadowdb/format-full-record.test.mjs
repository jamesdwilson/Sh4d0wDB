/**
 * format-full-record.test.mjs — Unit tests for formatFullRecord
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './dist/store.js';

class TestStore extends MemoryStore {
  constructor() {
    super(null, { vectorWeight: 1, textWeight: 1, recencyWeight: 0.1, autoEmbed: false, purgeAfterDays: 0, table: 'memories' }, { info: () => {}, warn: () => {} });
  }
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

test('formatFullRecord includes title, category, type, and content', () => {
  const result = store.formatFullRecord({
    id: 1,
    content: 'The full content.',
    category: 'domain',
    title: 'My Record',
    record_type: 'document',
  });
  assert.ok(result.includes('# My Record'));
  assert.ok(result.includes('Category: domain'));
  assert.ok(result.includes('Type: document'));
  assert.ok(result.includes('The full content.'));
});

test('formatFullRecord omits title/category/type when null', () => {
  const result = store.formatFullRecord({
    id: 1,
    content: 'Just content.',
    category: null,
    title: null,
    record_type: null,
  });
  assert.ok(!result.includes('Category:'));
  assert.ok(!result.includes('Type:'));
  assert.ok(!result.includes('#'));
  assert.ok(result.includes('Just content.'));
});

test('formatFullRecord does not truncate content', () => {
  const longContent = 'word '.repeat(300); // ~1500 chars
  const result = store.formatFullRecord({ id: 1, content: longContent, category: null, title: null, record_type: null });
  assert.ok(result.includes(longContent.trim()));
});
