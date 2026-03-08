/**
 * phase4-profile-fetcher.ts — LinkedInProfileFetcher (PDF intercept strategy)
 *
 * Fetches a LinkedIn contact profile by intercepting the "Save to PDF" flow
 * rather than scraping DOM HTML. LinkedIn generates a clean, structured PDF
 * server-side — name, summary, all experience, all education, skills — with
 * no noise, no truncation, no "see all experience" pagination.
 *
 * Verified against live LinkedIn DOM 2026-03-08:
 *   - "More actions" button: [aria-label="More actions"][role="button"] (top card)
 *   - "Save to PDF" item:    [aria-label="Save to PDF"][role="button"]
 *   - On click: fires XHR to /voyager/api/graphql?action=execute&queryId=voyagerIdentityDash...
 *   - LinkedIn responds with a signed Ambry CDN URL:
 *       https://www.linkedin.com/ambry/?x-li-ambry-ep=...&x-ambry-um-filename=Profile.pdf
 *   - We intercept that URL, fetch() the PDF bytes, run pdftotext, parse the text
 *
 * PDF text format (verified from real download):
 *   Left sidebar: Contact, Top Skills, Languages, Honors-Awards (ignored for now)
 *   Main column:
 *     <name>
 *     <headline>
 *     <location>
 *     Summary
 *     <about text>
 *     Experience
 *     <company>
 *     <title>
 *     <blank line>
 *     <dates (duration)>
 *     <location>
 *     <description>
 *     ...repeated per role...
 *     Education
 *     <school>
 *     <degree, field>
 *     <blank line>
 *     <years>
 *
 * parsePdfText() is exported for unit testing — pure function, no I/O.
 *
 * BrowserClient and pdfToText are injected — production uses OC browser + execa;
 * tests inject mocks.
 *
 * See: ARCHITECTURE.md § 8, phase4-profile-linkedin.ts
 */

import type { ExtractedContent } from "./phase1-gmail.js";
import type {
  LinkedInProfile,
  LinkedInExperience,
  LinkedInEducation,
} from "./phase4-profile-linkedin.js";
import { profileToExtractedContent } from "./phase4-profile-linkedin.js";

// ============================================================================
// Browser interface (minimal — only what we need)
// ============================================================================

export interface ProfileBrowserClient {
  navigate(url: string): Promise<void>;
  getCurrentUrl(): Promise<string>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
  /** Run JS in the page, return a string result. Used for intercept+click. */
  evaluateWithResult(fn: string): Promise<string>;
}

// ============================================================================
// Options
// ============================================================================

export interface LinkedInProfileFetcherOptions {
  /** Injected PDF-to-text function. Production uses pdftotext subprocess. */
  pdfToText?: (pdfBytes: Uint8Array) => Promise<string>;
  /** ms to wait for ambry URL after clicking Save to PDF. Default: 8000 */
  ambryTimeoutMs?: number;
  /** ms between navigate and click. Default: 1500 (set 0 in tests). */
  delayMs?: number;
  /** Self name — used by extractEdgeSignals to avoid self-edges. Default: "" */
  selfName?: string;
}

// ============================================================================
// PDF text parser — pure function, exported for unit tests
// ============================================================================

/**
 * Parse LinkedIn PDF text (from pdftotext -layout output) into a LinkedInProfile.
 *
 * The PDF has a left sidebar (Contact/Skills/etc.) and a main column.
 * pdftotext without -layout interleaves them, but the pattern is consistent:
 *   - Name appears near the top as a standalone line after sidebar content
 *   - "Summary", "Experience", "Education" are section headers
 *   - Experience blocks: company line, title line, blank, dates line, [location], description
 *   - Education blocks: school line, degree/field line, blank, years line
 *
 * Returns null on empty input or unparseable content. Never throws.
 */
