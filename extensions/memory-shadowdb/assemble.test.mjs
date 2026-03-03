/**
 * assemble.test.mjs — Unit tests for assemble() token-budget context assembly
 *
 * Tests: task_type budget presets, budget resolution (lesser of two),
 * category include/exclude filtering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './dist/store.js';

function makeHit(id, category, content = 'content') {
  return {
    path: `shadowdb/${category}/${id}`,
    snippet: content,
    score: 0.5,
    citation: `shadowdb:memories#${id}`,
  };
}

function makeStore(searchResults = []) {
  class TestStore extends MemoryStore {
    constructor() {
      super(null, { vectorWeight: 1, textWeight: 1, recencyWeight: 0.1, autoEmbed: false, purgeAfterDays: 0, table: 'memories' }, { info: () => {}, warn: () => {} });
    }
    async search() { return searchResults; }
    async getPrimerRows() { return []; }
    async vectorSearch() { return []; }
    async ftsSearch() { return []; }
    async fuzzySearch() { return []; }
    async insertRecord() { return 1; }
    async updateRecord() {}
    async getRecord() { return null; }
    async listRecords() { return []; }
    async softDelete() {}
    async purgeExpired() { return 0; }
    async getRecordMeta() { return null; }
  }
  return new TestStore();
}

test('TASK_TYPE_BUDGETS has correct preset values', () => {
  assert.equal(MemoryStore.TASK_TYPE_BUDGETS.quick, 500);
  assert.equal(MemoryStore.TASK_TYPE_BUDGETS.outreach, 2000);
  assert.equal(MemoryStore.TASK_TYPE_BUDGETS.dossier, 5000);
  assert.equal(MemoryStore.TASK_TYPE_BUDGETS.research, 10000);
});

test('assemble() uses lesser budget when both task_type and token_budget provided', async () => {
  const store = makeStore();
  // outreach=2000, explicit=500 → should use 500
  const result = await store.assemble({ query: 'test', task_type: 'outreach', token_budget: 500 });
  assert.equal(result.tokenBudget, 500);

  // quick=500, explicit=2000 → should use 500
  const result2 = await store.assemble({ query: 'test', task_type: 'quick', token_budget: 2000 });
  assert.equal(result2.tokenBudget, 500);
});

test('assemble() filters by include_categories', async () => {
  const hits = [
    makeHit(1, 'domain', 'domain content'),
    makeHit(2, 'research', 'research content'),
    makeHit(3, 'domain', 'more domain'),
  ];
  const store = makeStore(hits);
  const result = await store.assemble({ query: 'test', include_categories: ['domain'] });
  assert.equal(result.recordsUsed, 2);
  assert.ok(result.citations.every(c => c.path.includes('/domain/')));
});

test('assemble() filters by exclude_categories', async () => {
  const hits = [
    makeHit(1, 'domain', 'domain content'),
    makeHit(2, 'research', 'research content'),
    makeHit(3, 'domain', 'more domain'),
  ];
  const store = makeStore(hits);
  const result = await store.assemble({ query: 'test', exclude_categories: ['research'] });
  assert.equal(result.recordsUsed, 2);
  assert.ok(result.citations.every(c => !c.path.includes('/research/')));
});
