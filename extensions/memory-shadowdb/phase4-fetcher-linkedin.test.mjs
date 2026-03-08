/**
 * phase4-fetcher-linkedin.test.mjs — TDD tests for LinkedIn message ingestion
 *
 * Tests the LinkedIn fetcher described in INTELLIGENCE_ROADMAP.md § Phase 4.
 *
 * Key design decisions reflected in these tests:
 *   - BrowserClient is injected — tests use mock HTML, never hit real LinkedIn
 *   - parseThreadList and parseThreadMessages are PURE functions — unit testable
 *     with fixture HTML that matches real LinkedIn DOM selectors (verified 2026-03-08)
 *   - threadId comes from the URL, not from DOM attributes (LinkedIn uses no data-urn)
 *   - Timestamps in LinkedIn are relative text ("Mar 7", "4:24 AM", "Wednesday")
 *     so we parse best-effort and fall back to fetchedAt when unparseable
 *   - Thread content = all messages concatenated with sender attribution
 *   - LinkedInFetcher implements MessageFetcher — fits existing runner unchanged
 *
 * Real LinkedIn DOM selectors (verified against live page 2026-03-08):
 *   Thread list items:  li.msg-conversation-listitem
 *   Participant names:  .msg-conversation-listitem__participant-names
 *   Timestamp:          time.msg-conversation-listitem__time-stamp
 *   Snippet:            .msg-conversation-card__message-snippet
 *   Message groups:     li.msg-s-message-list__event
 *   Sender name:        .msg-s-message-group__name
 *   Message timestamp:  time.msg-s-message-group__timestamp
 *   Message body:       .msg-s-event-listitem__body p
 *   Thread URL:         window.location.href (changes on thread click)
 *
 * Test groups:
 *   A — parseThreadList (pure, fixture HTML)
 *   B — parseThreadMessages (pure, fixture HTML)
 *   C — threadToExtractedContent (pure, no HTML)
 *   D — LinkedInFetcher.getNewMessageIds (mock browser)
 *   E — LinkedInFetcher.fetchMessage (mock browser)
 *
 * Run: node --test phase4-fetcher-linkedin.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseThreadList,
  parseThreadMessages,
  threadToExtractedContent,
  LinkedInFetcher,
} from './dist/phase4-fetcher-linkedin.js';

// ============================================================================
// Fixture HTML — matches real LinkedIn DOM (verified 2026-03-08)
// ============================================================================

/**
 * Minimal inbox HTML with two thread list items.
 * Selectors: li.msg-conversation-listitem > .msg-conversation-listitem__participant-names
 *            time.msg-conversation-listitem__time-stamp
 *            .msg-conversation-card__message-snippet
 *
 * threadId comes from the data-thread-id attribute we inject on the <li>
 * (fetcher sets this by navigating to each thread and reading window.location.href)
 */
const INBOX_HTML = `
<ul aria-label="Conversation List">
  <li class="ember-view scaffold-layout__list-item msg-conversation-listitem msg-conversations-container__convo-item"
      data-thread-id="2-abc123XYZ">
    <div class="msg-conversation-card">
      <div class="msg-conversation-listitem__link" tabindex="0">
        <span class="msg-conversation-listitem__participant-names">
          Alice Example
        </span>
        <time class="msg-conversation-listitem__time-stamp t-14 t-black t-normal msg-conversation-card__time-stamp">
          Mar 7
        </time>
        <div class="msg-conversation-card__message-snippet">
          Alice: Looking forward to discussing the term sheet details.
        </div>
      </div>
    </div>
  </li>
  <li class="ember-view scaffold-layout__list-item msg-conversation-listitem msg-conversations-container__convo-item"
      data-thread-id="2-def456ABC">
    <div class="msg-conversation-card">
      <div class="msg-conversation-listitem__link" tabindex="0">
        <span class="msg-conversation-listitem__participant-names">
          Bob Investor
        </span>
        <time class="msg-conversation-listitem__time-stamp t-14 t-black t-normal msg-conversation-card__time-stamp">
          Mar 5
        </time>
        <div class="msg-conversation-card__message-snippet">
          You: Before we could evaluate fit, I'd need to see the deck.
        </div>
      </div>
    </div>
  </li>
</ul>
`;

