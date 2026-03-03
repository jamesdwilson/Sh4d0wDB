/**
 * format-section.test.mjs — Unit tests for formatSection
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

const multiSection = `Intro paragraph before any heading.

## Alpha Section
Alpha content about budgets and finance.

## Beta Section
Beta content about product roadmap and delivery.

## Gamma Section
Gamma content about marketing strategy.`;

test('formatSection returns best-matching section for query', () => {
  const result = store.formatSection({ id: 1, content: multiSection }, 'product roadmap delivery');
  assert.ok(result.includes('## Beta Section'), `expected Beta, got: ${result}`);
  assert.ok(result.includes('Beta content about product roadmap'));
});

test('formatSection falls back to snippet when no ## headings', () => {
  const plain = 'Just plain text with no headings at all.';
  const result = store.formatSection({ id: 1, content: plain, category: null, created_at: null }, 'anything');
  assert.equal(result, 'Just plain text with no headings at all.');
});

test('formatSection caps section output at ~2000 chars', () => {
  const bigSection = `## Big Section\n${'word '.repeat(500)}`; // ~2500 chars
  const result = store.formatSection({ id: 1, content: bigSection }, 'word');
  assert.ok(result.length <= 2100, `got ${result.length} chars`); // small buffer for header
});

test('formatSection includes category header when provided', () => {
  const result = store.formatSection(
    { id: 1, content: multiSection, category: 'strategy', created_at: null },
    'marketing strategy',
  );
  assert.ok(result.startsWith('strategy|') || result.startsWith('strategy\n'), `got: ${result}`);
});
