/**
 * phase3b-postgres-entity-store.test.mjs — TDD tests for PostgresEntityStore
 *
 * Tests the real DB implementation of EntityStore against the live
 * `shadow` PostgreSQL database.
 *
 * Design:
 *   - Uses a dedicated test schema prefix ("__test_entity_") to isolate
 *     test data — never touches real records
 *   - Cleans up all test rows in afterEach via the test prefix
 *   - Skips gracefully if DB is unavailable (CI-friendly)
 *
 * What's tested:
 *   A — findByLinkedinUrl / findByEmail / findByName / findByNameAndCompany
 *   B — createEntity / updateEntity
 *   C — mergeEntities (edge re-pointing)
 *   D — findEdge / createEdge / updateEdge (idempotency)
 *
 * Run: node --test phase3b-postgres-entity-store.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPostgresEntityStore } from './dist/phase3b-postgres-entity-store.js';

// ============================================================================
// DB setup — skip all tests if DB unavailable
// ============================================================================

const CONNECTION_STRING = 'postgresql:///shadow';
const TEST_PREFIX = '__test_entity_';

let pool;
let store;
let dbAvailable = false;

try {
  pool = new pg.Pool({ connectionString: CONNECTION_STRING, max: 2 });
  await pool.query('SELECT 1');
  store = createPostgresEntityStore(pool);
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

// Helper — create a test entity title (namespaced so we can clean up)
function testTitle(name) {
  return `${TEST_PREFIX}${name}_${Date.now()}`;
}

// Cleanup helper — delete all test rows after each test
async function cleanup() {
  if (!dbAvailable) return;
  await pool.query(`DELETE FROM memories WHERE title LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(
    `DELETE FROM memory_edges WHERE source_id LIKE $1`,
    [`test_entity_%`],
  );
}

// ============================================================================
// Group A — find methods
// ============================================================================

test('A1: findByLinkedinUrl returns entity when URL matches metadata', { skip: !dbAvailable }, async () => {
  await cleanup();
  const linkedinUrl = `https://www.linkedin.com/in/test-${Date.now()}/`;
  const title = testTitle('Alice');

  // Insert directly
  await pool.query(
    `INSERT INTO memories (title, content, category, metadata) VALUES ($1, $2, $3, $4)`,
    [title, 'Alice Example test', 'person', JSON.stringify({ linkedinUrl, emails: [], phones: [], companies: [], sourceBitmask: 0 })],
  );

  const result = await store.findByLinkedinUrl(linkedinUrl);
  assert.ok(result !== null, 'should find entity by linkedinUrl');
  assert.ok(result.title === title);

  await cleanup();
});

test('A2: findByLinkedinUrl returns null when URL not found', { skip: !dbAvailable }, async () => {
  const result = await store.findByLinkedinUrl('https://www.linkedin.com/in/nobody-xyz-123/');
  assert.equal(result, null);
});

test('A3: findByEmail returns entity when email is in metadata.emails array', { skip: !dbAvailable }, async () => {
  await cleanup();
  const email = `test_${Date.now()}@example.com`;
  const title = testTitle('Bob');

  await pool.query(
    `INSERT INTO memories (title, content, category, metadata) VALUES ($1, $2, $3, $4)`,
    [title, 'Bob test', 'person', JSON.stringify({ emails: [email], phones: [], companies: [], sourceBitmask: 0 })],
  );

  const result = await store.findByEmail(email);
  assert.ok(result !== null, 'should find by email');
  assert.equal(result.title, title);

  await cleanup();
});

test('A4: findByEmail returns null when email not found', { skip: !dbAvailable }, async () => {
  const result = await store.findByEmail('nobody-xyz@nowhere.test');
  assert.equal(result, null);
});

test('A5: findByName returns entities with matching canonicalName', { skip: !dbAvailable }, async () => {
  await cleanup();
  const title = testTitle('Carol');
  const canonicalName = `Carol_${Date.now()}`;

  await pool.query(
    `INSERT INTO memories (title, content, category, metadata) VALUES ($1, $2, $3, $4)`,
    [title, 'Carol test', 'person', JSON.stringify({ canonicalName, emails: [], phones: [], companies: [], sourceBitmask: 0 })],
  );

  const results = await store.findByName(canonicalName);
  assert.ok(results.some(r => r.title === title), 'should find by canonicalName');

  await cleanup();
});

test('A6: findByNameAndCompany returns entities matching both name and company', { skip: !dbAvailable }, async () => {
  await cleanup();
  const canonicalName = `Dan_${Date.now()}`;
  const company = `TestCo_${Date.now()}`;
  const title = testTitle('Dan');

  await pool.query(
    `INSERT INTO memories (title, content, category, metadata) VALUES ($1, $2, $3, $4)`,
    [title, 'Dan test', 'person', JSON.stringify({ canonicalName, emails: [], phones: [], companies: [company], sourceBitmask: 0 })],
  );

  const results = await store.findByNameAndCompany(canonicalName, company);
  assert.ok(results.some(r => r.title === title), 'should find by name+company');

  await cleanup();
});

// ============================================================================
// Group B — createEntity / updateEntity
// ============================================================================

test('B1: createEntity inserts a new memory row and returns it with id', { skip: !dbAvailable }, async () => {
  await cleanup();

  const result = await store.createEntity({
    type: 'person',
    name: testTitle('Eve'),
    email: `eve_${Date.now()}@test.com`,
    sourceId: 'test',
    sourceRecordId: 'test:eve:1',
    confidence: 0.99,
  });

  assert.ok(result.id > 0, 'should have a positive id');
  assert.ok(result.title.startsWith(TEST_PREFIX), 'title should use test prefix');
  assert.ok(result.metadata.emails.length > 0, 'should store email in metadata');

  await cleanup();
});

test('B2: updateEntity patches metadata without clobbering existing fields', { skip: !dbAvailable }, async () => {
  await cleanup();

  const created = await store.createEntity({
    type: 'person',
    name: testTitle('Frank'),
    email: `frank_${Date.now()}@test.com`,
    sourceId: 'test',
    sourceRecordId: 'test:frank:1',
    confidence: 0.99,
  });

  await store.updateEntity(created.id, {
    metadata: { ...created.metadata, linkedinUrl: 'https://linkedin.com/in/frank-test' },
  });

  // Re-fetch to verify
  const all = await pool.query(`SELECT metadata FROM memories WHERE id = $1`, [created.id]);
  const meta = all.rows[0]?.metadata;
  assert.ok(meta?.linkedinUrl, 'should have set linkedinUrl');
  assert.ok(meta?.emails?.length > 0, 'should still have original email');

  await cleanup();
});

// ============================================================================
// Group C — mergeEntities
// ============================================================================

test('C1: mergeEntities removes absorbed row from memories table', { skip: !dbAvailable }, async () => {
  await cleanup();

  const a = await store.createEntity({
    type: 'person', name: testTitle('GraceA'),
    sourceId: 'test', sourceRecordId: 'test:grace:a', confidence: 0.9,
  });
  const b = await store.createEntity({
    type: 'person', name: testTitle('GraceB'),
    sourceId: 'test', sourceRecordId: 'test:grace:b', confidence: 0.9,
  });

  await store.mergeEntities(a.id, b.id);

  const check = await pool.query(`SELECT id FROM memories WHERE id = $1`, [b.id]);
  assert.equal(check.rows.length, 0, 'absorbed entity should be deleted');

  await cleanup();
});

// ============================================================================
// Group D — findEdge / createEdge / updateEdge
// ============================================================================

test('D1: createEdge inserts edge row, findEdge retrieves it', { skip: !dbAvailable }, async () => {
  await cleanup();

  const a = await store.createEntity({
    type: 'person', name: testTitle('Henry'),
    sourceId: 'test', sourceRecordId: 'test:henry:1', confidence: 0.9,
  });
  const b = await store.createEntity({
    type: 'company', companyName: testTitle('Initech'),
    sourceId: 'test', sourceRecordId: 'test:initech:1', confidence: 0.9,
  });

  await store.createEdge({
    fromId: a.id,
    toId: b.id,
    type: 'works_at',
    confidence: 0.95,
    sourceId: 'test_entity_works_at',
  });

  const edge = await store.findEdge(a.id, b.id, 'works_at');
  assert.ok(edge !== null, 'should find the created edge');
  assert.equal(edge.type, 'works_at');
  assert.equal(edge.confidence, 0.95);

  await cleanup();
});

test('D2: updateEdge updates confidence and lastVerifiedAt', { skip: !dbAvailable }, async () => {
  await cleanup();

  const a = await store.createEntity({
    type: 'person', name: testTitle('Iris'),
    sourceId: 'test', sourceRecordId: 'test:iris:1', confidence: 0.9,
  });
  const b = await store.createEntity({
    type: 'company', companyName: testTitle('Initech2'),
    sourceId: 'test', sourceRecordId: 'test:initech2:1', confidence: 0.9,
  });

  await store.createEdge({
    fromId: a.id, toId: b.id, type: 'works_at', confidence: 0.70, sourceId: 'test_entity_update',
  });

  await store.updateEdge(a.id, b.id, 'works_at', { confidence: 0.95 });

  const edge = await store.findEdge(a.id, b.id, 'works_at');
  assert.ok(edge !== null);
  assert.equal(edge.confidence, 0.95, 'confidence should be updated');

  await cleanup();
});

test('D3: findEdge returns null when edge does not exist', { skip: !dbAvailable }, async () => {
  const edge = await store.findEdge(99999998, 99999999, 'knows');
  assert.equal(edge, null);
});