/** Inbox with no threads */
const EMPTY_INBOX_HTML = `
<ul aria-label="Conversation List">
</ul>
`;

/** Inbox with a thread missing a timestamp (malformed) */
const MALFORMED_THREAD_HTML = `
<ul aria-label="Conversation List">
  <li class="ember-view scaffold-layout__list-item msg-conversation-listitem"
      data-thread-id="2-malformed">
    <div class="msg-conversation-card">
      <div class="msg-conversation-listitem__link" tabindex="0">
        <span class="msg-conversation-listitem__participant-names">Carol Missing</span>
        <!-- no time element -->
      </div>
    </div>
  </li>
</ul>
`;

/**
 * Thread detail page HTML.
 * Selectors: li.msg-s-message-list__event
 *            .msg-s-message-group__name
 *            time.msg-s-message-group__timestamp
 *            .msg-s-event-listitem__body p
 */
const THREAD_HTML = `
<div class="msg-s-message-list-container">
  <ul class="msg-s-message-list">
    <li class="msg-s-message-list__event clearfix">
      <div class="msg-s-message-group__meta">
        <span class="msg-s-message-group__name t-14 t-black t-bold">Alice Example</span>
        <time class="msg-s-message-group__timestamp white-space-nowrap t-12 t-black--light t-normal">
          4:24 AM
        </time>
      </div>
      <ul class="msg-s-message-list__events">
        <li class="msg-s-event-listitem msg-s-event-listitem--m2m-msg">
          <div class="msg-s-event-listitem__body">
            <p>Hi James, looking forward to discussing the Series A term sheet. We value the opportunity to partner with you on this round.</p>
          </div>
        </li>
      </ul>
    </li>
    <li class="msg-s-message-list__event clearfix">
      <div class="msg-s-message-group__meta">
        <span class="msg-s-message-group__name t-14 t-black t-bold">James D. Wilson</span>
        <time class="msg-s-message-group__timestamp white-space-nowrap t-12 t-black--light t-normal">
          9:05 AM
        </time>
      </div>
      <ul class="msg-s-message-list__events">
        <li class="msg-s-event-listitem msg-s-event-listitem--m2m-msg">
          <div class="msg-s-event-listitem__body">
            <p>Thanks Alice. Please send over the full term sheet and we'll review it internally.</p>
          </div>
        </li>
      </ul>
    </li>
  </ul>
</div>
`;

/** Thread page with no messages */
const EMPTY_THREAD_HTML = `
<div class="msg-s-message-list-container">
  <ul class="msg-s-message-list">
  </ul>
</div>
`;

/** Thread page with one message whose body is empty (should be filtered) */
const EMPTY_BODY_THREAD_HTML = `
<div class="msg-s-message-list-container">
  <ul class="msg-s-message-list">
    <li class="msg-s-message-list__event clearfix">
      <div class="msg-s-message-group__meta">
        <span class="msg-s-message-group__name t-14 t-black t-bold">Alice Example</span>
        <time class="msg-s-message-group__timestamp white-space-nowrap t-12 t-black--light t-normal">4:24 AM</time>
      </div>
      <ul class="msg-s-message-list__events">
        <li class="msg-s-event-listitem">
          <div class="msg-s-event-listitem__body">
            <p>   </p>
          </div>
        </li>
      </ul>
    </li>
  </ul>
</div>
`;

// ============================================================================
// Mock BrowserClient
// ============================================================================

/**
 * Build a mock BrowserClient that returns pre-configured HTML per URL.
 * The fetcher navigates to URLs; the mock returns the mapped HTML.
 *
 * @param {Record<string, string>} urlToHtml - URL pattern → HTML to return
 * @param {string[]} [threadUrls]            - URLs returned when navigating to /messaging/
 */
function mockBrowser(urlToHtml = {}, threadUrls = []) {
  let currentUrl = 'https://www.linkedin.com/messaging/';
  const navigations = [];

  return {
    browser: {
      navigate: async (url) => {
        navigations.push(url);
        currentUrl = url;
      },
      getPageSource: async () => {
        // Match by partial URL
        for (const [pattern, html] of Object.entries(urlToHtml)) {
          if (currentUrl.includes(pattern)) return html;
        }
        return '<html><body></body></html>';
      },
      getCurrentUrl: async () => currentUrl,
      waitForSelector: async (_sel, _ms) => {},
      scrollToBottom: async () => {},
    },
    navigations,
  };
}

