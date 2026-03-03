/**
 * event-to-contact.test.mjs — TDD vision: event-to-contact auto-mapping
 *
 * v0.7.0: when an event record is written, automatically find and tag related contacts.
 * Tests written before implementation. All fail until event-to-contact.ts exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// import { mapEventToContacts } from './dist/event-to-contact.js';

test('mapEventToContacts extracts entities from event content', () => {
  assert.ok(false, 'Not yet implemented');
});

test('mapEventToContacts queries for contacts tagged with extracted entities', () => {
  assert.ok(false, 'Not yet implemented');
});

test('mapEventToContacts updates contact metadata with event reference', () => {
  assert.ok(false, 'Not yet implemented');
});

test('mapEventToContacts returns empty array if no matching contacts', () => {
  assert.ok(false, 'Not yet implemented');
});

test('mapEventToContacts handles multiple entities in event', () => {
  assert.ok(false, 'Not yet implemented');
});

test('mapEventToContacts does not duplicate event references', () => {
  assert.ok(false, 'Not yet implemented');
});

test('mapEventToContacts respects entity namespace prefix', () => {
  assert.ok(false, 'Not yet implemented');
});
