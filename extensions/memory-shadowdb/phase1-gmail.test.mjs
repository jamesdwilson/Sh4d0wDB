/**
 * phase1-gmail.test.mjs — TDD tests for Phase 1 Gmail ingestion pipeline
 *
 * Tests: extractGmailContent, passesEntityFilter, chunkDocument
 *
 * These are pure unit tests — no network, no DB, no real Gmail API calls.
 * LLM scoring (scoreInterestingness) is covered by contract only — it requires
 * mocking the LLM client which is done in phase1-gmail-integration.test.mjs.
 *
 * Run with: node --test phase1-gmail.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGmailContent,
  passesEntityFilter,
  chunkDocument,
} from './dist/phase1-gmail.js';

// ============================================================================
// Fixtures — realistic Gmail API response shapes (from live gog CLI output)
// ============================================================================

/**
 * Build a minimal Gmail message object (gog CLI --json format).
 * Headers are in payload.headers as {name, value} pairs.
 */
function gmailMessage({
  id = 'abc123',
  threadId = 'thread123',
  subject = 'Test Subject',
  from = 'sender@example.com',
  date = 'Sat, 07 Mar 2026 10:00:00 -0600',
  internalDate = '1772900000000',
  body = 'This is the email body.',
  labelIds = ['INBOX'],
} = {}) {
  return {
    body,
    headers: {},
    message: {
      id,
      threadId,
      internalDate,
      labelIds,
      snippet: body.slice(0, 100),
      sizeEstimate: body.length,
      historyId: '12345',
      payload: {
        headers: [
          { name: 'From',       value: from    },
          { name: 'Subject',    value: subject },
          { name: 'Date',       value: date    },
          { name: 'Message-ID', value: `<${id}@test.com>` },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from(body).toString('base64') },
        parts: [],
      },
    },
  };
}

// ============================================================================
// extractGmailContent
// ============================================================================

test('extractGmailContent returns ExtractedContent with subject, from, date, text', () => {
  const msg = gmailMessage({
    subject: 'Term sheet discussion',
    from: 'partner@sequoia.com',
    body: 'Hi James, please review the attached term sheet for the Series A.',
  });
  const result = extractGmailContent(msg);

  assert.ok(result !== null, 'should return content (not null)');
  assert.equal(result.subject, 'Term sheet discussion');
  assert.equal(result.from, 'partner@sequoia.com');
  assert.ok(result.text.includes('term sheet'), 'text should include body content');
  assert.ok(result.date instanceof Date, 'date should be a Date object');
  assert.equal(result.sourceId, 'abc123');
  assert.equal(result.threadId, 'thread123');
});

test('extractGmailContent strips HTML tags from body', () => {
  const msg = gmailMessage({
    body: '<html><body><p>Hello <b>James</b>, please review the <a href="#">term sheet</a>.</p></body></html>',
  });
  const result = extractGmailContent(msg);

  assert.ok(result !== null);
  assert.ok(!result.text.includes('<b>'), 'should strip HTML tags');
  assert.ok(!result.text.includes('<a href'), 'should strip HTML attributes');
  assert.ok(result.text.includes('James'), 'should preserve text content');
  assert.ok(result.text.includes('term sheet'), 'should preserve text content');
});

test('extractGmailContent strips quoted reply sections (lines starting with >)', () => {
  const body = `Hi James,

Let's meet at 3pm to discuss the deal.

On Fri, Mar 6, 2026, Alice Example wrote:
> Can we meet tomorrow?
> I want to discuss the Series A.
>
> Thanks,
> James`;

  const msg = gmailMessage({ body });
  const result = extractGmailContent(msg);

  assert.ok(result !== null);
  assert.ok(!result.text.includes('Can we meet tomorrow'), 'should strip quoted reply');
  assert.ok(result.text.includes("Let's meet at 3pm"), 'should preserve new content');
});

test('extractGmailContent strips common email footers', () => {
  const body = `Hi James, let's close the deal next week.

--
Sent from my iPhone

Unsubscribe from these emails | View in browser`;

  const msg = gmailMessage({ body });
  const result = extractGmailContent(msg);

  assert.ok(result !== null);
  assert.ok(!result.text.includes('Sent from my iPhone'), 'should strip iPhone footer');
  assert.ok(!result.text.includes('Unsubscribe'), 'should strip unsubscribe footer');
  assert.ok(result.text.includes("let's close the deal"), 'should preserve real content');
});

