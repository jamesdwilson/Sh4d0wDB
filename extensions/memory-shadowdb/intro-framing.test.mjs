/**
 * intro-framing.test.mjs — Unit tests for intro framing suggestions
 *
 * v0.7.0: use affinity + friction data to suggest how to frame an introduction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestIntroFraming } from './dist/intro-framing.js';

function edge(entity_a, entity_b, affinity_score, friction_risks = null) {
  return {
    id: 1,
    content: `${entity_a} — ${entity_b}`,
    tags: [`entity:${entity_a}`, `entity:${entity_b}`],
    metadata: { entity_a, entity_b, affinity_score, friction_risks },
  };
}

test('suggestIntroFraming returns natural fit framing for high affinity', () => {
  const edges = [edge('alice', 'bob', 85)];
  const result = suggestIntroFraming('alice', 'bob', edges);
  assert.equal(result.tier, 'natural-fit');
  assert.ok(result.framing.includes('Natural fit'));
  assert.ok(result.affinity === 85);
});

test('suggestIntroFraming returns workable framing for medium affinity', () => {
  const edges = [edge('alice', 'bob', 65)];
  const result = suggestIntroFraming('alice', 'bob', edges);
  assert.equal(result.tier, 'workable');
  assert.ok(result.framing.includes('Workable'));
});

test('suggestIntroFraming returns caution framing for friction risk', () => {
  const edges = [edge('alice', 'bob', 35)];
  const result = suggestIntroFraming('alice', 'bob', edges);
  assert.equal(result.tier, 'caution');
  assert.ok(result.framing.includes('Caution'));
});

test('suggestIntroFraming returns not recommended for avoid affinity', () => {
  const edges = [edge('alice', 'bob', 15)];
  const result = suggestIntroFraming('alice', 'bob', edges);
  assert.equal(result.tier, 'avoid');
  assert.ok(result.framing.includes('Not recommended'));
});

test('suggestIntroFraming incorporates friction_risks from edge metadata', () => {
  const edges = [edge('alice', 'bob', 40, 'competitive history, value divergence')];
  const result = suggestIntroFraming('alice', 'bob', edges);
  assert.ok(result.risks.length > 0);
  assert.ok(result.risks[0].includes('competitive'));
});

test('suggestIntroFraming uses psych profiles to refine framing', () => {
  const edges = [edge('alice', 'bob', 70)];
  const profiles = {
    alice: { voss_type: 'Analyst' },
  };
  const result = suggestIntroFraming('alice', 'bob', edges, profiles);
  assert.ok(result.suggestions.some(s => s.includes('credentials')));
});

test('suggestIntroFraming handles missing data gracefully', () => {
  const result = suggestIntroFraming('alice', 'bob', []);
  assert.equal(result.tier, 'workable'); // Default affinity 50
  assert.equal(result.affinity, 50);
});

test('suggestIntroFraming returns specific framing text, not just category', () => {
  const edges = [edge('alice', 'bob', 90)];
  const result = suggestIntroFraming('alice', 'bob', edges);
  assert.ok(result.framing.length > 20, 'framing should be detailed');
  assert.ok(result.suggestions.length > 0, 'should have suggestions');
});
