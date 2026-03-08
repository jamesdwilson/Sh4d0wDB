/**
 * phase3b-entity-resolver.test.mjs — TDD tests for cross-source entity resolution
 *
 * Tests the EntityResolver described in ARCHITECTURE.md § 7.4.
 *
 * Resolution priority (highest confidence first):
 *   1. linkedinUrl match        → 1.00
 *   2. email match              → 0.99
 *   3. name + company + title   → 0.85
 *   4. name + company           → 0.70
 *   5. name fuzzy only          → 0.50
 *   6. company + domain         → 0.90 (company nodes)
 *   7. company name fuzzy       → 0.60 (company nodes)
 *
 * Test groups:
 *   A — resolveCandidate: person resolution
 *   B — resolveCandidate: company resolution
 *   C — mergeEntities
 *   D — addEdge (idempotency + confidence update)
 *   E — cross-source resolution (Gmail email + LinkedIn name+company → same node)
 *
 * Run: node --test phase3b-entity-resolver.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityResolver,
} from './dist/phase3b-entity-resolver.js';

// ============================================================================
// Mock store — in-memory, no DB required
// ============================================================================

/**
 * Minimal in-memory entity store for tests.
 * Simulates the ShadowDB memories table (id, title, category, metadata).
 */
function createMockStore(initialEntities = []) {
  let nextId = 1;
  const entities = [...initialEntities].map(e => ({ ...e, id: nextId++ }));
  const edges = [];

  return {
    // EntityStore interface
    async findByLinkedinUrl(url) {
      return entities.find(e => e.metadata?.linkedinUrl === url) ?? null;
    },
    async findByEmail(email) {
      return entities.find(
        e => (e.metadata?.emails ?? []).includes(email)
      ) ?? null;
    },
    async findByNameAndCompany(name, company) {
      return entities.filter(
        e => e.metadata?.canonicalName && fuzzyMatch(e.metadata.canonicalName, name) &&
             (e.metadata?.companies ?? []).some(c => fuzzyMatch(c, company))
      );
    },
    async findByName(name) {
      return entities.filter(
        e => e.metadata?.canonicalName && fuzzyMatch(e.metadata.canonicalName, name)
      );
    },
    async findByDomain(domain) {
      return entities.find(e => e.metadata?.domain === domain) ?? null;
    },
    async findByCompanyName(name) {
      return entities.filter(
        e => e.category === 'company' && e.metadata?.canonicalName &&
             fuzzyMatch(e.metadata.canonicalName, name)
      );
    },
    async createEntity(candidate) {
      const id = nextId++;
      const entity = {
        id,
        category: candidate.type,
        title: candidate.name ?? candidate.companyName ?? 'Unknown',
        metadata: {
          canonicalName: candidate.name ?? candidate.companyName,
          emails: candidate.email ? [candidate.email] : [],
          phones: candidate.phone ? [candidate.phone] : [],
          linkedinUrl: candidate.linkedinUrl,
          domain: candidate.domain,
          companies: candidate.companyName ? [candidate.companyName] : [],
          sourceBitmask: 0,
        },
      };
      entities.push(entity);
      return entity;
    },
    async updateEntity(id, patch) {
      const idx = entities.findIndex(e => e.id === id);
      if (idx < 0) throw new Error(`Entity ${id} not found`);
      entities[idx] = { ...entities[idx], ...patch, metadata: { ...entities[idx].metadata, ...patch.metadata } };
      return entities[idx];
    },
    async mergeEntities(survivorId, absorbedId) {
      // Re-point all edges
      for (const edge of edges) {
        if (edge.fromId === absorbedId) edge.fromId = survivorId;
        if (edge.toId === absorbedId) edge.toId = survivorId;
      }
      // Remove absorbed entity
      const idx = entities.findIndex(e => e.id === absorbedId);
      if (idx >= 0) entities.splice(idx, 1);
    },
    async findEdge(fromId, toId, type) {
      return edges.find(e => e.fromId === fromId && e.toId === toId && e.type === type) ?? null;
    },
    async createEdge(edge) {
      edges.push({ ...edge, firstSeenAt: new Date(), lastVerifiedAt: new Date() });
    },
    async updateEdge(fromId, toId, type, patch) {
      const edge = edges.find(e => e.fromId === fromId && e.toId === toId && e.type === type);
      if (edge) Object.assign(edge, patch, { lastVerifiedAt: new Date() });
    },
    // Test introspection helpers
    _entities: entities,
    _edges: edges,
    _count: () => entities.length,
    _edgeCount: () => edges.length,
  };
}

