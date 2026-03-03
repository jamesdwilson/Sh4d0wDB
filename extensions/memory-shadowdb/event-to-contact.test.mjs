/**
 * event-to-contact.test.mjs — Unit tests for event-to-contact auto-mapping
 *
 * v0.7.0: when an event record is written, automatically find and tag related contacts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, extractEntitiesFromText, mapEventToContacts } from './dist/event-to-contact.js';

test('extractEntities extracts entity slugs from tags', () => {
  const tags = ['entity:james-wilson', 'domain:civic', 'entity:reece-dewoody'];
  const result = extractEntities(tags);
  assert.deepEqual(result, ['james-wilson', 'reece-dewoody']);
});

test('extractEntities returns empty array for no entity tags', () => {
  const result = extractEntities(['domain:civic', 'loc:tyler-tx']);
  assert.deepEqual(result, []);
});

test('extractEntitiesFromText finds known entities in content', () => {
  const content = 'Meeting with James Wilson and Reece DeWoody about TMM.';
  const known = ['james-wilson', 'reece-dewoody', 'tmm-program'];
  const result = extractEntitiesFromText(content, known);
  assert.ok(result.includes('james-wilson'));
  assert.ok(result.includes('reece-dewoody'));
});

test('extractEntitiesFromText handles hyphenated names with spaces in text', () => {
  const content = 'James Wilson will attend.';
  const known = ['james-wilson'];
  const result = extractEntitiesFromText(content, known);
  assert.ok(result.includes('james-wilson'));
});

test('extractEntitiesFromText dedupes results', () => {
  const content = 'James Wilson James Wilson James Wilson';
  const known = ['james-wilson'];
  const result = extractEntitiesFromText(content, known);
  assert.equal(result.length, 1);
});

test('mapEventToContacts queries for contacts tagged with extracted entities', async () => {
  const eventTags = ['entity:james-wilson'];
  const eventContent = 'Test event';
  const knownEntities = ['james-wilson'];
  const queryFn = async (slug) => {
    if (slug === 'james-wilson') return [{ id: 42 }];
    return [];
  };
  const result = await mapEventToContacts(eventTags, eventContent, knownEntities, queryFn);
  assert.equal(result.length, 1);
  assert.equal(result[0].contactId, 42);
  assert.equal(result[0].entitySlug, 'james-wilson');
});

test('mapEventToContacts returns empty array if no matching contacts', async () => {
  const queryFn = async () => [];
  const result = await mapEventToContacts(['entity:unknown'], '', [], queryFn);
  assert.deepEqual(result, []);
});

test('mapEventToContacts handles multiple entities in event', async () => {
  const eventTags = ['entity:james-wilson', 'entity:reece-dewoody'];
  const queryFn = async (slug) => {
    if (slug === 'james-wilson') return [{ id: 1 }];
    if (slug === 'reece-dewoody') return [{ id: 2 }];
    return [];
  };
  const result = await mapEventToContacts(eventTags, '', [], queryFn);
  assert.equal(result.length, 2);
  assert.ok(result.some(m => m.contactId === 1));
  assert.ok(result.some(m => m.contactId === 2));
});

test('mapEventToContacts does not duplicate contact IDs', async () => {
  const eventTags = ['entity:james-wilson', 'entity:reece-dewoody'];
  const queryFn = async () => [{ id: 1 }]; // Both entities return same contact
  const result = await mapEventToContacts(eventTags, '', [], queryFn);
  // Contact 1 matched twice but should appear only once
  assert.equal(result.length, 1);
});

test('mapEventToContacts respects entity namespace prefix', async () => {
  const eventTags = ['entity:james-wilson', 'domain:civic']; // Only entity: counts
  let queriedSlugs = [];
  const queryFn = async (slug) => {
    queriedSlugs.push(slug);
    return [];
  };
  await mapEventToContacts(eventTags, '', [], queryFn);
  assert.deepEqual(queriedSlugs, ['james-wilson']); // domain: not queried
});