// ============================================================================
// Group A — parseThreadList (pure, fixture HTML)
// ============================================================================

test('A1: parseThreadList extracts threadId from data-thread-id attribute', () => {
  // The fetcher sets data-thread-id on each li via JS evaluation before calling getPageSource.
  // This allows pure HTML parsing without clicking through each thread.
  const threads = parseThreadList(INBOX_HTML);
  assert.ok(threads.length > 0, 'should parse at least one thread');
  assert.equal(threads[0].threadId, '2-abc123XYZ');
});

test('A2: parseThreadList extracts participant names', () => {
  const threads = parseThreadList(INBOX_HTML);
  assert.ok(threads[0].participants.includes('Alice Example'), 'should include participant name');
});

test('A3: parseThreadList extracts lastMessageAt timestamp text', () => {
  // Timestamps are relative text ("Mar 7", "4:24 AM") — stored as raw text,
  // parsed best-effort into a Date relative to the current year.
  const threads = parseThreadList(INBOX_HTML);
  assert.ok(threads[0].lastMessageAt instanceof Date, 'lastMessageAt should be a Date');
});

test('A4: parseThreadList extracts snippet text', () => {
  const threads = parseThreadList(INBOX_HTML);
  assert.ok(
    threads[0].snippet.includes('term sheet') || threads[0].snippet.length > 0,
    'should extract snippet text',
  );
});

test('A5: parseThreadList returns empty array for empty inbox HTML', () => {
  const threads = parseThreadList(EMPTY_INBOX_HTML);
  assert.equal(threads.length, 0);
});

test('A6: parseThreadList skips threads with missing timestamps — never throws', () => {
  // Missing <time> element = use current date as fallback, don't crash.
  let threads;
  assert.doesNotThrow(() => {
    threads = parseThreadList(MALFORMED_THREAD_HTML);
  });
  assert.ok(Array.isArray(threads), 'should still return an array');
  // The malformed thread may be included with a fallback date, or skipped — both are OK
});

test('A7: parseThreadList handles multiple threads in one inbox page', () => {
  const threads = parseThreadList(INBOX_HTML);
  assert.equal(threads.length, 2, 'should parse both threads');
  assert.equal(threads[0].threadId, '2-abc123XYZ');
  assert.equal(threads[1].threadId, '2-def456ABC');
});

// ============================================================================
// Group B — parseThreadMessages (pure, fixture HTML)
// ============================================================================

test('B1: parseThreadMessages extracts all messages from a thread page', () => {
  const content = parseThreadMessages(THREAD_HTML, '2-abc123XYZ');
  assert.ok(content !== null, 'should return content');
  assert.equal(content.messages.length, 2, 'should extract 2 messages');
});

test('B2: Each message has sender, sentAt, and text', () => {
  const content = parseThreadMessages(THREAD_HTML, '2-abc123XYZ');
  assert.ok(content !== null);
  const msg = content.messages[0];
  assert.ok(typeof msg.sender === 'string' && msg.sender.length > 0, 'message should have sender');
  assert.ok(msg.sentAt instanceof Date, 'message should have sentAt Date');
  assert.ok(typeof msg.text === 'string' && msg.text.length > 0, 'message should have text');
});

test('B3: parseThreadMessages returns null for empty/missing thread HTML', () => {
  const content = parseThreadMessages(EMPTY_THREAD_HTML, '2-abc123XYZ');
  assert.equal(content, null, 'empty thread should return null');
});

test('B4: parseThreadMessages filters out empty message bodies', () => {
  // Whitespace-only body paragraphs should not be included as messages.
  const content = parseThreadMessages(EMPTY_BODY_THREAD_HTML, '2-abc123XYZ');
  assert.equal(content, null, 'thread with only empty bodies should return null');
});

