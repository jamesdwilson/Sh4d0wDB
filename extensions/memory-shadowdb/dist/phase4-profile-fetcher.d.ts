/**
 * phase4-profile-fetcher.ts — LinkedInProfileFetcher
 *
 * Navigates a single LinkedIn contact profile using 3 separate URL fetches:
 *   1. /in/<username>/                    — name, headline, location, about
 *   2. /in/<username>/details/experience/ — job history
 *   3. /in/<username>/details/education/  — education history
 *
 * Why 3 URLs instead of 1:
 *   - The main profile page uses a SPA that sometimes redirects (verified live)
 *   - The /details/ sub-pages are stable, fully rendered, and don't redirect
 *   - Each /details/ page is a clean list — no need to find sections by anchor ID
 *
 * Noise filtering:
 *   LinkedIn's /details/ pages append "People also viewed" entries at the bottom.
 *   These look like: ["Sundar Pichai", "· 3rd", "CEO at Google"]
 *   Filtered by: experience items must have 2+ texts AND first text must not
 *   contain "·" (connection degree marker). Education filtered the same way.
 *
 * Pure parsing functions are exported separately for unit testing:
 *   extractExperienceItems(html)   → LinkedInExperience[]
 *   extractEducationItems(html)    → LinkedInEducation[]
 *
 * BrowserClient is injected — production uses OC browser, tests use mock HTML.
 *
 * See: ARCHITECTURE.md § 8, phase4-profile-linkedin.ts
 */
import type { BrowserClient } from "./phase4-fetcher-linkedin.js";
import type { LinkedInExperience, LinkedInEducation } from "./phase4-profile-linkedin.js";
import type { ExtractedContent } from "./phase1-gmail.js";
export interface LinkedInProfileFetcherOptions {
    /** Delay between the 3 sub-page fetches per contact. Default: 1500ms. */
    delayMs?: number;
    /** Self name — used by extractEdgeSignals to avoid self-edges. Default: "". */
    selfName?: string;
}
/**
 * Parse experience items from /details/experience/ page HTML.
 *
 * Each li.artdeco-list__item contains span[aria-hidden="true"] nodes in order:
 *   [0] = job title (e.g. "VP of Investments")
 *   [1] = company name (e.g. "Acme Capital")
 *   [2] = date range (e.g. "Jan 2022 - Present · 3 yrs")
 *
 * Noise entries (People also viewed): first text contains "·" or only 1 text.
 * Filtered out.
 *
 * Never throws. Returns [] on parse failure.
 */
export declare function extractExperienceItems(html: string): LinkedInExperience[];
/**
 * Parse education items from /details/education/ page HTML.
 *
 * Each li.artdeco-list__item texts in order:
 *   [0] = school name
 *   [1] = degree/field (optional) or year range
 *   [2] = year range (optional)
 *
 * Noise entries filtered the same way as experience.
 * Never throws.
 */
export declare function extractEducationItems(html: string): LinkedInEducation[];
/**
 * Fetches a single LinkedIn contact profile using 3 page loads.
 *
 * Usage:
 *   const fetcher = new LinkedInProfileFetcher(browser, { delayMs: 0 });
 *   const content = await fetcher.fetchProfile('alice-example');
 *
 * Production: inject real OC BrowserClient (CDP or OC browser tool)
 * Tests: inject mock returning fixture HTML
 */
export declare class LinkedInProfileFetcher {
    private readonly browser;
    private readonly delayMs;
    private readonly selfName;
    constructor(browser: BrowserClient, options?: LinkedInProfileFetcherOptions);
    /**
     * Fetch a complete profile for a LinkedIn username.
     *
     * Navigates:
     *   1. /in/<username>/                    → name/headline/location/about
     *   2. /in/<username>/details/experience/ → job history
     *   3. /in/<username>/details/education/  → education
     *
     * Returns ExtractedContent ready for the ingestion pipeline, or null on failure.
     * Never throws.
     */
    fetchProfile(username: string): Promise<ExtractedContent | null>;
    private jitter;
}