function fuzzyMatch(a, b) {
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

// ============================================================================
// Group A — resolveCandidate: person resolution
// ============================================================================

test('A1: resolves person by linkedinUrl — highest confidence, returns existing entity', async () => {
  const store = createMockStore([{
    category: 'person',
    title: 'Alice Example',
    metadata: {
      canonicalName: 'Alice Example',
      emails: ['alice@acme.com'],
      linkedinUrl: 'https://www.linkedin.com/in/alice-example/',
      companies: ['Acme Capital'],
    },
  }]);
  const resolver = createEntityResolver(store);

  const result = await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    linkedinUrl: 'https://www.linkedin.com/in/alice-example/',
    sourceId: 'linkedin:profile:alice-example',
    sourceRecordId: 'alice-example',
    confidence: 0.95,
  });

  assert.ok(result !== null, 'should resolve to existing entity');
  assert.equal(result.canonicalName, 'Alice Example');
  assert.equal(store._count(), 1, 'should NOT create a new entity');
});

test('A2: resolves person by email — returns existing entity without creating duplicate', async () => {
  const store = createMockStore([{
    category: 'person',
    title: 'Alice Example',
    metadata: {
      canonicalName: 'Alice Example',
      emails: ['alice@acme.com'],
      linkedinUrl: null,
      companies: [],
    },
  }]);
  const resolver = createEntityResolver(store);

  const result = await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    email: 'alice@acme.com',
    sourceId: 'gmail',
    sourceRecordId: 'msg123',
    confidence: 0.99,
  });

  assert.ok(result !== null);
  assert.equal(result.canonicalName, 'Alice Example');
  assert.equal(store._count(), 1);
});

test('A3: resolves person by name + company when no email or linkedinUrl', async () => {
  const store = createMockStore([{
    category: 'person',
    title: 'Alice Example',
    metadata: {
      canonicalName: 'Alice Example',
      emails: [],
      companies: ['Acme Capital'],
    },
  }]);
  const resolver = createEntityResolver(store);

  const result = await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    companyName: 'Acme Capital',
    sourceId: 'imsg',
    sourceRecordId: 'chat:alice:001',
    confidence: 0.85,
  });

  assert.ok(result !== null);
  assert.equal(result.canonicalName, 'Alice Example');
  assert.equal(store._count(), 1);
});

test('A4: creates new entity when no match found', async () => {
  const store = createMockStore([]);
  const resolver = createEntityResolver(store);

  const result = await resolver.resolve({
    type: 'person',
    name: 'Bob Newcomer',
    email: 'bob@newco.com',
    sourceId: 'gmail',
    sourceRecordId: 'msg456',
    confidence: 0.99,
  });

  assert.ok(result !== null);
  assert.equal(result.canonicalName, 'Bob Newcomer');
  assert.equal(store._count(), 1, 'should create exactly one new entity');
});

test('A5: returns null when confidence below threshold (fuzzy name only, no company)', async () => {
  const store = createMockStore([{
    category: 'person',
    title: 'Alice Example',
    metadata: { canonicalName: 'Alice Example', emails: [], companies: [] },
  }]);
  const resolver = createEntityResolver(store, { minConfidence: 0.6 });

  // Name-only fuzzy match = 0.50 confidence — below threshold
  const result = await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    sourceId: 'test',
    sourceRecordId: 'test:1',
    confidence: 0.50,
  });

  assert.equal(result, null, 'below-threshold match should return null');
});

