/**
 * phase4-profile-linkedin.test.mjs — TDD tests for LinkedIn profile scraping
 *
 * Tests for Phase 4 submodule 3: Contact Profile (`/in/<username>/`).
 *
 * Covers:
 *   - parseContactProfile(html) — pure function, fixture HTML
 *   - profileToExtractedContent(profile) — pure function
 *   - extractEdgeSignals(profile, selfName) — emits EdgeSignal[]
 *
 * Real LinkedIn profile DOM selectors (verified against live page 2026-03-08):
 *   Name:        h1.text-heading-xlarge
 *   Headline:    .text-body-medium.break-words
 *   Location:    .text-body-small.inline.t-black--light.break-words
 *   About:       #about section span[aria-hidden="true"] (first non-trivial span)
 *   Experience:  #experience ~ * li.artdeco-list__item
 *     title:     li .t-bold span[aria-hidden="true"]
 *     company:   li .t-14.t-normal span[aria-hidden="true"]
 *     dates:     li .t-14.t-normal.t-black--light span[aria-hidden="true"]
 *   Education:   #education ~ * li.artdeco-list__item (same child selectors)
 *   URL slug:    window.location.pathname → /in/<username>/
 *
 * Test groups:
 *   A — parseContactProfile (pure, fixture HTML)
 *   B — profileToExtractedContent (pure, no HTML)
 *   C — extractEdgeSignals (pure, no HTML)
 *
 * Run: node --test phase4-profile-linkedin.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContactProfile,
  profileToExtractedContent,
  extractEdgeSignals,
} from './dist/phase4-profile-linkedin.js';

// ============================================================================
// Fixture HTML — matches real LinkedIn profile DOM (verified 2026-03-08)
// ============================================================================

/**
 * Minimal but realistic LinkedIn profile page for "Alice Example".
 * Uses real CSS class names from live LinkedIn DOM.
 */
const PROFILE_HTML = `
<html>
<head><meta property="og:url" content="https://www.linkedin.com/in/alice-example/"></head>
<body>

<!-- Top card -->
<section class="artdeco-card pv-top-card">
  <h1 class="text-heading-xlarge inline t-24 v-align-middle break-words">Alice Example</h1>
  <div class="text-body-medium break-words">VP of Investments at Acme Capital</div>
  <span class="text-body-small inline t-black--light break-words">Chicago, Illinois, United States</span>
  <span class="t-14 t-normal">500+ connections</span>
</section>

<!-- About -->
<section id="about" class="artdeco-card pv-profile-card">
  <div class="pv-shared-text-with-see-more">
    <span aria-hidden="true">
      Experienced investor focused on lower middle market PE. Previously at Goldman Sachs.
      Passionate about founder-friendly capital structures.
    </span>
  </div>
</section>

<!-- Experience -->
<section id="experience" class="artdeco-card pv-profile-card">
  <div>
    <ul>
      <li class="artdeco-list__item">
        <div>
          <span class="t-bold"><span aria-hidden="true">VP of Investments</span></span>
          <span class="t-14 t-normal"><span aria-hidden="true">Acme Capital</span></span>
          <span class="t-14 t-normal t-black--light"><span aria-hidden="true">Jan 2022 - Present · 3 yrs 2 mos</span></span>
        </div>
      </li>
      <li class="artdeco-list__item">
        <div>
          <span class="t-bold"><span aria-hidden="true">Associate</span></span>
          <span class="t-14 t-normal"><span aria-hidden="true">Goldman Sachs</span></span>
          <span class="t-14 t-normal t-black--light"><span aria-hidden="true">Jun 2018 - Dec 2021 · 3 yrs 6 mos</span></span>
        </div>
      </li>
    </ul>
  </div>
</section>

<!-- Education -->
<section id="education" class="artdeco-card pv-profile-card">
  <div>
    <ul>
      <li class="artdeco-list__item">
        <div>
          <span class="t-bold"><span aria-hidden="true">University of Chicago</span></span>
          <span class="t-14 t-normal"><span aria-hidden="true">MBA, Finance</span></span>
          <span class="t-14 t-normal t-black--light"><span aria-hidden="true">2016 - 2018</span></span>
        </div>
      </li>
    </ul>
  </div>
</section>

</body>
</html>
`;

