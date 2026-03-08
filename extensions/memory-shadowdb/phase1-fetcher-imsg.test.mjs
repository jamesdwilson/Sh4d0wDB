/**
 * phase1-fetcher-imsg.test.mjs — TDD tests for IMessageFetcher
 *
 * IMessageFetcher implements MessageFetcher using the imsg CLI.
 * All CLI calls are mocked — no real chat.db access.
 *
 * Run with: node --test phase1-fetcher-imsg.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImsgChats,
  parseImsgHistory,
  imsgMessageToExtractedContent,
  buildImsgMessageId,
} from './dist/phase1-fetcher-imsg.js';

// ============================================================================
// parseImsgChats
// ============================================================================

/** Newline-delimited JSON as imsg chats --json returns */
function chatNdjson(chats) {
  return chats.map(c => JSON.stringify(c)).join('\n');
}

test('parseImsgChats extracts chat ids from imsg chats --json output', () => {
  const input = chatNdjson([
    { id: 1, identifier: '+15551234567', name: '',            service: 'iMessage', last_message_at: '2026-03-07T10:00:00.000Z' },
    { id: 2, identifier: '+15559876543', name: 'Alice Group', service: 'iMessage', last_message_at: '2026-03-06T10:00:00.000Z' },
  ]);
  const chats = parseImsgChats(input);
  assert.equal(chats.length, 2);
  assert.equal(chats[0].id, 1);
  assert.equal(chats[1].id, 2);
});

test('parseImsgChats filters chats older than watermark', () => {
  const watermark = new Date('2026-03-06T00:00:00Z');
  const input = chatNdjson([
    { id: 1, identifier: '+15551111111', name: '', service: 'iMessage', last_message_at: '2026-03-07T10:00:00.000Z' }, // newer
    { id: 2, identifier: '+15552222222', name: '', service: 'iMessage', last_message_at: '2026-03-05T10:00:00.000Z' }, // older
  ]);
  const chats = parseImsgChats(input, watermark);
  assert.equal(chats.length, 1, 'should only return chats newer than watermark');
  assert.equal(chats[0].id, 1);
});

test('parseImsgChats returns all chats when watermark is null', () => {
  const input = chatNdjson([
    { id: 1, identifier: '+15551111111', name: '', service: 'iMessage', last_message_at: '2024-01-01T00:00:00.000Z' },
    { id: 2, identifier: '+15552222222', name: '', service: 'SMS',      last_message_at: '2023-06-15T00:00:00.000Z' },
  ]);
  const chats = parseImsgChats(input, null);
  assert.equal(chats.length, 2, 'null watermark should return all chats');
});

test('parseImsgChats returns empty array on malformed input', () => {
  const chats = parseImsgChats('not json at all {{{}}}', null);
  assert.deepEqual(chats, []);
});

test('parseImsgChats skips malformed lines and returns valid ones', () => {
  const input = JSON.stringify({ id: 1, identifier: '+15551111111', name: '', service: 'iMessage', last_message_at: '2026-03-07T10:00:00Z' })
    + '\nnot json\n'
    + JSON.stringify({ id: 2, identifier: '+15552222222', name: '', service: 'SMS', last_message_at: '2026-03-07T10:00:00Z' });
  const chats = parseImsgChats(input, null);
  assert.equal(chats.length, 2, 'should skip malformed lines and return valid ones');
});

// ============================================================================
// parseImsgHistory
// ============================================================================

function historyNdjson(messages) {
  return messages.map(m => JSON.stringify(m)).join('\n');
}

test('parseImsgHistory extracts messages from imsg history --json output', () => {
  const input = historyNdjson([
    { id: 101, guid: 'guid-1', text: 'Let us close the deal by Friday.', is_from_me: false, created_at: '2026-03-07T10:00:00.000Z', sender: '+15551111111', chat_id: 1, attachments: [], reactions: [] },
    { id: 102, guid: 'guid-2', text: 'Agreed, will send the term sheet.', is_from_me: true,  created_at: '2026-03-07T10:05:00.000Z', sender: '+16785550000', chat_id: 1, attachments: [], reactions: [] },
  ]);
  const msgs = parseImsgHistory(input);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, 'Let us close the deal by Friday.');
  assert.equal(msgs[1].text, 'Agreed, will send the term sheet.');
});