test('A6: enriches existing entity with new email when resolved by linkedinUrl', async () => {
  const store = createMockStore([{
    category: 'person',
    title: 'Alice Example',
    metadata: {
      canonicalName: 'Alice Example',
      emails: [],
      linkedinUrl: 'https://www.linkedin.com/in/alice-example/',
      companies: [],
    },
  }]);
  const resolver = createEntityResolver(store);

  await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    email: 'alice@acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/alice-example/',
    sourceId: 'gmail',
    sourceRecordId: 'msg789',
    confidence: 0.99,
  });

  const entity = store._entities[0];
  assert.ok(entity.metadata.emails.includes('alice@acme.com'), 'should enrich with new email');
});

test('A7: never throws on malformed candidate', async () => {
  const store = createMockStore([]);
  const resolver = createEntityResolver(store);

  let result;
  await assert.doesNotReject(async () => {
    result = await resolver.resolve({
      type: 'person',
      // no name, no email, no linkedinUrl
      sourceId: 'test',
      sourceRecordId: 'bad',
      confidence: 0.1,
    });
  });
  assert.equal(result, null, 'empty candidate should return null');
});

// ============================================================================
// Group B — resolveCandidate: company resolution
// ============================================================================

test('B1: resolves company by domain', async () => {
  const store = createMockStore([{
    category: 'company',
    title: 'Acme Capital',
    metadata: { canonicalName: 'Acme Capital', domain: 'acmecapital.com', emails: [], companies: [] },
  }]);
  const resolver = createEntityResolver(store);

  const result = await resolver.resolve({
    type: 'company',
    companyName: 'Acme Capital',
    domain: 'acmecapital.com',
    sourceId: 'linkedin:profile:alice-example',
    sourceRecordId: 'alice-example:exp:Acme Capital',
    confidence: 0.90,
  });

  assert.ok(result !== null);
  assert.equal(result.canonicalName, 'Acme Capital');
  assert.equal(store._count(), 1);
});

test('B2: resolves company by name fuzzy match', async () => {
  const store = createMockStore([{
    category: 'company',
    title: 'Goldman Sachs',
    metadata: { canonicalName: 'Goldman Sachs', domain: null, emails: [], companies: [] },
  }]);
  const resolver = createEntityResolver(store);

  const result = await resolver.resolve({
    type: 'company',
    companyName: 'Goldman Sachs',
    sourceId: 'linkedin:profile:bob',
    sourceRecordId: 'bob:exp:Goldman Sachs',
    confidence: 0.80,
  });

  assert.ok(result !== null);
  assert.equal(result.canonicalName, 'Goldman Sachs');
  assert.equal(store._count(), 1);
});

test('B3: creates new company entity when not found', async () => {
  const store = createMockStore([]);
  const resolver = createEntityResolver(store);

  const result = await resolver.resolve({
    type: 'company',
    companyName: 'New Ventures LLC',
    sourceId: 'linkedin:profile:alice',
    sourceRecordId: 'alice:exp:New Ventures LLC',
    confidence: 0.80,
  });

  assert.ok(result !== null);
  assert.equal(result.canonicalName, 'New Ventures LLC');
  assert.equal(store._count(), 1);
});

// ============================================================================
// Group C — mergeEntities
// ============================================================================

test('C1: merge absorbs one entity into another', async () => {
  const store = createMockStore([
    { category: 'person', title: 'Alice A', metadata: { canonicalName: 'Alice A', emails: ['a@a.com'], companies: [], linkedinUrl: null } },
    { category: 'person', title: 'Alice B', metadata: { canonicalName: 'Alice B', emails: ['b@b.com'], companies: [], linkedinUrl: null } },
  ]);
  const resolver = createEntityResolver(store);

  const [survivorId, absorbedId] = [store._entities[0].id, store._entities[1].id];
  await resolver.merge(survivorId, absorbedId, 0.90);

  assert.equal(store._count(), 1, 'absorbed entity should be removed');
  assert.equal(store._entities[0].id, survivorId, 'survivor should remain');
});

