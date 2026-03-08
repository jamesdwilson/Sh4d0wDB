/**
 * phase4-profile-fetcher.test.mjs — TDD tests for LinkedInProfileFetcher
 *
 * Tests the OC browser-backed fetcher that navigates a single LinkedIn
 * contact profile and returns structured ExtractedContent.
 *
 * Scrape strategy (3 URLs per contact, verified against live DOM 2026-03-08):
 *   1. /in/<username>/                      — name, headline, location, about
 *   2. /in/<username>/details/experience/   — experience list
 *   3. /in/<username>/details/education/    — education list
 *
 * Key DOM facts (verified live):
 *   - Main page: h1 = name, .text-body-medium.break-words = headline
 *   - Details pages: li.artdeco-list__item > span[aria-hidden="true"] in order
 *   - Experience item texts: [title, company, "dates · duration"]
 *   - Education item texts: [school] or [school, "years"]
 *   - "People also viewed" noise at bottom — filtered by checking item[0]
 *     does NOT look like a person name (person names appear as noise in details)
 *
 * BrowserClient is injected — tests use mock HTML pages.
 * Never touches real LinkedIn.
 *
 * Run: node --test phase4-profile-fetcher.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInProfileFetcher } from './dist/phase4-profile-fetcher.js';

// ============================================================================
// Fixture HTML pages — match real LinkedIn DOM (verified 2026-03-08)
// ============================================================================

const MAIN_PAGE_HTML = `
<html><body>
<section class="artdeco-card pv-top-card">
  <h1 class="text-heading-xlarge">Alice Example</h1>
  <div class="text-body-medium break-words">VP of Investments at Acme Capital</div>
  <span class="text-body-small inline t-black--light break-words">Chicago, Illinois, United States</span>
</section>
<section id="about" class="artdeco-card">
  <span aria-hidden="true">Experienced investor focused on lower middle market PE. Previously at Goldman.</span>
</section>
</body></html>
`;

const EXPERIENCE_PAGE_HTML = `
<html><body>
<h1>Experience</h1>
<ul>
  <li class="artdeco-list__item">
    <span aria-hidden="true">VP of Investments</span>
    <span aria-hidden="true">Acme Capital</span>
    <span aria-hidden="true">Jan 2022 - Present · 3 yrs</span>
  </li>
  <li class="artdeco-list__item">
    <span aria-hidden="true">Associate</span>
    <span aria-hidden="true">Goldman Sachs</span>
    <span aria-hidden="true">Jun 2018 - Dec 2021 · 3 yrs 6 mos</span>
  </li>
  <!-- "People also viewed" noise — should be filtered out -->
  <li class="artdeco-list__item">
    <span aria-hidden="true">Sundar Pichai</span>
    <span aria-hidden="true">· 3rd</span>
    <span aria-hidden="true">CEO at Google</span>
  </li>
</ul>
</body></html>
`;

const EDUCATION_PAGE_HTML = `
<html><body>
<h1>Education</h1>
<ul>
  <li class="artdeco-list__item">
    <span aria-hidden="true">University of Chicago</span>
    <span aria-hidden="true">MBA, Finance</span>
    <span aria-hidden="true">2016 - 2018</span>
  </li>
  <!-- Noise entry -->
  <li class="artdeco-list__item">
    <span aria-hidden="true">Narendra Modi</span>
    <span aria-hidden="true">· 3rd+</span>
  </li>
</ul>
</body></html>
`;

const EMPTY_EXPERIENCE_HTML = `
<html><body><h1>Experience</h1><ul></ul></body></html>
`;

// ============================================================================
// Mock BrowserClient
// ============================================================================

function mockBrowser(pages = {}) {
  let currentUrl = '';
  return {
    async navigate(url) { currentUrl = url; },
    async getPageSource() {
      for (const [pattern, html] of Object.entries(pages)) {
        if (currentUrl.includes(pattern)) return html;
      }
      return '<html><body></body></html>';
    },
    async getCurrentUrl() { return currentUrl; },
    async waitForSelector() {},
    async scrollToBottom() {},
  };
}

function fullMockBrowser(username = 'alice-example') {
  return mockBrowser({
    [`/in/${username}/details/experience`]: EXPERIENCE_PAGE_HTML,
    [`/in/${username}/details/education`]: EDUCATION_PAGE_HTML,
    [`/in/${username}/`]: MAIN_PAGE_HTML,
    [`/in/${username}`]: MAIN_PAGE_HTML,
  });
}

// ============================================================================
// Group A — fetchProfile (single contact)
// ============================================================================

test('A1: fetchProfile returns ExtractedContent for a valid profile', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null, 'should return content');
  assert.ok(content.text.length > 0, 'should have text');
});

test('A2: fetchProfile extracts name from main page', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.ok(content.text.includes('Alice Example'), 'text should include name');
});

test('A3: fetchProfile extracts headline', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.ok(content.text.includes('VP of Investments'), 'text should include headline');
});

test('A4: fetchProfile extracts about text', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.ok(content.text.includes('investor'), 'text should include about content');
});

test('A5: fetchProfile extracts experience from /details/experience/ page', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.ok(content.text.includes('Acme Capital'), 'text should include current employer');
  assert.ok(content.text.includes('Goldman Sachs'), 'text should include past employer');
});

test('A6: fetchProfile filters "People also viewed" noise from experience list', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.ok(!content.text.includes('Sundar Pichai'), 'should filter out noise entries');
});

test('A7: fetchProfile extracts education from /details/education/ page', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.ok(content.text.includes('University of Chicago'), 'text should include school');
});

test('A8: fetchProfile filters noise from education list', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.ok(!content.text.includes('Narendra Modi'), 'should filter noise from education');
});

test('A9: sourceId is linkedin:profile:{username}', async () => {
  const browser = fullMockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null);
  assert.equal(content.sourceId, 'linkedin:profile:alice-example');
});

test('A10: fetchProfile returns null when main page has no name — never throws', async () => {
  const browser = mockBrowser({ '/in/nobody': '<html><body></body></html>' });
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  let result;
  await assert.doesNotReject(async () => {
    result = await fetcher.fetchProfile('nobody');
  });
  assert.equal(result, null, 'empty page should return null');
});

test('A11: fetchProfile returns null on navigation error — never throws', async () => {
  const errorBrowser = {
    navigate: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); },
    getPageSource: async () => '',
    getCurrentUrl: async () => '',
    waitForSelector: async () => {},
    scrollToBottom: async () => {},
  };
  const fetcher = new LinkedInProfileFetcher(errorBrowser, { delayMs: 0 });

  let result;
  await assert.doesNotReject(async () => {
    result = await fetcher.fetchProfile('alice-example');
  });
  assert.equal(result, null);
});

test('A12: fetchProfile works with empty experience page — degrades gracefully', async () => {
  const browser = mockBrowser({
    '/in/alice-example/details/experience': EMPTY_EXPERIENCE_HTML,
    '/in/alice-example/details/education': EDUCATION_PAGE_HTML,
    '/in/alice-example': MAIN_PAGE_HTML,
  });
  const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });

  const content = await fetcher.fetchProfile('alice-example');

  // Should still return content from main page even if experience is empty
  assert.ok(content !== null, 'should still return content');
  assert.ok(content.text.includes('Alice Example'), 'should include name');
});

// ============================================================================
// Group B — extractExperienceItems (pure parsing, exported for testing)
// ============================================================================

import { extractExperienceItems, extractEducationItems } from './dist/phase4-profile-fetcher.js';

test('B1: extractExperienceItems parses title/company/dates from HTML', () => {
  const items = extractExperienceItems(EXPERIENCE_PAGE_HTML);
  assert.ok(items.length >= 2, 'should parse at least 2 experience items');
  assert.equal(items[0].title, 'VP of Investments');
  assert.equal(items[0].company, 'Acme Capital');
  assert.ok(items[0].startDate?.includes('2022'), 'should have start date');
});

test('B2: extractExperienceItems filters noise entries (person names, connection degree)', () => {
  const items = extractExperienceItems(EXPERIENCE_PAGE_HTML);
  assert.ok(!items.some(i => i.title === 'Sundar Pichai'), 'should filter noise');
  assert.ok(!items.some(i => i.company?.includes('3rd')), 'should filter connection degree noise');
});

test('B3: extractEducationItems parses school/degree from HTML', () => {
  const items = extractEducationItems(EDUCATION_PAGE_HTML);
  assert.ok(items.length >= 1, 'should parse at least 1 education item');
  assert.equal(items[0].school, 'University of Chicago');
});

test('B4: extractEducationItems filters noise entries', () => {
  const items = extractEducationItems(EDUCATION_PAGE_HTML);
  assert.ok(!items.some(i => i.school === 'Narendra Modi'), 'should filter noise');
});