test('extractGmailContent returns null for empty body after stripping', () => {
  const msg = gmailMessage({
    body: '> This is just a quoted reply\n> with nothing new',
  });
  const result = extractGmailContent(msg);
  // After stripping quoted lines, body is empty → null
  assert.equal(result, null, 'should return null for effectively empty message');
});

test('extractGmailContent parses internalDate as fallback when Date header is missing', () => {
  const msg = gmailMessage({ date: '', internalDate: '1772900000000' });
  // Remove the Date header
  msg.message.payload.headers = msg.message.payload.headers.filter(h => h.name !== 'Date');
  const result = extractGmailContent(msg);
  assert.ok(result !== null);
  assert.ok(result.date instanceof Date, 'should parse internalDate as fallback');
  assert.ok(result.date.getTime() > 0, 'date should be valid');
});

test('extractGmailContent extracts party names from From header', () => {
  const msg = gmailMessage({ from: 'John Smith <john.smith@sequoia.com>' });
  const result = extractGmailContent(msg);
  assert.ok(result !== null);
  assert.ok(result.parties.includes('John Smith') || result.parties.length > 0,
    'should extract party name from From header');
});

// ============================================================================
// passesEntityFilter
// ============================================================================

test('passesEntityFilter returns true for text with a named company', () => {
  assert.equal(
    passesEntityFilter('We met with Sequoia Capital to discuss the investment.'),
    true,
  );
});

test('passesEntityFilter returns true for text with a dollar amount', () => {
  assert.equal(
    passesEntityFilter('The term sheet is for $2,000,000 at a $10M valuation.'),
    true,
  );
});

test('passesEntityFilter returns true for text with a date reference', () => {
  assert.equal(
    passesEntityFilter('Please sign the agreement by March 15, 2026.'),
    true,
  );
});

test('passesEntityFilter returns true for text with commitment verbs', () => {
  assert.equal(
    passesEntityFilter('We agree to provide the funding by end of quarter.'),
    true,
  );
  assert.equal(
    passesEntityFilter('The company shall maintain a board seat for investors.'),
    true,
  );
});

test('passesEntityFilter returns true for text with a named person', () => {
  assert.equal(
    passesEntityFilter('Hi James, I wanted to follow up with you about the deal.'),
    true,
  );
});

test('passesEntityFilter returns false for purely transactional/spam content', () => {
  assert.equal(
    passesEntityFilter('Your order has been shipped. Track your package at ups.com.'),
    false,
  );
});

test('passesEntityFilter returns false for empty string', () => {
  assert.equal(passesEntityFilter(''), false);
});

test('passesEntityFilter returns true for newsletter/industry digest (passes to LLM gate)', () => {
  // Newsletters are NOT hard-vetoed — they pass to scoreInterestingness()
  // A VC digest or founder newsletter is worth scoring; the LLM decides keep/drop
  assert.equal(
    passesEntityFilter('This week in venture: Andreessen Horowitz led a $50M Series B for Acme AI. Three things founders should know about the current fundraising climate.'),
    true,
  );
});

test('passesEntityFilter returns false for hard-vetoed shipping notification', () => {
  assert.equal(
    passesEntityFilter('Your order has been shipped. Tracking number: 1Z999AA10123456784. Estimated delivery: March 10.'),
    false,
  );
});

test('passesEntityFilter returns false for hard-vetoed order confirmation', () => {
  assert.equal(
    passesEntityFilter('Order confirmation #98765. Thank you for your purchase. Your order is being processed.'),
    false,
  );
});

test('passesEntityFilter returns false for hard-vetoed auth code email', () => {
  assert.equal(
    passesEntityFilter('Your verification code is 847291. This code expires in 10 minutes. Do not share it.'),
    false,
  );
});

test('passesEntityFilter: retail receipt is hard-vetoed (never reaches LLM gate)', () => {
  // Receipts match TRANSACTIONAL_VETO_PATTERNS unconditionally — even with a
  // dollar amount, they are dropped before scoreInterestingness() is called.
  assert.equal(
    passesEntityFilter('Your receipt #12345. Total: $45.99. Thank you for your purchase.'),
    false,  // hard-vetoed by transactional pattern
  );
});

test('passesEntityFilter returns true for text with an email address (potential contact)', () => {
  assert.equal(
    passesEntityFilter('Please cc partner@example.com on all future communications.'),
    true,
  );
});

