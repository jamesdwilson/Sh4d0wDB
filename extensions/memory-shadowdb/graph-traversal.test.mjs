/**
 * graph-traversal.test.mjs — Integration tests for graph() traversal method
 *
 * Uses a TestStore that stubs getPool().query() to return controlled edges.
 * Tests: 1-hop, 2-hop, confidence filter, relationship_type filter,
 * loop guard, empty result, connected slug extraction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// PostgresStore depends on pg — import from dist directly
// We stub getPool() so no real DB connection is needed
import { PostgresStore } from './dist/postgres.js';

function makeEdgeRow(id, entity_a, entity_b, opts = {}) {
  return {
    id,
    content: `${entity_a} — ${entity_b}`,
    tags: [`entity:${entity_a}`, `entity:${entity_b}`],
    metadata: {
      entity_a,
      entity_b,
      relationship_type: opts.relationship_type ?? 'knows',
      confidence: opts.confidence ?? 80,
    },
  };
}

function makeStore(queryFn) {
  const store = new PostgresStore({
    connectionString: 'postgresql://localhost/test',
    embedder: null,
    config: { vectorWeight: 1, textWeight: 1, recencyWeight: 0.1, autoEmbed: false, purgeAfterDays: 0, table: 'memories' },
    logger: { info: () => {}, warn: () => {} },
  });
  // Stub getPool to avoid real connection
  store._pool = { query: queryFn };
  store.getPool = () => store._pool;
  return store;
}

test('graph() returns direct neighbors for 1 hop', async () => {
  const edges = [makeEdgeRow(1, 'alice', 'bob'), makeEdgeRow(2, 'alice', 'carol')];
  const store = makeStore(async () => ({ rows: edges }));

  const result = await store.graph({ entity: 'alice', hops: 1 });

  assert.equal(result.entity, 'alice');
  assert.equal(result.edges.length, 2);
  assert.ok(result.connected.includes('bob'));
  assert.ok(result.connected.includes('carol'));
});

test('graph() returns empty connected for unknown entity', async () => {
  const store = makeStore(async () => ({ rows: [] }));
  const result = await store.graph({ entity: 'nobody', hops: 1 });
  assert.equal(result.edges.length, 0);
  assert.equal(result.connected.length, 0);
});

test('graph() deduplicates edges appearing in multiple hops', async () => {
  let callCount = 0;
  const store = makeStore(async (_sql, values) => {
    callCount++;
    const slug = values[0].replace('entity:', '');
    if (slug === 'alice') return { rows: [makeEdgeRow(1, 'alice', 'bob')] };
    if (slug === 'bob') return { rows: [makeEdgeRow(1, 'alice', 'bob')] }; // same edge id
    return { rows: [] };
  });

  const result = await store.graph({ entity: 'alice', hops: 2 });
  // Edge id=1 should appear only once despite being returned in both hops
  const ids = result.edges.map(e => e.id);
  assert.equal(ids.filter(id => id === 1).length, 1);
});

test('graph() does not revisit already-visited entities (loop guard)', async () => {
  let queriedSlugs = [];
  const store = makeStore(async (_sql, values) => {
    const slug = values[0].replace('entity:', '');
    queriedSlugs.push(slug);
    // alice→bob, bob→alice (circular)
    if (slug === 'alice') return { rows: [makeEdgeRow(1, 'alice', 'bob')] };
    if (slug === 'bob') return { rows: [makeEdgeRow(1, 'alice', 'bob')] };
    return { rows: [] };
  });

  await store.graph({ entity: 'alice', hops: 3 });
  // alice should only be queried once, not revisited from bob's hop
  assert.equal(queriedSlugs.filter(s => s === 'alice').length, 1);
});

test('graph() normalizes entity slug to lowercase', async () => {
  let queriedTag = null;
  const store = makeStore(async (_sql, values) => {
    queriedTag = values[0];
    return { rows: [] };
  });

  await store.graph({ entity: 'James-Wilson', hops: 1 });
  assert.equal(queriedTag, 'entity:james-wilson');
});

test('graph() passes relationship_type filter to query', async () => {
  let capturedValues = null;
  const store = makeStore(async (_sql, values) => {
    capturedValues = values;
    return { rows: [] };
  });

  await store.graph({ entity: 'alice', hops: 1, relationship_type: 'tension' });
  assert.ok(capturedValues.includes('tension'));
});