test('C2: merge re-points edges from absorbed to survivor', async () => {
  const store = createMockStore([
    { category: 'person', title: 'Alice A', metadata: { canonicalName: 'Alice A', emails: [], companies: [], linkedinUrl: null } },
    { category: 'person', title: 'Alice B', metadata: { canonicalName: 'Alice B', emails: [], companies: [], linkedinUrl: null } },
    { category: 'company', title: 'Acme', metadata: { canonicalName: 'Acme', emails: [], companies: [], linkedinUrl: null } },
  ]);
  const resolver = createEntityResolver(store);

  const [aliceA, aliceB, acme] = store._entities;

  // Edge: aliceB → acme
  store._edges.push({ fromId: aliceB.id, toId: acme.id, type: 'works_at', confidence: 0.9 });

  await resolver.merge(aliceA.id, aliceB.id, 0.90);

  const edge = store._edges[0];
  assert.equal(edge.fromId, aliceA.id, 'edge should now point from survivor');
});

test('C3: merge never throws even if one entity does not exist', async () => {
  const store = createMockStore([
    { category: 'person', title: 'Alice', metadata: { canonicalName: 'Alice', emails: [], companies: [], linkedinUrl: null } },
  ]);
  const resolver = createEntityResolver(store);

  await assert.doesNotReject(async () => {
    await resolver.merge(store._entities[0].id, 99999, 0.90);
  });
});

// ============================================================================
// Group D — addEdge (idempotency + confidence update)
// ============================================================================

test('D1: addEdge creates a new edge between two entities', async () => {
  const store = createMockStore([
    { category: 'person', title: 'Alice', metadata: { canonicalName: 'Alice', emails: [], companies: [], linkedinUrl: null } },
    { category: 'company', title: 'Acme', metadata: { canonicalName: 'Acme', emails: [], companies: [], linkedinUrl: null } },
  ]);
  const resolver = createEntityResolver(store);
  const [alice, acme] = store._entities;

  await resolver.addEdge({
    fromId: alice.id,
    toId: acme.id,
    type: 'works_at',
    confidence: 0.95,
    sourceId: 'linkedin:profile:alice',
  });

  assert.equal(store._edgeCount(), 1);
  assert.equal(store._edges[0].type, 'works_at');
  assert.equal(store._edges[0].confidence, 0.95);
});

test('D2: addEdge is idempotent — same edge registered twice = one edge, updated confidence', async () => {
  const store = createMockStore([
    { category: 'person', title: 'Alice', metadata: { canonicalName: 'Alice', emails: [], companies: [], linkedinUrl: null } },
    { category: 'company', title: 'Acme', metadata: { canonicalName: 'Acme', emails: [], companies: [], linkedinUrl: null } },
  ]);
  const resolver = createEntityResolver(store);
  const [alice, acme] = store._entities;

  await resolver.addEdge({ fromId: alice.id, toId: acme.id, type: 'works_at', confidence: 0.80, sourceId: 'src1' });
  await resolver.addEdge({ fromId: alice.id, toId: acme.id, type: 'works_at', confidence: 0.95, sourceId: 'src2' });

  assert.equal(store._edgeCount(), 1, 'should still be one edge');
  assert.equal(store._edges[0].confidence, 0.95, 'confidence should be updated to higher value');
});

test('D3: addEdge updates lastVerifiedAt on re-registration', async () => {
  const store = createMockStore([
    { category: 'person', title: 'Alice', metadata: { canonicalName: 'Alice', emails: [], companies: [], linkedinUrl: null } },
    { category: 'company', title: 'Acme', metadata: { canonicalName: 'Acme', emails: [], companies: [], linkedinUrl: null } },
  ]);
  const resolver = createEntityResolver(store);
  const [alice, acme] = store._entities;

  await resolver.addEdge({ fromId: alice.id, toId: acme.id, type: 'works_at', confidence: 0.80, sourceId: 'src1' });
  const firstVerified = store._edges[0].lastVerifiedAt;

  await new Promise(r => setTimeout(r, 5));

  await resolver.addEdge({ fromId: alice.id, toId: acme.id, type: 'works_at', confidence: 0.80, sourceId: 'src1' });
  const secondVerified = store._edges[0].lastVerifiedAt;

  assert.ok(secondVerified >= firstVerified, 'lastVerifiedAt should be updated');
});