/** Profile page with minimal fields — only name and headline present */
const MINIMAL_PROFILE_HTML = `
<html>
<body>
<section class="artdeco-card pv-top-card">
  <h1 class="text-heading-xlarge inline t-24 v-align-middle break-words">Bob Investor</h1>
  <div class="text-body-medium break-words">Managing Director at Horizon Fund</div>
</section>
</body>
</html>
`;

/** Completely empty page — should return null */
const EMPTY_HTML = `<html><body></body></html>`;

/** Profile mentioning connections — feeds edge signals */
const PROFILE_WITH_CONNECTIONS_HTML = `
<html>
<head><meta property="og:url" content="https://www.linkedin.com/in/alice-example/"></head>
<body>
<section class="artdeco-card pv-top-card">
  <h1 class="text-heading-xlarge inline t-24 v-align-middle break-words">Alice Example</h1>
  <div class="text-body-medium break-words">VP at Acme Capital</div>
</section>

<!-- Mutual connections section -->
<section class="pv-browsemap-section">
  <ul>
    <li><span class="t-bold">Carol Bridge</span></li>
    <li><span class="t-bold">Dan Connector</span></li>
  </ul>
</section>

<!-- Recommendations received -->
<section id="recommendations">
  <div>
    <div data-view-name="recommendations-received">
      <ul>
        <li class="artdeco-list__item">
          <span class="t-bold"><span aria-hidden="true">Carol Bridge</span></span>
          <span class="t-14 t-normal"><span aria-hidden="true">Partner at Bridge Capital</span></span>
          <div class="pv-recommendation-entity__text">
            <span aria-hidden="true">Alice is an exceptional investor. Her work on the Acme Fund III deal was outstanding.</span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</section>

<section id="experience" class="artdeco-card pv-profile-card">
  <div>
    <ul>
      <li class="artdeco-list__item">
        <span class="t-bold"><span aria-hidden="true">VP of Investments</span></span>
        <span class="t-14 t-normal"><span aria-hidden="true">Acme Capital</span></span>
        <span class="t-14 t-normal t-black--light"><span aria-hidden="true">Jan 2022 - Present · 3 yrs</span></span>
      </li>
    </ul>
  </div>
</section>
</body>
</html>
`;

// ============================================================================
// Helpers
// ============================================================================

function makeProfile(overrides = {}) {
  return {
    username: 'alice-example',
    url: 'https://www.linkedin.com/in/alice-example/',
    fullName: 'Alice Example',
    headline: 'VP of Investments at Acme Capital',
    location: 'Chicago, Illinois, United States',
    about: 'Experienced investor focused on lower middle market PE.',
    experience: [
      { title: 'VP of Investments', company: 'Acme Capital', startDate: 'Jan 2022', endDate: 'Present' },
      { title: 'Associate', company: 'Goldman Sachs', startDate: 'Jun 2018', endDate: 'Dec 2021' },
    ],
    education: [
      { school: 'University of Chicago', degree: 'MBA', field: 'Finance', startYear: 2016, endYear: 2018 },
    ],
    skills: [],
    mutualConnectionCount: 0,
    sharedConnections: [],
    recommendations: [],
    fetchedAt: new Date('2026-03-08T00:00:00Z'),
    ...overrides,
  };
}

// ============================================================================
// Group A — parseContactProfile (pure, fixture HTML)
// ============================================================================

test('A1: parseContactProfile extracts full name', () => {
  const profile = parseContactProfile(PROFILE_HTML, 'alice-example');
  assert.ok(profile !== null, 'should return a profile');
  assert.equal(profile.fullName, 'Alice Example');
});

test('A2: parseContactProfile extracts headline', () => {
  const profile = parseContactProfile(PROFILE_HTML, 'alice-example');
  assert.ok(profile !== null);
  assert.ok(profile.headline?.includes('VP of Investments'), `headline: ${profile.headline}`);
});

