/**
 * update-validation.test.mjs — Unit tests for update() input validation
 *
 * Tests: empty patch rejection, deleted record guard,
 * record-not-found, priority clamping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './dist/store.js';

function makeStore({ meta = { id: 1, content: 'original', category: 'test', deleted_at: null } } = {}) {
  let lastPatch = null;

  class TestStore extends MemoryStore {
    constructor() {
      super(null, { vectorWeight: 1, textWeight: 1, recencyWeight: 0.1, autoEmbed: false, purgeAfterDays: 0, table: 'memories' }, { info: () => {}, warn: () => {} });
    }
    async getRecordMeta() { return meta; }
    async updateRecord(id, patch) { lastPatch = patch; }
    async getPrimerRows() { return []; }
    async vectorSearch() { return []; }
    async ftsSearch() { return []; }
    async fuzzySearch() { return []; }
    async insertRecord() { return 1; }
    async getRecord() { return null; }
    async listRecords() { return []; }
    async softDelete() {}
    async purgeExpired() { return 0; }
    getLastPatch() { return lastPatch; }
  }

  return new TestStore();
}

test('update() throws when record not found', async () => {
  const store = makeStore({ meta: null });
  await assert.rejects(() => store.update({ id: 99, content: 'new' }), /not found/i);
});

test('update() throws when record is deleted', async () => {
  const store = makeStore({ meta: { id: 1, content: 'x', category: 'test', deleted_at: '2026-01-01' } });
  await assert.rejects(() => store.update({ id: 1, content: 'new' }), /deleted/i);
});

test('update() throws when no fields provided', async () => {
  const store = makeStore();
  await assert.rejects(() => store.update({ id: 1 }), /at least one field/i);
});

test('update() clamps priority to 1-10 range', async () => {
  const store = makeStore();
  await store.update({ id: 1, priority: 99 });
  assert.equal(store.getLastPatch().priority, 10);

  await store.update({ id: 1, priority: -3 });
  assert.equal(store.getLastPatch().priority, 1);
});