// ============================================================================
// chunkDocument
// ============================================================================

function extractedContent({
  text = 'Hello world.',
  subject = 'Test',
  from = 'test@example.com',
  date = new Date(),
  sourceId = 'msg123',
  threadId = 'thread123',
  parties = [],
} = {}) {
  return { text, subject, from, date, sourceId, threadId, parties };
}

test('chunkDocument returns single chunk for short text (≤ maxTokens)', () => {
  const content = extractedContent({ text: 'Short email body. Very concise.' });
  const chunks = chunkDocument(content, 400);
  assert.equal(chunks.length, 1, 'short text should produce one chunk');
});

test('chunkDocument returns multiple chunks for long text', () => {
  // ~2000 word document — should split into multiple chunks
  const longText = Array.from({ length: 100 }, (_, i) =>
    `Paragraph ${i}: This is a sentence about venture capital, term sheets, and investment agreements between parties.`
  ).join('\n\n');
  const content = extractedContent({ text: longText });
  const chunks = chunkDocument(content, 400);
  assert.ok(chunks.length > 1, `long text should produce multiple chunks, got ${chunks.length}`);
});

test('chunkDocument preserves sourceId and threadId on every chunk', () => {
  const longText = Array.from({ length: 50 }, (_, i) =>
    `Paragraph ${i}: Content about deals and investments.`
  ).join('\n\n');
  const content = extractedContent({ text: longText, sourceId: 'msg-abc', threadId: 'thread-xyz' });
  const chunks = chunkDocument(content, 400);
  for (const chunk of chunks) {
    assert.equal(chunk.sourceId, 'msg-abc', 'each chunk should have sourceId');
    assert.equal(chunk.threadId, 'thread-xyz', 'each chunk should have threadId');
  }
});

test('chunkDocument assigns sequential chunkIndex to each chunk', () => {
  const longText = Array.from({ length: 80 }, (_, i) =>
    `Sentence ${i} about investment terms and deal structures.`
  ).join(' ');
  const content = extractedContent({ text: longText });
  const chunks = chunkDocument(content, 100);
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.chunkIndex, i, `chunk ${i} should have chunkIndex=${i}`);
  });
});

test('chunkDocument sets chunkTotal correctly on all chunks', () => {
  const longText = Array.from({ length: 80 }, (_, i) =>
    `Sentence ${i} about investment terms and deal structures.`
  ).join(' ');
  const content = extractedContent({ text: longText });
  const chunks = chunkDocument(content, 100);
  const total = chunks.length;
  for (const chunk of chunks) {
    assert.equal(chunk.chunkTotal, total, 'chunkTotal should match array length');
  }
});

test('chunkDocument each chunk text does not exceed maxTokens * 6 chars (rough token bound)', () => {
  const longText = Array.from({ length: 200 }, (_, i) =>
    `Word ${i} investment venture capital term sheet agreement.`
  ).join(' ');
  const content = extractedContent({ text: longText });
  const maxTokens = 400;
  const chunks = chunkDocument(content, maxTokens);
  for (const chunk of chunks) {
    // Rough token estimate: 1 token ≈ 4 chars; give 50% headroom
    assert.ok(chunk.text.length <= maxTokens * 6,
      `chunk text length ${chunk.text.length} exceeds rough limit ${maxTokens * 6}`);
  }
});

test('chunkDocument returns array of DocumentChunk objects with required fields', () => {
  const content = extractedContent({ text: 'A short email about the Series A term sheet.' });
  const chunks = chunkDocument(content);
  assert.ok(chunks.length >= 1);
  const chunk = chunks[0];
  assert.ok(typeof chunk.text === 'string', 'chunk.text must be string');
  assert.ok(typeof chunk.chunkIndex === 'number', 'chunk.chunkIndex must be number');
  assert.ok(typeof chunk.chunkTotal === 'number', 'chunk.chunkTotal must be number');
  assert.ok(typeof chunk.sourceId === 'string', 'chunk.sourceId must be string');
  assert.ok(typeof chunk.threadId === 'string', 'chunk.threadId must be string');
  assert.ok(chunk.date instanceof Date, 'chunk.date must be Date');
});

test('chunkDocument handles empty text gracefully — returns empty array', () => {
  const content = extractedContent({ text: '' });
  const chunks = chunkDocument(content);
  assert.deepEqual(chunks, [], 'empty text should return empty array');
});