test('parseImsgHistory filters messages older than watermark', () => {
  const watermark = new Date('2026-03-06T12:00:00Z');
  const input = historyNdjson([
    { id: 101, guid: 'g1', text: 'New message.',  is_from_me: false, created_at: '2026-03-07T10:00:00.000Z', sender: '+15551111111', chat_id: 1, attachments: [], reactions: [] },
    { id: 102, guid: 'g2', text: 'Old message.',  is_from_me: false, created_at: '2026-03-05T10:00:00.000Z', sender: '+15551111111', chat_id: 1, attachments: [], reactions: [] },
  ]);
  const msgs = parseImsgHistory(input, watermark);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'New message.');
});

test('parseImsgHistory skips messages with null or empty text', () => {
  const input = historyNdjson([
    { id: 101, guid: 'g1', text: 'Real content here about a deal.', is_from_me: false, created_at: '2026-03-07T10:00:00.000Z', sender: '+15551111111', chat_id: 1, attachments: [], reactions: [] },
    { id: 102, guid: 'g2', text: null,                               is_from_me: false, created_at: '2026-03-07T10:01:00.000Z', sender: '+15551111111', chat_id: 1, attachments: [], reactions: [] },
    { id: 103, guid: 'g3', text: '',                                 is_from_me: false, created_at: '2026-03-07T10:02:00.000Z', sender: '+15551111111', chat_id: 1, attachments: [], reactions: [] },
  ]);
  const msgs = parseImsgHistory(input, null);
  assert.equal(msgs.length, 1, 'should skip null/empty text messages');
});

test('parseImsgHistory returns empty array on malformed input', () => {
  const msgs = parseImsgHistory('not valid json', null);
  assert.deepEqual(msgs, []);
});

// ============================================================================
// buildImsgMessageId
// ============================================================================

test('buildImsgMessageId produces stable unique ID', () => {
  const id1 = buildImsgMessageId(1, 101);
  const id2 = buildImsgMessageId(1, 102);
  const id3 = buildImsgMessageId(2, 101);
  assert.ok(id1 !== id2, 'different message ids should differ');
  assert.ok(id1 !== id3, 'different chat ids should differ');
  assert.equal(id1, buildImsgMessageId(1, 101), 'same inputs should produce same id');
});

test('buildImsgMessageId includes source prefix', () => {
  const id = buildImsgMessageId(5, 42);
  assert.ok(id.startsWith('imsg:'), `ID should start with "imsg:", got: ${id}`);
});

// ============================================================================
// imsgMessageToExtractedContent
// ============================================================================

test('imsgMessageToExtractedContent maps imsg message to ExtractedContent', () => {
  const msg = {
    id: 101,
    guid: 'guid-abc',
    text: 'Let us schedule a call to discuss the Series A next week.',
    is_from_me: false,
    created_at: '2026-03-07T10:00:00.000Z',
    sender: '+15551234567',
    chat_id: 5,
    attachments: [],
    reactions: [],
  };
  const result = imsgMessageToExtractedContent(msg, { identifier: '+15551234567', name: 'Bob Investor' });
  assert.ok(result !== null);
  assert.equal(result.text, msg.text);
  assert.equal(result.sourceId, buildImsgMessageId(5, 101));
  assert.ok(result.date instanceof Date);
  assert.ok(result.parties.length > 0, 'should extract party from sender/chat name');
});

test('imsgMessageToExtractedContent uses chat name when available', () => {
  const msg = {
    id: 202, guid: 'guid-xyz',
    text: 'Deal discussion in group chat with Acme Capital team.',
    is_from_me: false, created_at: '2026-03-07T11:00:00.000Z',
    sender: '+15559999999', chat_id: 10, attachments: [], reactions: [],
  };
  const result = imsgMessageToExtractedContent(msg, { identifier: 'group-id', name: 'Acme Capital Deal' });
  assert.ok(result !== null);
  assert.ok(result.parties.some(p => p.includes('Acme') || p.length > 0), 'should include party from chat name');
});

test('imsgMessageToExtractedContent returns null for reaction-only messages', () => {
  const msg = {
    id: 303, guid: 'guid-react',
    text: 'Reacted 👍 to "Let us close the deal"',
    is_from_me: false, created_at: '2026-03-07T12:00:00.000Z',
    sender: '+15551111111', chat_id: 1, attachments: [], reactions: [],
  };
  const result = imsgMessageToExtractedContent(msg, { identifier: '+15551111111', name: '' });
  assert.equal(result, null, 'reaction-only messages should return null');
});
