/**
 * phase1-parties.test.mjs — TDD tests for resolveParties()
 *
 * resolveParties() fuzzy-matches extracted party names against existing
 * ShadowDB contact titles. The DB is injected as a mock — no real PG calls.
 *
 * Contact title format: "First Last — Dossier (Type)" or "First Last — <anything>"
 * Name extraction: everything before " — " (em dash).
 *
 * Run with: node --test phase1-parties.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveParties } from './dist/phase1-parties.js';

// ============================================================================
// Mock DB
// ============================================================================

/**
 * Build a mock DB that returns a fixed set of contact rows.
 * Matches the DbClient interface expected by resolveParties().
 *
 * Each row: { id, title, category }
 */
function mockDb(contacts = []) {
  return {
    query: async (_sql, _params) => ({ rows: contacts }),
  };
}

/** Realistic contact fixture rows (no real people) */
const FIXTURE_CONTACTS = [
  { id: 1001, title: 'Alice Example — Dossier (Full 8-Layer)',      category: 'contacts' },
  { id: 1002, title: 'Bob Investor — Dossier (Abbreviated)',        category: 'contacts' },
  { id: 1003, title: 'Carol Ventures — Dossier (Abbreviated)',      category: 'contacts' },
  { id: 1004, title: 'Dave Smith, PhD — Dossier (Full 8-Layer)',    category: 'contacts' },
  { id: 1005, title: 'Eve Capital (Acme Fund) — Dossier (Abbreviated)', category: 'contacts' },
];

// ============================================================================
// resolveParties — basic matching
// ============================================================================

test('resolveParties returns empty array for empty parties input', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties([], db);
  assert.deepEqual(result, []);
});

test('resolveParties exact match returns correct memoryId', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Alice Example'], db);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Alice Example');
  assert.equal(result[0].memoryId, 1001);
});

test('resolveParties case-insensitive match', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['alice example'], db);
  assert.equal(result.length, 1);
  assert.equal(result[0].memoryId, 1001);
});

test('resolveParties no match returns memoryId null', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Frank Nobody'], db);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Frank Nobody');
  assert.equal(result[0].memoryId, null);
});

test('resolveParties handles multiple parties, mix of matches and misses', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Alice Example', 'Unknown Person', 'Bob Investor'], db);
  assert.equal(result.length, 3);
  const byName = Object.fromEntries(result.map(r => [r.name, r.memoryId]));
  assert.equal(byName['Alice Example'], 1001);
  assert.equal(byName['Unknown Person'], null);
  assert.equal(byName['Bob Investor'], 1002);
});

// ============================================================================
// resolveParties — fuzzy / partial matching
// ============================================================================

test('resolveParties fuzzy-matches first name + last name even with suffix in title', async () => {
  // "Dave Smith, PhD" in DB — query with "Dave Smith" should match
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Dave Smith'], db);
  assert.equal(result.length, 1);
  assert.equal(result[0].memoryId, 1004, 'should match Dave Smith, PhD by first+last');
});

test('resolveParties fuzzy-matches partial name (last name only) when unambiguous', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Investor'], db);
  // "Bob Investor" — last name only match
  assert.equal(result.length, 1);
  assert.equal(result[0].memoryId, 1002);
});

test('resolveParties does NOT match when partial name is ambiguous (multiple contacts match)', async () => {
  // If multiple contacts could match a partial name, return null (avoid false positives)
  const contacts = [
    { id: 2001, title: 'Alice Smith — Dossier', category: 'contacts' },
    { id: 2002, title: 'Bob Smith — Dossier',   category: 'contacts' },
  ];
  const db = mockDb(contacts);
  const result = await resolveParties(['Smith'], db);
  assert.equal(result.length, 1);
  assert.equal(result[0].memoryId, null, 'ambiguous partial match should return null');
});

// ============================================================================
// resolveParties — edge cases
// ============================================================================

test('resolveParties handles empty contact DB (no rows)', async () => {
  const db = mockDb([]);
  const result = await resolveParties(['Alice Example'], db);
  assert.equal(result.length, 1);
  assert.equal(result[0].memoryId, null);
});

test('resolveParties never throws when DB query fails — returns null memoryId', async () => {
  const failingDb = {
    query: async () => { throw new Error('DB connection lost'); },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await resolveParties(['Alice Example'], failingDb);
  });
  assert.equal(result[0].memoryId, null, 'DB error should yield null memoryId, not throw');
});

test('resolveParties result has required fields: name, memoryId, matchScore', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Alice Example'], db);
  const r = result[0];
  assert.ok('name' in r, 'should have name');
  assert.ok('memoryId' in r, 'should have memoryId');
  assert.ok('matchScore' in r, 'should have matchScore');
  assert.ok(typeof r.matchScore === 'number', 'matchScore should be number');
  assert.ok(r.matchScore >= 0 && r.matchScore <= 1, 'matchScore should be in [0,1]');
});

test('resolveParties exact match has matchScore = 1.0', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Alice Example'], db);
  assert.ok(result[0].matchScore >= 0.95, `exact match should have score ≥0.95, got ${result[0].matchScore}`);
});

test('resolveParties no match has matchScore = 0', async () => {
  const db = mockDb(FIXTURE_CONTACTS);
  const result = await resolveParties(['Zzz Nomatch'], db);
  assert.equal(result[0].matchScore, 0);
});