export function parsePdfText(
  text: string,
  username: string,
): LinkedInProfile | null {
  if (!text?.trim()) return null;

  try {
    const lines = text
      .split("\n")
      .map(l => l.trim())
      .filter((l, i, arr) => {
        // Collapse runs of blank lines to at most one
        if (l === "") return i === 0 || arr[i - 1] !== "";
        return true;
      });

    // ---- Locate section boundaries ----
    const summaryIdx = lines.findIndex(l => l === "Summary");
    const experienceIdx = lines.findIndex(l => l === "Experience");
    const educationIdx = lines.findIndex(l => l === "Education");
    const skillsIdx = lines.findIndex(l => l === "Skills");

    // ---- Extract name + headline + location ----
    // They appear before "Summary" in the main column.
    // The sidebar content (Contact, Top Skills, etc.) comes first.
    // Strategy: look for the first non-empty line that appears after the
    // sidebar markers have all been seen but before "Summary".
    // Simpler heuristic: name is the longest line before "Summary" that
    // doesn't contain common sidebar keywords.
    // Sidebar content appears before the name in pdftotext output.
    // We skip all lines until we've passed the sidebar block.
    // Sidebar ends at the first blank line AFTER a sidebar header has been seen.
    // More reliable: look at the block after "Honors-Awards" or the last
    // sidebar keyword, then scan for the name there.
    // Simplest heuristic that works: name is the first line after "Summary" that
    // does NOT contain pipe, colon, @, http, or "Page" — we find it in the lines
    // just BEFORE "Summary" but AFTER the blank line that follows sidebar.
    // Strategy: find last sidebar header, then look for name after it.

    const SIDEBAR_HEADERS = new Set(["Contact", "Top Skills", "Languages", "Honors-Awards", "Certifications"]);
    const SIDEBAR_NOISE = /^(www\.|http|linkedin\.com|Page \d|•|\(LinkedIn\)|\(Company\))/i;
    const INLINE_NOISE = /[@|]/; // email or headline markers

    // Find the index of the LAST blank line before "Summary" that follows a sidebar header.
    // The name appears immediately after the last sidebar section ends (blank line transition).
    const searchEnd = summaryIdx > 0 ? summaryIdx : lines.length;

    // Collect original (unfiltered) lines up to Summary to find the blank line transition
    const rawPreLines = lines.slice(0, searchEnd);

    // Find last sidebar header position (in rawPreLines)
    let lastSidebarEnd = 0;
    for (let i = 0; i < rawPreLines.length; i++) {
      if (SIDEBAR_HEADERS.has(rawPreLines[i])) {
        // Sidebar section ends at the next blank line after this header
        for (let j = i + 1; j < rawPreLines.length; j++) {
          if (rawPreLines[j] === "") { lastSidebarEnd = j; break; }
        }
      }
    }

    // Name search starts after the last sidebar section's trailing blank
    const nameSearchStart = lastSidebarEnd > 0 ? lastSidebarEnd + 1 : 0;
    const preSection = rawPreLines.slice(nameSearchStart);
    const mainLines = preSection.filter(l => l.length > 0 && !SIDEBAR_NOISE.test(l));

    // Name: first line that looks like a person name —
    //   2-4 words, all Title Case, no pipes/@ or numeric, not a known sidebar word,
    //   not a skill/award phrase (those are often 2 words too, but contain non-name words)
    // We also require it does NOT match headline patterns (contains |, "at ", "for ", etc.)
    const HEADLINE_MARKERS = /\bat\b|\bfor\b|\|/i;
    let fullName = "";
    let nameIdx = -1;
    for (let i = 0; i < mainLines.length; i++) {
      const l = mainLines[i];
      if (INLINE_NOISE.test(l)) continue;
      if (HEADLINE_MARKERS.test(l)) continue;
      if (SIDEBAR_HEADERS.has(l)) continue;
      if (l.length > 60) continue;
      // Must be 2-4 space-separated tokens, each starting with a capital letter
      const tokens = l.split(" ");
      if (tokens.length < 2 || tokens.length > 5) continue;
      // Each token must start with uppercase and be mostly alpha (allow periods for initials)
      if (tokens.every(t => /^[A-Z][a-zA-Z.'"-]*$/.test(t))) {
        fullName = l;
        nameIdx = i;
        break;
      }
    }

    if (!fullName) {
      // Fallback: first non-sidebar, non-noise line with a space, under 60 chars
      for (const l of mainLines) {
        if (l.includes(" ") && l.length < 60 && !INLINE_NOISE.test(l)) {
          fullName = l;
          break;
        }
      }
    }

    if (!fullName) return null;

    // Headline: line immediately after name in mainLines (often contains | or role keywords)
    const headline = nameIdx >= 0 && nameIdx + 1 < mainLines.length
      ? mainLines[nameIdx + 1]
      : undefined;

    // Location: line that matches "City, State, Country" pattern
    const locationLine = mainLines.find(l =>
      /^[A-Z][a-zA-Z\s]+,\s*[A-Z][a-zA-Z\s]+,\s*[A-Z][a-zA-Z\s]+$/.test(l),
    );

    // ---- About / Summary ----
    let about: string | undefined;
    if (summaryIdx >= 0) {
      const endIdx = experienceIdx > summaryIdx ? experienceIdx : lines.length;
      const summaryLines = lines
        .slice(summaryIdx + 1, endIdx)
        .filter(l => l.length > 0 && !/^Page \d/.test(l));
      if (summaryLines.length > 0) about = summaryLines.join(" ");
    }

    // ---- Experience ----
    const experience: LinkedInExperience[] = [];
    if (experienceIdx >= 0) {
      const endIdx = educationIdx > experienceIdx ? educationIdx
        : skillsIdx > experienceIdx ? skillsIdx
        : lines.length;
      const expLines = lines.slice(experienceIdx + 1, endIdx);
      experience.push(...parseExperienceBlocks(expLines));
    }

    // ---- Education ----
    const education: LinkedInEducation[] = [];
    if (educationIdx >= 0) {
      const endIdx = skillsIdx > educationIdx ? skillsIdx : lines.length;
      const eduLines = lines.slice(educationIdx + 1, endIdx);
      education.push(...parseEducationBlocks(eduLines));
    }

    return {
      username,
      url: `https://www.linkedin.com/in/${username}/`,
      fullName,
      headline,
      location: locationLine,
      about,
      experience,
      education,
      skills: [],
      mutualConnectionCount: undefined,
      sharedConnections: [],
      recommendations: [],
      fetchedAt: new Date(),
    };
  } catch {
    return null;
  }
}

/**
 * Parse experience blocks from the lines between "Experience" and "Education".
 *
 * Pattern per role:
 *   Company Name
 *   Job Title
 *   [blank]
 *   Month Year - Month Year (Duration)   ← or "Year - Year"
 *   [Location]
 *   [Description lines...]
 *   [Page N of M — skip]
 *
 * Heuristic: dates line matches /\d{4}/ and contains " - " or "–" or "Present".
 */
function parseExperienceBlocks(lines: string[]): LinkedInExperience[] {
  const items: LinkedInExperience[] = [];
  const DATE_PATTERN = /\d{4}.*[-–].*(Present|\d{4})/i;
  const PAGE_PATTERN = /^Page \d+ of \d+/;

  let i = 0;
  while (i < lines.length) {
    // Skip blanks and page markers
    if (!lines[i] || PAGE_PATTERN.test(lines[i])) { i++; continue; }

    const company = lines[i];
    i++;

    // Skip blanks
    while (i < lines.length && !lines[i]) i++;
    if (i >= lines.length) break;

    const title = lines[i];
    i++;

    // Skip blanks
    while (i < lines.length && !lines[i]) i++;
    if (i >= lines.length) {
      if (company && title) items.push({ title, company });
      break;
    }

    // Find dates line
    let datesRaw = "";
    if (DATE_PATTERN.test(lines[i])) {
      datesRaw = lines[i];
      i++;
    }

    // Skip description until next company (heuristic: next non-blank line that
    // is short, capitalized, and not a date — treat as next company)
    while (i < lines.length && !isLikelyCompanyLine(lines[i], DATE_PATTERN, PAGE_PATTERN)) {
      i++;
    }

    if (!company || !title) continue;
    // Filter out sidebar / noise blocks (e.g. company is "Page 1 of 7")
    if (PAGE_PATTERN.test(company)) continue;

    const { startDate, endDate } = parseDates(datesRaw);
    items.push({ title, company, startDate, endDate });
  }

  return items;
}

function isLikelyCompanyLine(line: string, datePattern: RegExp, pagePattern: RegExp): boolean {
  if (!line) return false;
  if (pagePattern.test(line)) return false;
  if (datePattern.test(line)) return false;
  // Company lines are typically short, start with capital, no bullet points
  if (line.startsWith("•") || line.startsWith("-")) return false;
  if (line.length > 80) return false;
  return /^[A-Z]/.test(line);
}

function parseEducationBlocks(lines: string[]): LinkedInEducation[] {
  const items: LinkedInEducation[] = [];
  const PAGE_PATTERN = /^Page \d+ of \d+/;
  const YEAR_PATTERN = /^\d{4}\s*[-–]\s*\d{4}$/;

  let i = 0;
  while (i < lines.length) {
    if (!lines[i] || PAGE_PATTERN.test(lines[i])) { i++; continue; }

    const school = lines[i];
    i++;

    // Skip blanks
    while (i < lines.length && !lines[i]) i++;
    if (i >= lines.length) {
      if (school) items.push({ school });
      break;
    }

    // Degree/field line or year line
    let degree: string | undefined;
    let field: string | undefined;
    let startYear: number | undefined;
    let endYear: number | undefined;

    if (YEAR_PATTERN.test(lines[i])) {
      // Directly years — no degree info
      const [sy, ey] = lines[i].split(/\s*[-–]\s*/);
      startYear = parseInt(sy, 10);
      endYear = parseInt(ey, 10);
      i++;
    } else {
      // Degree/field line: "MBA, Finance" or "BA, Economics"
      const [deg, fld] = lines[i].split(",").map(s => s.trim());
      degree = deg || undefined;
      field = fld || undefined;
      i++;

      // Skip blanks
      while (i < lines.length && !lines[i]) i++;

      // Year line
      if (i < lines.length && YEAR_PATTERN.test(lines[i])) {
        const [sy, ey] = lines[i].split(/\s*[-–]\s*/);
        startYear = parseInt(sy, 10);
        endYear = parseInt(ey, 10);
        i++;
      }
    }

    // Skip to next school
    while (i < lines.length && lines[i] && !/^[A-Z]/.test(lines[i])) i++;

    if (!school || PAGE_PATTERN.test(school)) continue;
    items.push({ school, degree, field, startYear, endYear });
  }

  return items;
}

function parseDates(raw: string): { startDate?: string; endDate?: string } {
  if (!raw) return {};
  // "January 2022 - Present (3 years 2 months)" → "January 2022", "Present"
  const datePart = raw.replace(/\(.*\)/, "").trim();
  const [start, end] = datePart.split(/\s*[-–]\s*/);
  return {
    startDate: start?.trim() || undefined,
    endDate: end?.trim() || undefined,
  };
}

// ============================================================================
// LinkedInProfileFetcher — PDF intercept
// ============================================================================

/** Default pdfToText using pdftotext subprocess */
async function defaultPdfToText(pdfBytes: Uint8Array): Promise<string> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { writeFileSync, unlinkSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const execFileAsync = promisify(execFile);

  const tmpPath = join(tmpdir(), `li-profile-${Date.now()}.pdf`);
  try {
    writeFileSync(tmpPath, pdfBytes);
    const { stdout } = await execFileAsync("pdftotext", [tmpPath, "-"]);
    return stdout;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/**
 * JS to inject into the page that:
 *  1. Intercepts XHR.open to capture the Ambry URL (linkedin.com/ambry)
 *  2. Clicks the "More actions" button (if menu not already open)
 *  3. Clicks "Save to PDF" div
 *  4. Waits up to {timeoutMs}ms for the Ambry URL
 *  5. Returns the URL or "" on timeout
 */
function buildInterceptScript(timeoutMs: number): string {
  return `
    new Promise((resolve) => {
      let ambryUrl = '';
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && url.includes('ambry') && url.includes('Profile.pdf')) {
          ambryUrl = url;
        }
        return origOpen.apply(this, arguments);
      };

      // Also intercept fetch (LinkedIn may use either)
      const origFetch = window.fetch;
      window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
        if (url.includes('ambry') && url.includes('Profile.pdf')) ambryUrl = url;
        return origFetch.apply(this, args);
      };

      // Click More actions → Save to PDF
      const moreBtn = document.querySelector('[aria-label="More actions"][role="button"]')
                   ?? document.querySelector('button[aria-label="More actions"]');
      if (moreBtn) moreBtn.click();

      setTimeout(() => {
        const pdfBtn = document.querySelector('[aria-label="Save to PDF"][role="button"]');
        if (pdfBtn) pdfBtn.click();
      }, 400);

      // Poll for the ambry URL
      const start = Date.now();
      const iv = setInterval(() => {
        if (ambryUrl) {
          clearInterval(iv);
          XMLHttpRequest.prototype.open = origOpen;
          window.fetch = origFetch;
          resolve(ambryUrl);
        } else if (Date.now() - start > ${timeoutMs}) {
          clearInterval(iv);
          XMLHttpRequest.prototype.open = origOpen;
          window.fetch = origFetch;
          resolve('');
        }
      }, 200);
    })
  `;
}

/**
 * Fetches a single LinkedIn contact profile using the PDF intercept strategy.
 *
 * Per-contact cost: 1 navigation + 1 JS evaluation + 1 fetch (PDF download)
 * vs the old approach: 3 navigations + HTML parsing.
 *
 * Usage:
 *   const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });
 *   const content = await fetcher.fetchProfile('alice-example');
 *
 * Production: inject real OC BrowserClient with evaluateWithResult()
 * Tests: inject mock returning fixture ambry URL + mock pdfToText
 */
export class LinkedInProfileFetcher {
  private readonly pdfToText: (bytes: Uint8Array) => Promise<string>;
  private readonly ambryTimeoutMs: number;
  private readonly delayMs: number;
  private readonly selfName: string;

  constructor(
    private readonly browser: ProfileBrowserClient,
    options: LinkedInProfileFetcherOptions = {},
  ) {
    this.pdfToText = options.pdfToText ?? defaultPdfToText;
    this.ambryTimeoutMs = options.ambryTimeoutMs ?? 8_000;
    this.delayMs = options.delayMs ?? 1_500;
    this.selfName = options.selfName ?? "";
  }

  async fetchProfile(username: string): Promise<ExtractedContent | null> {
    try {
      await this.browser.navigate(`https://www.linkedin.com/in/${username}/`);

      // Wait for the profile card to render
      await this.browser.waitForSelector('[aria-label="More actions"]', 8_000).catch(() => {});

      if (this.delayMs > 0) {
        await new Promise(r => setTimeout(r, this.delayMs));
      }

      // Inject interceptor, click Save to PDF, await Ambry URL
      const ambryUrl = await this.browser.evaluateWithResult(
        buildInterceptScript(this.ambryTimeoutMs),
      );

      if (!ambryUrl) return null;

      // Fetch the PDF bytes — cookies are shared since we're in the same browser context
      // In the mock, evaluateWithResult already returned the URL; in production we
      // need to fetch it from inside the page context to carry session cookies.
      // We use a second evaluateWithResult that does the fetch + base64 encode.
      const pdfBase64 = await this.browser.evaluateWithResult(`
        fetch(${JSON.stringify(ambryUrl)}, { credentials: 'include' })
          .then(r => r.arrayBuffer())
          .then(buf => {
            const bytes = new Uint8Array(buf);
            let bin = '';
            bytes.forEach(b => bin += String.fromCharCode(b));
            return btoa(bin);
          })
          .catch(() => '')
      `);

      if (!pdfBase64) return null;

      const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
      const pdfText = await this.pdfToText(pdfBytes);
      if (!pdfText?.trim()) return null;

      const profile = parsePdfText(pdfText, username);
      if (!profile) return null;

      const content = profileToExtractedContent(profile);
      return content;
    } catch {
      return null;
    }
  }
}
