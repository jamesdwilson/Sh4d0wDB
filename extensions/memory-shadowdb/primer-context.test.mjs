/**
 * primer-context.test.mjs — Unit tests for getPrimerContext progressive fill
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './dist/store.js';

function makeStore(rows) {
  class TestStore extends MemoryStore {
    constructor() {
      super(null, { vectorWeight: 1, textWeight: 1, recencyWeight: 0.1, autoEmbed: false, purgeAfterDays: 0, table: 'memories' }, { info: () => {}, warn: () => {} });
    }
    async getPrimerRows() { return rows; }
    async vectorSearch() { return []; }
    async ftsSearch() { return []; }
    async fuzzySearch() { return []; }
    async insertRecord() { return { id: 1, path: 'shadowdb/test/1' }; }
    async updateRecord() {}
    async getRecord() { return null; }
    async listRecords() { return []; }
    async softDelete() {}
    async purgeExpired() { return 0; }
  }
  return new TestStore();
}

test('getPrimerContext returns null for empty rows', async () => {
  const result = await makeStore([]).getPrimerContext(4000);
  assert.equal(result, null);
});

test('getPrimerContext includes all sections when budget is unlimited (0)', async () => {
  const rows = [
    { key: 'soul', content: 'Soul content.' },
    { key: 'rules', content: 'Rules content.' },
    { key: 'nags', content: 'Nag content.' },
  ];
  const result = await makeStore(rows).getPrimerContext(0);
  assert.ok(result.text.includes('## soul'));
  assert.ok(result.text.includes('## rules'));
  assert.ok(result.text.includes('## nags'));
  assert.equal(result.skippedKeys.length, 0);
  assert.equal(result.truncated, false);
});

test('getPrimerContext skips sections that exceed budget', async () => {
  const big = 'x'.repeat(500);
  const rows = [
    { key: 'small', content: 'Short.' },     // fits
    { key: 'large', content: big },           // won't fit in tight budget
  ];
  const result = await makeStore(rows).getPrimerContext(100);
  assert.ok(result.text.includes('## small'));
  assert.ok(!result.text.includes('## large'));
  assert.ok(result.skippedKeys.includes('large'));
  assert.equal(result.truncated, true);
});

test('getPrimerContext includes rowCount and includedCount metadata', async () => {
  const rows = [
    { key: 'a', content: 'AAA' },
    { key: 'b', content: 'B'.repeat(400) },
  ];
  const result = await makeStore(rows).getPrimerContext(50);
  assert.equal(result.rowCount, 2);
  assert.ok(result.includedCount <= result.rowCount);
  assert.equal(typeof result.digest, 'string');
  assert.equal(result.digest.length, 16);
});
