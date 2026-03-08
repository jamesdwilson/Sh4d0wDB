/**
 * phase4-edge-wiring.test.mjs — TDD tests for LinkedIn edge signal → EntityResolver wiring
 *
 * When a LinkedIn profile is ingested, extractEdgeSignals() produces EdgeSignal[].
 * Those signals must be fed to EntityResolver.resolve() + EntityResolver.addEdge()
 * automatically as part of the ingestion pipeline.
 *
 * This module tests `processEdgeSignals(signals, resolver)` — the glue function
 * that takes raw EdgeSignal[] and drives the resolver.
 *
 * Design:
 *   - processEdgeSignals is pure pipeline logic — no browser, no DB
 *   - Resolver is injected — tests use a mock
 *   - Fire-and-forget safe — never throws, errors per-signal are swallowed
 *   - Returns summary: { resolved, edges, errors }
 *
 * Run: node --test phase4-edge-wiring.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { processEdgeSignals } from './dist/phase4-edge-wiring.js';

// ============================================================================
// Mock resolver
// ============================================================================

function mockResolver() {
  const resolved = [];
  const edges = [];
  const resolveMap = new Map(); // candidate name → returned entity id

  return {
    resolver: {
      async resolve(candidate) {
        resolved.push(candidate);
        const id = resolveMap.get(candidate.name ?? candidate.companyName) ?? null;
        return id ? { id, canonicalName: candidate.name ?? candidate.companyName, type: candidate.type, aliases: [], emails: [], phones: [], sourceBitmask: 0 } : null;
      },
      async merge() {},
      async addEdge(edge) {
        edges.push(edge);
      },
    },
    resolved,
    edges,
    resolveMap,
  };
}

// ============================================================================
// Fixture signals
// ============================================================================

function makeSignal(overrides = {}) {
  return {
    fromCandidate: {
      type: 'person',
      name: 'Alice Example',
      linkedinUrl: 'https://www.linkedin.com/in/alice-example/',
      sourceId: 'linkedin:profile:alice-example',
      sourceRecordId: 'alice-example',
      confidence: 0.95,
    },
    toCandidate: {
      type: 'company',
      companyName: 'Acme Capital',
      sourceId: 'linkedin:profile:alice-example',
      sourceRecordId: 'alice-example:exp:Acme Capital',
      confidence: 0.95,
    },
    type: 'works_at',
    confidence: 0.95,
    evidenceText: 'VP of Investments at Acme Capital',
    sourceId: 'linkedin:profile:alice-example',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

test('A1: processEdgeSignals resolves fromCandidate and toCandidate for each signal', async () => {
  const { resolver, resolved } = mockResolver();
  const signals = [makeSignal()];

  await processEdgeSignals(signals, resolver);

  assert.ok(resolved.length >= 2, 'should resolve both from and to candidates');
  assert.ok(resolved.some(c => c.name === 'Alice Example'), 'should resolve fromCandidate');
  assert.ok(resolved.some(c => c.companyName === 'Acme Capital'), 'should resolve toCandidate');
});

test('A2: processEdgeSignals calls addEdge when both candidates resolve', async () => {
  const { resolver, edges, resolveMap } = mockResolver();
  resolveMap.set('Alice Example', 10);
  resolveMap.set('Acme Capital', 20);

  await processEdgeSignals([makeSignal()], resolver);

  assert.equal(edges.length, 1, 'should add one edge');
  assert.equal(edges[0].fromId, 10);
  assert.equal(edges[0].toId, 20);
  assert.equal(edges[0].type, 'works_at');
  assert.equal(edges[0].confidence, 0.95);
});

test('A3: processEdgeSignals skips addEdge when fromCandidate does not resolve', async () => {
  const { resolver, edges, resolveMap } = mockResolver();
  // Only toCandidate resolves — from is null
  resolveMap.set('Acme Capital', 20);

  await processEdgeSignals([makeSignal()], resolver);

  assert.equal(edges.length, 0, 'should not add edge when from does not resolve');
});

test('A4: processEdgeSignals skips addEdge when toCandidate does not resolve', async () => {
  const { resolver, edges, resolveMap } = mockResolver();
  // Only fromCandidate resolves — to is null
  resolveMap.set('Alice Example', 10);

  await processEdgeSignals([makeSignal()], resolver);

  assert.equal(edges.length, 0, 'should not add edge when to does not resolve');
});

test('A5: processEdgeSignals handles multiple signals in one call', async () => {
  const { resolver, edges, resolveMap } = mockResolver();
  resolveMap.set('Alice Example', 10);
  resolveMap.set('Acme Capital', 20);
  resolveMap.set('Goldman Sachs', 30);

  const signals = [
    makeSignal({ toCandidate: { type: 'company', companyName: 'Acme Capital', sourceId: 'src', sourceRecordId: 'r1', confidence: 0.9 }, type: 'works_at' }),
    makeSignal({ toCandidate: { type: 'company', companyName: 'Goldman Sachs', sourceId: 'src', sourceRecordId: 'r2', confidence: 0.8 }, type: 'worked_at' }),
  ];

  await processEdgeSignals(signals, resolver);

  assert.equal(edges.length, 2, 'should add one edge per resolved signal pair');
});

test('A6: processEdgeSignals never throws when resolver.resolve() throws', async () => {
  const throwingResolver = {
    async resolve() { throw new Error('DB exploded'); },
    async merge() {},
    async addEdge() {},
  };

  await assert.doesNotReject(async () => {
    await processEdgeSignals([makeSignal()], throwingResolver);
  });
});

test('A7: processEdgeSignals never throws when resolver.addEdge() throws', async () => {
  const { resolver, resolveMap } = mockResolver();
  resolveMap.set('Alice Example', 10);
  resolveMap.set('Acme Capital', 20);
  resolver.addEdge = async () => { throw new Error('edge insert failed'); };

  await assert.doesNotReject(async () => {
    await processEdgeSignals([makeSignal()], resolver);
  });
});

test('A8: processEdgeSignals returns summary with resolved/edges/errors counts', async () => {
  const { resolver, resolveMap } = mockResolver();
  resolveMap.set('Alice Example', 10);
  resolveMap.set('Acme Capital', 20);

  const summary = await processEdgeSignals([makeSignal()], resolver);

  assert.ok(typeof summary.resolved === 'number', 'summary should have resolved count');
  assert.ok(typeof summary.edges === 'number', 'summary should have edges count');
  assert.ok(typeof summary.errors === 'number', 'summary should have errors count');
  assert.equal(summary.edges, 1, 'should report 1 edge added');
});

test('A9: processEdgeSignals returns empty summary for empty signal list', async () => {
  const { resolver } = mockResolver();
  const summary = await processEdgeSignals([], resolver);
  assert.equal(summary.resolved, 0);
  assert.equal(summary.edges, 0);
  assert.equal(summary.errors, 0);
});

test('A10: evidenceText is passed through to addEdge', async () => {
  const { resolver, edges, resolveMap } = mockResolver();
  resolveMap.set('Alice Example', 10);
  resolveMap.set('Acme Capital', 20);

  await processEdgeSignals([makeSignal({ evidenceText: 'VP at Acme since 2022' })], resolver);

  assert.equal(edges[0].evidenceText, 'VP at Acme since 2022');
});