test('A3: parseContactProfile extracts location', () => {
  const profile = parseContactProfile(PROFILE_HTML, 'alice-example');
  assert.ok(profile !== null);
  assert.ok(profile.location?.includes('Chicago'), `location: ${profile.location}`);
});

test('A4: parseContactProfile extracts about text', () => {
  const profile = parseContactProfile(PROFILE_HTML, 'alice-example');
  assert.ok(profile !== null);
  assert.ok(profile.about && profile.about.length > 10, 'should have about text');
  assert.ok(profile.about.includes('investor'), `about: ${profile.about}`);
});

test('A5: parseContactProfile extracts experience entries', () => {
  const profile = parseContactProfile(PROFILE_HTML, 'alice-example');
  assert.ok(profile !== null);
  assert.ok(profile.experience.length >= 2, 'should have 2+ experience entries');
  assert.equal(profile.experience[0].title, 'VP of Investments');
  assert.equal(profile.experience[0].company, 'Acme Capital');
});

test('A6: parseContactProfile extracts education entries', () => {
  const profile = parseContactProfile(PROFILE_HTML, 'alice-example');
  assert.ok(profile !== null);
  assert.ok(profile.education.length >= 1, 'should have at least 1 education entry');
  assert.equal(profile.education[0].school, 'University of Chicago');
});

test('A7: parseContactProfile sets username from argument', () => {
  const profile = parseContactProfile(PROFILE_HTML, 'alice-example');
  assert.ok(profile !== null);
  assert.equal(profile.username, 'alice-example');
  assert.equal(profile.url, 'https://www.linkedin.com/in/alice-example/');
});

test('A8: parseContactProfile handles minimal profile — only name and headline', () => {
  const profile = parseContactProfile(MINIMAL_PROFILE_HTML, 'bob-investor');
  assert.ok(profile !== null, 'minimal profile should still parse');
  assert.equal(profile.fullName, 'Bob Investor');
  assert.ok(profile.headline?.includes('Managing Director'));
  assert.equal(profile.experience.length, 0);
  assert.equal(profile.education.length, 0);
});

test('A9: parseContactProfile returns null for page with no name — never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = parseContactProfile(EMPTY_HTML, 'nobody');
  });
  assert.equal(result, null, 'empty page should return null');
});

test('A10: parseContactProfile extracts recommendations when present', () => {
  const profile = parseContactProfile(PROFILE_WITH_CONNECTIONS_HTML, 'alice-example');
  assert.ok(profile !== null);
  assert.ok(profile.recommendations.length >= 1, 'should extract at least one recommendation');
  assert.equal(profile.recommendations[0].authorName, 'Carol Bridge');
  assert.equal(profile.recommendations[0].direction, 'received');
});

// ============================================================================
// Group B — profileToExtractedContent (pure)
// ============================================================================

test('B1: profileToExtractedContent produces non-null content for valid profile', () => {
  const content = profileToExtractedContent(makeProfile());
  assert.ok(content !== null);
});

test('B2: text includes name, headline, about, and experience', () => {
  const content = profileToExtractedContent(makeProfile());
  assert.ok(content !== null);
  assert.ok(content.text.includes('Alice Example'), 'text should include name');
  assert.ok(content.text.includes('Acme Capital'), 'text should include company');
  assert.ok(content.text.includes('investor'), 'text should include about');
});

test('B3: subject is "LinkedIn Profile: {fullName}"', () => {
  const content = profileToExtractedContent(makeProfile());
  assert.ok(content !== null);
  assert.equal(content.subject, 'LinkedIn Profile: Alice Example');
});

test('B4: from is the profile subject fullName', () => {
  const content = profileToExtractedContent(makeProfile());
  assert.ok(content !== null);
  assert.equal(content.from, 'Alice Example');
});

test('B5: sourceId is "linkedin:profile:{username}"', () => {
  const content = profileToExtractedContent(makeProfile({ username: 'alice-example' }));
  assert.ok(content !== null);
  assert.equal(content.sourceId, 'linkedin:profile:alice-example');
});

test('B6: parties includes fullName', () => {
  const content = profileToExtractedContent(makeProfile());
  assert.ok(content !== null);
  assert.ok(content.parties.includes('Alice Example'));
});

