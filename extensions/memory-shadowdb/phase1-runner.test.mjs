/**
 * phase1-runner.test.mjs — TDD tests for the Gmail ingestion runner
 *
 * The runner orchestrates the full ingestion pipeline:
 *   1. Get watermark (last completed run) from ingestion_runs table
 *   2. Fetch new message IDs via gog gmail search
 *   3. For each message: fetch body → extract → hard-veto → entity filter → LLM score → chunk → store
 *   4. Record run result in ingestion_runs
 *
 * All external dependencies are injected (gog CLI, LLM, store) — pure unit tests.
 *
 * Run with: node --test phase1-runner.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchQuery,
  parseGogSearchResults,
  parseGogMessage,
  shouldIngestMessage,
  buildIngestionRunRecord,
  RunStatus,
} from './dist/phase1-runner.js';

// ============================================================================
// buildSearchQuery
// ============================================================================

test('buildSearchQuery with no watermark returns full history query', () => {
  const q = buildSearchQuery({ watermark: null, account: 'alice@example.com' });
  // No watermark = backfill from beginning; query should not have after: clause
  // but should exclude common noise
  assert.ok(typeof q === 'string');
  assert.ok(!q.includes('after:'), 'no watermark should not restrict by date');
});

test('buildSearchQuery with watermark includes after: date', () => {
  const watermark = new Date('2026-03-01T00:00:00Z');
  const q = buildSearchQuery({ watermark, account: 'alice@example.com' });
  assert.ok(q.includes('after:'), `query should include after: clause, got: ${q}`);
  assert.ok(q.includes('2026'), 'query should include year');
});

test('buildSearchQuery includes additional searchQuery when provided', () => {
  const q = buildSearchQuery({
    watermark: null,
    account: 'alice@example.com',
    searchQuery: 'label:important',
  });
  assert.ok(q.includes('label:important'), 'should include extra search query');
});

test('buildSearchQuery returns a non-empty string', () => {
  const q = buildSearchQuery({ watermark: null, account: 'alice@example.com' });
  assert.ok(q.length > 0);
});

// ============================================================================
// parseGogSearchResults
// ============================================================================

test('parseGogSearchResults extracts thread ids from gog search JSON', () => {
  const gogOutput = JSON.stringify({
    threads: [
      { id: 'thread001', date: '2026-03-07 10:00', from: 'alice@example.com', subject: 'Deal update' },
      { id: 'thread002', date: '2026-03-07 11:00', from: 'bob@example.com',   subject: 'Meeting notes' },
    ],
  });
  const ids = parseGogSearchResults(gogOutput);
  assert.deepEqual(ids, ['thread001', 'thread002']);
});

test('parseGogSearchResults returns empty array for empty threads', () => {
  const gogOutput = JSON.stringify({ threads: [] });
  const ids = parseGogSearchResults(gogOutput);
  assert.deepEqual(ids, []);
});

test('parseGogSearchResults returns empty array on malformed JSON', () => {
  const ids = parseGogSearchResults('not valid json at all {{{}}}');
  assert.deepEqual(ids, []);
});

test('parseGogSearchResults returns empty array when threads key missing', () => {
  const ids = parseGogSearchResults(JSON.stringify({ messages: [] }));
  assert.deepEqual(ids, []);
});

// ============================================================================
// parseGogMessage
// ============================================================================

/** Minimal valid gog gmail get --json output */
function gogMessageFixture({
  id = 'msg001',
  threadId = 'thread001',
  subject = 'Test subject',
  from = 'Alice Example <alice@example.com>',
  date = 'Sat, 07 Mar 2026 10:00:00 -0600',
  body = 'This is the email body about a term sheet.',
} = {}) {
  return JSON.stringify({
    body,
    headers: {},
    message: {
      id,
      threadId,
      internalDate: '1772900000000',
      labelIds: ['INBOX'],
      snippet: body.slice(0, 80),
      sizeEstimate: body.length,
      historyId: '12345',
      payload: {
        headers: [
          { name: 'From',       value: from    },
          { name: 'Subject',    value: subject },
          { name: 'Date',       value: date    },
          { name: 'Message-ID', value: `<${id}@test.example>` },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from(body).toString('base64') },
        parts: [],
      },
    },
  });
}

test('parseGogMessage returns ExtractedContent for valid message', () => {
  const raw = gogMessageFixture({ subject: 'Series A term sheet', body: 'Please review the attached term sheet for $5M.' });
  const result = parseGogMessage(raw);
  assert.ok(result !== null, 'should parse valid message');
  assert.equal(result.subject, 'Series A term sheet');
  assert.ok(result.text.includes('term sheet'));
  assert.equal(result.sourceId, 'msg001');
});

test('parseGogMessage returns null for malformed JSON', () => {
  const result = parseGogMessage('not json {{{}}}');
  assert.equal(result, null);
});

test('parseGogMessage returns null for empty body after extraction', () => {
  // Only quoted content — extractGmailContent returns null
  const raw = gogMessageFixture({ body: '> This is a quoted reply\n> with nothing new' });
  const result = parseGogMessage(raw);
  assert.equal(result, null, 'empty-after-stripping should return null');
});