test('B5: parseThreadMessages handles single-message thread', () => {
  const singleMsgHtml = `
    <ul class="msg-s-message-list">
      <li class="msg-s-message-list__event clearfix">
        <div class="msg-s-message-group__meta">
          <span class="msg-s-message-group__name t-14 t-black t-bold">Alice Example</span>
          <time class="msg-s-message-group__timestamp white-space-nowrap t-12 t-black--light t-normal">3:00 PM</time>
        </div>
        <ul class="msg-s-message-list__events">
          <li class="msg-s-event-listitem">
            <div class="msg-s-event-listitem__body">
              <p>Interested in discussing the investment opportunity with you.</p>
            </div>
          </li>
        </ul>
      </li>
    </ul>`;
  const content = parseThreadMessages(singleMsgHtml, '2-single');
  assert.ok(content !== null);
  assert.equal(content.messages.length, 1);
  assert.ok(content.messages[0].text.includes('investment opportunity'));
});

// ============================================================================
// Group C — threadToExtractedContent (pure)
// ============================================================================

function makeThread(overrides = {}) {
  return {
    threadId: '2-abc123XYZ',
    url: 'https://www.linkedin.com/messaging/thread/2-abc123XYZ/',
    participants: ['Alice Example', 'James D. Wilson'],
    messages: [
      {
        sender: 'Alice Example',
        sentAt: new Date('2026-03-07T04:24:00Z'),
        text: 'Hi James, looking forward to discussing the Series A term sheet.',
      },
      {
        sender: 'James D. Wilson',
        sentAt: new Date('2026-03-07T09:05:00Z'),
        text: 'Thanks Alice. Please send over the full term sheet.',
      },
    ],
    fetchedAt: new Date('2026-03-08T00:00:00Z'),
    ...overrides,
  };
}

test('C1: threadToExtractedContent concatenates all messages with sender attribution', () => {
  const content = threadToExtractedContent(makeThread());
  assert.ok(content !== null);
  assert.ok(content.text.includes('Alice Example'), 'text should include sender name');
  assert.ok(content.text.includes('term sheet'), 'text should include message content');
  assert.ok(content.text.includes('James D. Wilson'), 'text should include both senders');
});

test('C2: subject is "LinkedIn: {participant names}"', () => {
  const content = threadToExtractedContent(makeThread());
  assert.ok(content !== null);
  assert.ok(
    content.subject.startsWith('LinkedIn:'),
    `subject should start with "LinkedIn:", got: ${content.subject}`,
  );
  assert.ok(content.subject.includes('Alice Example'), 'subject should include participant name');
});

test('C3: from is the first non-self participant (first message sender)', () => {
  const content = threadToExtractedContent(makeThread());
  assert.ok(content !== null);
  // "from" should be the other participant, not self — first message sender
  assert.equal(content.from, 'Alice Example');
});

test('C4: date is the most recent message sentAt', () => {
  const thread = makeThread();
  const content = threadToExtractedContent(thread);
  assert.ok(content !== null);
  // Most recent = second message (09:05)
  assert.ok(
    content.date.getTime() >= new Date('2026-03-07T09:00:00Z').getTime(),
    'date should be the most recent message timestamp',
  );
});

test('C5: parties is the deduplicated list of all participants', () => {
  const content = threadToExtractedContent(makeThread());
  assert.ok(content !== null);
  assert.ok(Array.isArray(content.parties), 'parties should be an array');
  assert.ok(content.parties.includes('Alice Example'), 'should include Alice');
  // No duplicates
  const unique = [...new Set(content.parties)];
  assert.equal(unique.length, content.parties.length, 'no duplicate parties');
});

test('C6: returns null for thread with no messages', () => {
  const emptyThread = makeThread({ messages: [] });
  const content = threadToExtractedContent(emptyThread);
  assert.equal(content, null, 'empty message list should return null');
});

test('C7: sourceId is "linkedin:{threadId}"', () => {
  const content = threadToExtractedContent(makeThread({ threadId: '2-abc123XYZ' }));
  assert.ok(content !== null);
  assert.equal(content.sourceId, 'linkedin:2-abc123XYZ');
});

// ============================================================================
// Group D — LinkedInFetcher.getNewMessageIds (mock browser)
// ============================================================================