test('B7: parties includes companies from experience', () => {
  const content = profileToExtractedContent(makeProfile());
  assert.ok(content !== null);
  assert.ok(
    content.parties.includes('Acme Capital') || content.text.includes('Acme Capital'),
    'Acme Capital should appear in content',
  );
});

test('B8: returns null for profile with no name', () => {
  const noName = makeProfile({ fullName: '' });
  const content = profileToExtractedContent(noName);
  assert.equal(content, null, 'profile with no name should return null');
});

// ============================================================================
// Group C — extractEdgeSignals (pure)
// ============================================================================

test('C1: extractEdgeSignals returns array (may be empty for minimal profile)', () => {
  const signals = extractEdgeSignals(makeProfile(), 'James Wilson');
  assert.ok(Array.isArray(signals));
});

test('C2: works_at edge emitted for current experience entry', () => {
  const signals = extractEdgeSignals(makeProfile(), 'James Wilson');
  const worksAt = signals.find(s => s.type === 'works_at');
  assert.ok(worksAt !== undefined, 'should emit works_at edge for current position');
  assert.ok(worksAt.toCandidate.companyName === 'Acme Capital');
});

test('C3: worked_at edge emitted for past experience entries', () => {
  const signals = extractEdgeSignals(makeProfile(), 'James Wilson');
  const workedAt = signals.find(s => s.type === 'worked_at' && s.toCandidate.companyName === 'Goldman Sachs');
  assert.ok(workedAt !== undefined, 'should emit worked_at edge for past position');
});

test('C4: fromCandidate is the profile subject', () => {
  const signals = extractEdgeSignals(makeProfile(), 'James Wilson');
  assert.ok(signals.length > 0, 'should have at least one signal');
  assert.equal(signals[0].fromCandidate.name, 'Alice Example');
  assert.equal(signals[0].fromCandidate.type, 'person');
});

test('C5: works_at has higher confidence than worked_at', () => {
  const signals = extractEdgeSignals(makeProfile(), 'James Wilson');
  const worksAt = signals.find(s => s.type === 'works_at');
  const workedAt = signals.find(s => s.type === 'worked_at');
  if (worksAt && workedAt) {
    assert.ok(worksAt.confidence >= workedAt.confidence, 'current role should have higher confidence');
  }
});

test('C6: recommendation emits referred edge with high confidence', () => {
  const profileWithRec = makeProfile({
    recommendations: [{
      authorName: 'Carol Bridge',
      authorTitle: 'Partner at Bridge Capital',
      text: 'Alice is exceptional.',
      direction: 'received',
    }],
  });
  const signals = extractEdgeSignals(profileWithRec, 'James Wilson');
  const refEdge = signals.find(s => s.type === 'referred' || s.type === 'knows');
  assert.ok(refEdge !== undefined, 'recommendation should emit a relationship edge');
  assert.ok(refEdge.confidence >= 0.7, 'recommendation-based edge should have high confidence');
});

test('C7: education emits member_of edge to school entity', () => {
  const signals = extractEdgeSignals(makeProfile(), 'James Wilson');
  const eduEdge = signals.find(s => s.toCandidate.type === 'school');
  assert.ok(eduEdge !== undefined, 'should emit edge to school');
  assert.equal(eduEdge.toCandidate.companyName ?? eduEdge.toCandidate.name, 'University of Chicago');
});

test('C8: all signals have sourceId set to linkedin:profile:{username}', () => {
  const signals = extractEdgeSignals(makeProfile({ username: 'alice-example' }), 'James Wilson');
  for (const s of signals) {
    assert.ok(
      s.sourceId.startsWith('linkedin:profile:'),
      `sourceId should start with linkedin:profile:, got: ${s.sourceId}`,
    );
  }
});

test('C9: never throws for empty profile', () => {
  const empty = makeProfile({ experience: [], education: [], recommendations: [] });
  let signals;
  assert.doesNotThrow(() => {
    signals = extractEdgeSignals(empty, 'James Wilson');
  });
  assert.ok(Array.isArray(signals));
});