// ============================================================================
// shouldIngestMessage
// ============================================================================

test('shouldIngestMessage returns false for hard-vetoed transactional content', () => {
  const content = {
    text: 'Your order has been shipped. Tracking number: 1Z999AA10123456784.',
    subject: 'Order Shipped',
    from: 'noreply@shop.example.com',
    date: new Date(),
    sourceId: 'msg001',
    threadId: 'thread001',
    parties: [],
  };
  const result = shouldIngestMessage(content, 5);
  assert.equal(result.ingest, false);
  assert.equal(result.reason, 'entity_filter');
});

test('shouldIngestMessage returns false when LLM score below threshold', () => {
  const content = {
    // Has entity signal (Acme Capital = named entity) so passes entity filter,
    // but LLM scores it low (promo blast disguised as business email)
    text: 'Acme Capital invites you to our annual gala. RSVP by March 15. Free drinks courtesy of our sponsors.',
    subject: 'Annual Gala Invite',
    from: 'events@acmecapital.example.com',
    date: new Date(),
    sourceId: 'msg002',
    threadId: 'thread002',
    parties: [],
  };
  // Score of 3 below threshold of 5
  const result = shouldIngestMessage(content, 5, 3);
  assert.equal(result.ingest, false);
  assert.equal(result.reason, 'score_below_threshold');
});

test('shouldIngestMessage returns true for high-signal business email above threshold', () => {
  const content = {
    text: 'Hi Alice, please review the attached term sheet for our Series A at a $10M pre-money valuation. We would like to close by March 15.',
    subject: 'Series A Term Sheet',
    from: 'Bob Investor <bob@acmecapital.example.com>',
    date: new Date(),
    sourceId: 'msg003',
    threadId: 'thread003',
    parties: ['Bob Investor'],
  };
  // Score of 8, threshold 5
  const result = shouldIngestMessage(content, 5, 8);
  assert.equal(result.ingest, true);
  assert.equal(result.reason, 'passed');
});

test('shouldIngestMessage returns true when score equals threshold exactly', () => {
  const content = {
    text: 'Hi Alice, wanted to follow up on our meeting with Acme Capital about the deal.',
    subject: 'Follow up',
    from: 'charlie@example.com',
    date: new Date(),
    sourceId: 'msg004',
    threadId: 'thread004',
    parties: ['Charlie'],
  };
  const result = shouldIngestMessage(content, 5, 5);
  assert.equal(result.ingest, true, 'score equal to threshold should pass');
});

test('shouldIngestMessage skips entity filter when score provided and text has deal signal', () => {
  // Newsletter with deal content passes entity filter + score >= threshold
  const content = {
    text: 'This week: Andreessen Horowitz closes new $2B fund. Three founders share their Series A lessons.',
    subject: 'VC Weekly',
    from: 'digest@vcnews.example.com',
    date: new Date(),
    sourceId: 'msg005',
    threadId: 'thread005',
    parties: [],
  };
  const result = shouldIngestMessage(content, 5, 6);
  assert.equal(result.ingest, true, 'VC newsletter above threshold should pass');
});

// ============================================================================
// buildIngestionRunRecord
// ============================================================================

test('buildIngestionRunRecord produces correct shape', () => {
  const run = buildIngestionRunRecord({
    source: 'gmail',
    account: 'alice@example.com',
    startedAt: new Date('2026-03-07T22:00:00Z'),
    completedAt: new Date('2026-03-07T22:01:30Z'),
    messagesProcessed: 50,
    messagesIngested: 12,
    messagesSkipped: 38,
    status: RunStatus.COMPLETE,
    watermarkUsed: new Date('2026-03-01T00:00:00Z'),
    newWatermark: new Date('2026-03-07T22:00:00Z'),
  });

  assert.equal(run.source, 'gmail');
  assert.equal(run.account, 'alice@example.com');
  assert.equal(run.messages_processed, 50);
  assert.equal(run.messages_ingested, 12);
  assert.equal(run.messages_skipped, 38);
  assert.equal(run.status, RunStatus.COMPLETE);
  assert.ok(run.started_at instanceof Date);
  assert.ok(run.completed_at instanceof Date);
});

test('buildIngestionRunRecord handles zero messages gracefully', () => {
  const run = buildIngestionRunRecord({
    source: 'gmail',
    account: 'alice@example.com',
    startedAt: new Date(),
    completedAt: new Date(),
    messagesProcessed: 0,
    messagesIngested: 0,
    messagesSkipped: 0,
    status: RunStatus.COMPLETE,
    watermarkUsed: null,
    newWatermark: null,
  });
  assert.equal(run.messages_processed, 0);
  assert.equal(run.status, RunStatus.COMPLETE);
});

test('RunStatus has COMPLETE, PARTIAL, FAILED values', () => {
  assert.ok(RunStatus.COMPLETE);
  assert.ok(RunStatus.PARTIAL);
  assert.ok(RunStatus.FAILED);
});