test('D1: getNewMessageIds navigates to /messaging/ and returns threadIds', async () => {
  const { browser, navigations } = mockBrowser({ '/messaging/': INBOX_HTML });
  const fetcher = new LinkedInFetcher(browser);
  const ids = await fetcher.getNewMessageIds(null);
  assert.ok(navigations.some(u => u.includes('/messaging/')), 'should navigate to inbox');
  assert.ok(Array.isArray(ids), 'should return array');
  assert.ok(ids.length > 0, 'should return thread IDs from fixture HTML');
});

test('D2: getNewMessageIds filters out threads older than watermark', async () => {
  const { browser } = mockBrowser({ '/messaging/': INBOX_HTML });
  const fetcher = new LinkedInFetcher(browser);
  // Watermark set to "now" — all threads in fixture are "Mar 5-7" so treated as older
  // The exact behavior depends on timestamp parsing; test that result is filtered
  const watermark = new Date(); // now — nothing passes
  const ids = await fetcher.getNewMessageIds(watermark);
  assert.ok(Array.isArray(ids), 'should always return array');
  // With a future watermark, all fixture threads should be filtered out
  assert.equal(ids.length, 0, 'future watermark should exclude all fixture threads');
});

test('D3: getNewMessageIds returns all threads when watermark is null', async () => {
  const { browser } = mockBrowser({ '/messaging/': INBOX_HTML });
  const fetcher = new LinkedInFetcher(browser);
  const ids = await fetcher.getNewMessageIds(null);
  assert.ok(ids.length >= 2, 'null watermark should return all threads from fixture');
});

test('D4: getNewMessageIds returns empty array when inbox is empty', async () => {
  const { browser } = mockBrowser({ '/messaging/': EMPTY_INBOX_HTML });
  const fetcher = new LinkedInFetcher(browser);
  const ids = await fetcher.getNewMessageIds(null);
  assert.equal(ids.length, 0);
});

test('D5: getNewMessageIds respects maxThreads option', async () => {
  const { browser } = mockBrowser({ '/messaging/': INBOX_HTML });
  const fetcher = new LinkedInFetcher(browser, { maxThreads: 1 });
  const ids = await fetcher.getNewMessageIds(null);
  assert.ok(ids.length <= 1, 'maxThreads:1 should return at most 1 thread');
});

// ============================================================================
// Group E — LinkedInFetcher.fetchMessage (mock browser)
// ============================================================================

test('E1: fetchMessage navigates to thread URL and returns ExtractedContent', async () => {
  const threadId = '2-abc123XYZ';
  const { browser } = mockBrowser({
    [`/messaging/thread/${threadId}`]: THREAD_HTML,
  });
  const fetcher = new LinkedInFetcher(browser, { delayMs: 0 }); // no delay in tests
  const content = await fetcher.fetchMessage(threadId);
  assert.ok(content !== null, 'should return ExtractedContent for valid thread');
  assert.ok(content.text.length > 0, 'should have message text');
  assert.equal(content.sourceId, `linkedin:${threadId}`);
});

test('E2: fetchMessage returns null when thread page returns no messages', async () => {
  const threadId = '2-empty';
  const { browser } = mockBrowser({
    [`/messaging/thread/${threadId}`]: EMPTY_THREAD_HTML,
  });
  const fetcher = new LinkedInFetcher(browser);
  const content = await fetcher.fetchMessage(threadId);
  assert.equal(content, null, 'empty thread should return null');
});

test('E3: fetchMessage returns null on browser navigation error — never throws', async () => {
  const errorBrowser = {
    navigate: async () => { throw new Error('ECONNREFUSED'); },
    getPageSource: async () => '',
    getCurrentUrl: async () => '',
    waitForSelector: async () => {},
    scrollToBottom: async () => {},
  };
  const fetcher = new LinkedInFetcher(errorBrowser);
  let result;
  await assert.doesNotReject(async () => {
    result = await fetcher.fetchMessage('2-any');
  });
  assert.equal(result, null, 'navigation error should return null, not throw');
});

test('E4: fetchMessage source is "linkedin" (matches MessageFetcher.source)', async () => {
  const fetcher = new LinkedInFetcher(mockBrowser().browser);
  assert.equal(fetcher.source, 'linkedin');
});
