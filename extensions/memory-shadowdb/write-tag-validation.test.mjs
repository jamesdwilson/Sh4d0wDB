/**
 * write-tag-validation.test.mjs — TDD: write() validates tag namespaces
 *
 * Tests that memory_write rejects tags with invalid namespaces
 * when tag validation is enabled in config.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './dist/store.js';

function makeStore(options = {}) {
  let lastInsert = null;
  class TestStore extends MemoryStore {
    constructor() {
      super(null, {
        vectorWeight: 1, textWeight: 1, recencyWeight: 0.1,
        autoEmbed: false, purgeAfterDays: 0, table: 'memories',
        ...options
      }, { info: () => {}, warn: () => {} });
    }
    async insertRecord(params) { lastInsert = params; return 42; }
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

test('write() accepts valid tag namespaces', async () => {
  const store = makeStore({ validateTags: true });
  await store.write({
    content: 'test',
    tags: ['entity:james-wilson', 'domain:civic', 'loc:tyler-tx'],
  });
  const inserted = store.getLastInsert();
  assert.ok(inserted.tags.includes('entity:james-wilson'));
  assert.ok(inserted.tags.includes('domain:civic'));
});

test('write() accepts plain tags when validateTags=true', async () => {
  const store = makeStore({ validateTags: true });
  await store.write({
    content: 'test',
    tags: ['random-tag', 'entity:james-wilson'],
  });
  // Plain tags without namespace are allowed (strict mode is separate)
  const inserted = store.getLastInsert();
  assert.ok(inserted.tags.includes('random-tag'));
});

test('write() rejects unknown namespace when validateTags=true', async () => {
  const store = makeStore({ validateTags: true });
  await assert.rejects(
    () => store.write({
      content: 'test',
      tags: ['invalid:value'],
    }),
    /invalid.*namespace/i,
  );
});

test('write() rejects empty namespace when validateTags=true', async () => {
  const store = makeStore({ validateTags: true });
  await assert.rejects(
    () => store.write({
      content: 'test',
      tags: ['entity:'],
    }),
    /empty/i,
  );
});

test('write() allows invalid tags when validateTags=false (default)', async () => {
  const store = makeStore({ validateTags: false });
  // Should NOT throw — validation is off
  await store.write({
    content: 'test',
    tags: ['bad:value', 'entity:'],
  });
  const inserted = store.getLastInsert();
  assert.ok(inserted.tags.includes('bad:value'));
});