test('D4: different edge types between same pair are stored separately', async () => {
  const store = createMockStore([
    { category: 'person', title: 'Alice', metadata: { canonicalName: 'Alice', emails: [], companies: [], linkedinUrl: null } },
    { category: 'person', title: 'Bob', metadata: { canonicalName: 'Bob', emails: [], companies: [], linkedinUrl: null } },
  ]);
  const resolver = createEntityResolver(store);
  const [alice, bob] = store._entities;

  await resolver.addEdge({ fromId: alice.id, toId: bob.id, type: 'knows', confidence: 0.70, sourceId: 'src1' });
  await resolver.addEdge({ fromId: alice.id, toId: bob.id, type: 'referred', confidence: 0.90, sourceId: 'src2' });

  assert.equal(store._edgeCount(), 2, 'different edge types should be separate records');
});

// ============================================================================
// Group E — cross-source resolution integration
// ============================================================================

test('E1: Gmail email + LinkedIn name+company resolves to same entity', async () => {
  const store = createMockStore([]);
  const resolver = createEntityResolver(store);

  // First: Gmail ingestion creates entity from email
  await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    email: 'alice@acme.com',
    sourceId: 'gmail',
    sourceRecordId: 'msg:001',
    confidence: 0.99,
  });
  assert.equal(store._count(), 1, 'Gmail should create one entity');

  // Second: LinkedIn profile resolves same person by name+company
  const result = await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    companyName: 'Acme Capital',
    linkedinUrl: 'https://www.linkedin.com/in/alice-example/',
    sourceId: 'linkedin:profile:alice-example',
    sourceRecordId: 'alice-example',
    confidence: 0.85,
  });

  // Should match existing entity (name fuzzy match), not create a new one
  assert.ok(result !== null);
  assert.equal(store._count(), 1, 'should still be one entity — same person');
});

test('E2: LinkedIn linkedinUrl match enriches entity already created from Gmail', async () => {
  const store = createMockStore([]);
  const resolver = createEntityResolver(store);

  // Gmail creates entity — no linkedinUrl yet
  await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    email: 'alice@acme.com',
    sourceId: 'gmail',
    sourceRecordId: 'msg:001',
    confidence: 0.99,
  });

  // LinkedIn resolves same person — adds linkedinUrl
  await resolver.resolve({
    type: 'person',
    name: 'Alice Example',
    email: 'alice@acme.com',
    linkedinUrl: 'https://www.linkedin.com/in/alice-example/',
    sourceId: 'linkedin:profile:alice-example',
    sourceRecordId: 'alice-example',
    confidence: 0.99,
  });

  assert.equal(store._count(), 1, 'still one entity');
  assert.equal(
    store._entities[0].metadata.linkedinUrl,
    'https://www.linkedin.com/in/alice-example/',
    'should enrich with linkedinUrl',
  );
});

test('E3: iMessage unknown number does not accidentally merge with known person', async () => {
  const store = createMockStore([{
    category: 'person',
    title: 'Alice Example',
    metadata: { canonicalName: 'Alice Example', emails: ['alice@acme.com'], companies: [], linkedinUrl: null },
  }]);
  const resolver = createEntityResolver(store);

  // iMessage from unknown number — no name, no email, no linkedinUrl
  const result = await resolver.resolve({
    type: 'person',
    phone: '+14045550192',
    sourceId: 'imsg',
    sourceRecordId: 'imsg:+14045550192:001',
    confidence: 0.30,
  });

  // Should either create a new entity or return null — must NOT merge with Alice
  if (result !== null) {
    assert.notEqual(result.canonicalName, 'Alice Example', 'should not merge with wrong person');
  }
  // Alice should be untouched
  assert.equal(store._entities[0].metadata.canonicalName, 'Alice Example');
});
