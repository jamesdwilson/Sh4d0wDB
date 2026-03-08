/**
 * phase4-profile-fetcher.test.mjs — TDD tests for LinkedInProfileFetcher (PDF intercept)
 *
 * Strategy (verified against live LinkedIn DOM 2026-03-08):
 *   1. Navigate to /in/<username>/
 *   2. Inject XHR interceptor to capture LinkedIn's Ambry PDF URL
 *   3. Click [aria-label="Save to PDF"][role="button"] div
 *   4. Wait for Ambry URL (linkedin.com/ambry?...Profile.pdf) to appear
 *   5. fetch() that URL → PDF bytes
 *   6. pdftotext → clean text string
 *   7. parsePdfText(text) → structured profile fields
 *
 * PDF format (verified from real download):
 *   - Left sidebar: Contact, Top Skills, Languages, Honors-Awards
 *   - Main column: Name, Headline, Location, Summary, then Experience entries
 *   - Experience entry pattern: Company\nTitle\n\nDates (Duration)\nLocation\nDescription
 *   - Education: School\nDegree, Field\n\nYears
 *   - No noise entries — LinkedIn generates it, it's their canonical representation
 *
 * BrowserClient is injected — tests use a mock that returns fixture PDF text.
 * pdfToText is injected — tests use a mock that returns fixture text directly.
 * Never touches real LinkedIn or real pdftotext.
 *
 * Run: node --test phase4-profile-fetcher.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInProfileFetcher, parsePdfText } from './dist/phase4-profile-fetcher.js';

// ============================================================================
// Fixture PDF text — matches real LinkedIn PDF structure
// ============================================================================

const FIXTURE_PDF_TEXT = `Contact
alice@example.com

www.linkedin.com/in/alice-example
(LinkedIn)
example.com (Company)

Top Skills
Risk Assessment
Private Equity
Deal Structuring

Alice Example
VP of Investments at Acme Capital | Lower Middle Market PE

Dallas, Texas, United States

Summary
Experienced investor focused on lower middle market PE. Previously
at Goldman. 12 years sourcing and executing control buyouts across
business services and healthcare IT.

Experience
Acme Capital
VP of Investments

January 2022 - Present (3 years 2 months)
Dallas, Texas, United States
Led deal sourcing, structuring and execution for control buyouts in
business services and healthcare IT.

Goldman Sachs
Associate, Investment Banking

June 2018 - December 2021 (3 years 6 months)
New York, New York, United States
Executed M&A and leveraged finance transactions across TMT and
industrials verticals.

Education
University of Chicago Booth School of Business
MBA, Finance

2016 - 2018

Harvard University
BA, Economics

2012 - 2016

Page 1 of 2

Skills
Private Equity
M&A
Deal Structuring
Risk Assessment
`;

const FIXTURE_PDF_TEXT_MINIMAL = `Alice Example
VP at Acme

Chicago, Illinois, United States

Experience
Acme Capital
VP of Investments

2022 - Present

`;

// ============================================================================
// Mock BrowserClient
// ============================================================================

function mockBrowser({ ambryUrl = 'https://www.linkedin.com/ambry/?x-li-ambry-ep=ABC123&x-ambry-um-filename=Profile.pdf', navigateShouldThrow = false, pdfFixtureText = FIXTURE_PDF_TEXT } = {}) {
  let currentUrl = '';
  const calls = [];
  let evalCallCount = 0;

  // Encode fixture PDF text as fake base64 so the fetcher can decode it
  // (pdfToText mock receives the bytes and returns the text directly)
  const fakePdfBase64 = Buffer.from(pdfFixtureText).toString('base64');

  return {
    browser: {
      async navigate(url) {
        if (navigateShouldThrow) throw new Error('net::ERR_NAME_NOT_RESOLVED');
        currentUrl = url;
        calls.push({ action: 'navigate', url });
      },
      async getCurrentUrl() { return currentUrl; },
      async waitForSelector() {},
      async evaluateWithResult(_fn) {
        calls.push({ action: 'evaluate' });
        evalCallCount++;
        // Call 1: intercept + click → returns ambryUrl (or '' to simulate timeout)
        if (evalCallCount === 1) return ambryUrl;
        // Call 2: fetch PDF → returns base64-encoded PDF bytes
        if (evalCallCount === 2) return ambryUrl ? fakePdfBase64 : '';
        return '';
      },
    },
    calls,
    capturedAmbryUrl: ambryUrl,
  };
}

// Mock pdfToText that decodes our fake base64 back to the fixture text
// (since we base64-encoded the text string as the "PDF bytes")
function mockPdfToText(text) {
  return async (bytes) => {
    // The mock browser returns base64(fixtureText), which gets decoded to bytes of the text
    // So bytes here is actually the UTF-8 of the fixture text
    return Buffer.from(bytes).toString('utf8');
  };
}

// ============================================================================
// Group A — fetchProfile (PDF intercept path)
// ============================================================================

test('A1: fetchProfile returns ExtractedContent with text for a valid profile', async () => {
  const { browser } = mockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(FIXTURE_PDF_TEXT),
    delayMs: 0,
  });

  const content = await fetcher.fetchProfile('alice-example');

  assert.ok(content !== null, 'should return content');
  assert.ok(content.text.length > 0, 'should have text');
});

test('A2: fetchProfile includes name in output text', async () => {
  const { browser } = mockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(FIXTURE_PDF_TEXT),
    delayMs: 0,
  });
  const content = await fetcher.fetchProfile('alice-example');
  assert.ok(content !== null);
  assert.ok(content.text.includes('Alice Example'));
});

test('A3: fetchProfile includes employer in output text', async () => {
  const { browser } = mockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(FIXTURE_PDF_TEXT),
    delayMs: 0,
  });
  const content = await fetcher.fetchProfile('alice-example');
  assert.ok(content !== null);
  assert.ok(content.text.includes('Acme Capital'));
});

test('A4: fetchProfile includes summary in output text', async () => {
  const { browser } = mockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(FIXTURE_PDF_TEXT),
    delayMs: 0,
  });
  const content = await fetcher.fetchProfile('alice-example');
  assert.ok(content !== null);
  assert.ok(content.text.includes('lower middle market'));
});

test('A5: sourceId is linkedin:profile:{username}', async () => {
  const { browser } = mockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(FIXTURE_PDF_TEXT),
    delayMs: 0,
  });
  const content = await fetcher.fetchProfile('alice-example');
  assert.ok(content !== null);
  assert.equal(content.sourceId, 'linkedin:profile:alice-example');
});

test('A6: fetchProfile returns null when ambry URL is never captured — never throws', async () => {
  const { browser } = mockBrowser({ ambryUrl: '' });
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(''),
    delayMs: 0,
    ambryTimeoutMs: 100,
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await fetcher.fetchProfile('alice-example');
  });
  assert.equal(result, null, 'should return null when no ambry URL captured');
});

test('A7: fetchProfile returns null on navigation error — never throws', async () => {
  const { browser } = mockBrowser({ navigateShouldThrow: true });
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(''),
    delayMs: 0,
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await fetcher.fetchProfile('alice-example');
  });
  assert.equal(result, null);
});

test('A8: fetchProfile returns null when pdfToText throws — never throws', async () => {
  const { browser } = mockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: async () => { throw new Error('pdftotext not found'); },
    delayMs: 0,
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await fetcher.fetchProfile('alice-example');
  });
  assert.equal(result, null);
});

test('A9: fetchProfile navigates to /in/<username>/ first', async () => {
  const { browser, calls } = mockBrowser();
  const fetcher = new LinkedInProfileFetcher(browser, {
    pdfToText: mockPdfToText(FIXTURE_PDF_TEXT),
    delayMs: 0,
  });
  await fetcher.fetchProfile('alice-example');
  const navCall = calls.find(c => c.action === 'navigate');
  assert.ok(navCall?.url?.includes('/in/alice-example'), 'should navigate to profile URL');
});

// ============================================================================
// Group B — parsePdfText (pure parsing, exported for testing)
// ============================================================================

test('B1: parsePdfText extracts name', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  assert.equal(profile?.fullName, 'Alice Example');
});

test('B2: parsePdfText extracts headline', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  assert.ok(profile?.headline?.includes('VP of Investments'));
});

test('B3: parsePdfText extracts location', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  assert.ok(profile?.location?.includes('Dallas'));
});

test('B4: parsePdfText extracts summary', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  assert.ok(profile?.about?.includes('lower middle market'));
});

test('B5: parsePdfText extracts experience entries', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  assert.ok(Array.isArray(profile?.experience));
  assert.ok(profile?.experience.length >= 2);
});

test('B6: parsePdfText parses company and title correctly', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  const acme = profile?.experience.find(e => e.company === 'Acme Capital');
  assert.ok(acme, 'should find Acme Capital experience');
  assert.equal(acme?.title, 'VP of Investments');
});

test('B7: parsePdfText parses dates', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  const acme = profile?.experience.find(e => e.company === 'Acme Capital');
  assert.ok(acme?.startDate?.includes('2022'), 'should parse start date');
});

test('B8: parsePdfText extracts education', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  assert.ok(Array.isArray(profile?.education));
  assert.ok(profile?.education.length >= 1);
  const uchicago = profile?.education.find(e => e.school?.includes('Chicago'));
  assert.ok(uchicago, 'should find UChicago education');
});

test('B9: parsePdfText returns null for empty string', () => {
  const result = parsePdfText('', 'alice-example');
  assert.equal(result, null);
});

test('B10: parsePdfText handles minimal PDF without crashing', () => {
  let result;
  assert.doesNotThrow(() => {
    result = parsePdfText(FIXTURE_PDF_TEXT_MINIMAL, 'alice-example');
  });
  assert.ok(result !== undefined);
});

test('B11: parsePdfText sets username and url', () => {
  const profile = parsePdfText(FIXTURE_PDF_TEXT, 'alice-example');
  assert.equal(profile?.username, 'alice-example');
  assert.ok(profile?.url?.includes('alice-example'));
});
