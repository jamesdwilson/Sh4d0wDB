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
import type { LinkedInProfile } from "./phase4-profile-linkedin.js";
export interface ProfileBrowserClient {
    navigate(url: string): Promise<void>;
    getCurrentUrl(): Promise<string>;
    waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
    /** Run JS in the page, return a string result. Used for intercept+click. */
    evaluateWithResult(fn: string): Promise<string>;
}
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
export declare function parsePdfText(text: string, username: string): LinkedInProfile | null;
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
export declare class LinkedInProfileFetcher {
    private readonly browser;
    private readonly pdfToText;
    private readonly ambryTimeoutMs;
    private readonly delayMs;
    private readonly selfName;
    constructor(browser: ProfileBrowserClient, options?: LinkedInProfileFetcherOptions);
    fetchProfile(username: string): Promise<ExtractedContent | null>;
}
