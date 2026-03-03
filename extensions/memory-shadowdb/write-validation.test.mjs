/**
 * write-validation.test.mjs — Unit tests for write() input sanitization
 *
 * Verifies priority clamping, category defaulting, parent_id handling,
 * and path format — without hitting a real database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './dist/store.js';

function makeStore() {
  let lastInsert = null;
  let nextId = 42;

  class TestStore extends MemoryStore {
    constructor() {
      super(null, { vectorWeight: 1, textWeight: 1, recencyWeight: 0.1, autoEmbed: false, purgeAfterDays: 0, table: 'memories' }, { info: () => {}, warn: () => {} });
    }
    async insertRecord(params) {
      lastInsert = params;
      return nextId;
    }
    async getPrimerRows() { return []; }
    async vectorSearch() { return []; }
    async ftsSearch() { return []; }
    async fuzzySearch() { return []; }
    async updateRecord() {}
    async getRecord() { return null; }
    async listRecords() { return []; }
    async softDelete() {}
    async purgeExpired() { return 0; }
    getLastInsert() { return lastInsert; }
  }

  return new TestStore();
}

test('write() clamps priority above 10 to 10', async () => {
  const store = makeStore();
  await store.write({ content: 'test', priority: 99 });
  assert.equal(store.getLastInsert().priority, 10);
});

test('write() clamps priority below 1 to 1', async () => {
  const store = makeStore();
  await store.write({ content: 'test', priority: -5 });
  assert.equal(store.getLastInsert().priority, 1);
});

test('write() defaults priority to 5 when not provided', async () => {
  const store = makeStore();
  await store.write({ content: 'test' });
  assert.equal(store.getLastInsert().priority, 5);
});

test('write() defaults category to "general" when not provided', async () => {
  const store = makeStore();
  await store.write({ content: 'test' });
  assert.equal(store.getLastInsert().category, 'general');
});

test('write() sets parent_id to null when not a number', async () => {
  const store = makeStore();
  await store.write({ content: 'test', parent_id: 'bad' });
  assert.equal(store.getLastInsert().parent_id, null);
});

test('write() returns correct path format shadowdb/{category}/{id}', async () => {
  const store = makeStore();
  const result = await store.write({ content: 'test', category: 'domain' });
  assert.equal(result.path, 'shadowdb/domain/42');
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'write');
});
