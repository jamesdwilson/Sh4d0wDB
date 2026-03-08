/**
 * phase4-profile-linkedin.ts — LinkedIn contact profile scraping
 *
 * Phase 4 submodule 3: Contact Profile (`/in/<username>/`).
 *
 * Exports three pure functions (no browser dependency — fully unit testable):
 *   parseContactProfile(html, username)   — HTML → LinkedInProfile | null
 *   profileToExtractedContent(profile)    — LinkedInProfile → ExtractedContent | null
 *   extractEdgeSignals(profile, selfName) — LinkedInProfile → EdgeSignal[]
 *
 * Real LinkedIn DOM selectors (verified against live page 2026-03-08):
 *   Name:       h1.text-heading-xlarge
 *   Headline:   .text-body-medium.break-words
 *   Location:   .text-body-small.inline.t-black--light.break-words
 *   About:      #about section → first span[aria-hidden="true"] with meaningful text
 *   Experience: #experience ~ * li.artdeco-list__item
 *     title:    .t-bold span[aria-hidden="true"]
 *     company:  .t-14.t-normal span[aria-hidden="true"] (first)
 *     dates:    .t-14.t-normal.t-black--light span[aria-hidden="true"]
 *   Education:  #education ~ * li.artdeco-list__item (same child selectors)
 *   Recs:       #recommendations li.artdeco-list__item
 *
 * See: ARCHITECTURE.md § 7.4–7.5, § 8
 */
import type { ExtractedContent } from "./phase1-gmail.js";
export type EntityNodeType = "person" | "company" | "group" | "fund" | "school" | "event";
export type EdgeType = "knows" | "referred" | "co_invested" | "mentioned" | "tension" | "reports_to" | "works_at" | "worked_at" | "invested_in" | "advises" | "founded" | "member_of" | "attended" | "acquired" | "competes_with" | "partners_with" | "raised_from" | "portfolio_of";
export interface EntityCandidate {
    type: EntityNodeType;
    name?: string;
    email?: string;
    phone?: string;
    title?: string;
    companyName?: string;
    domain?: string;
    linkedinUrl?: string;
    crunchbaseUrl?: string;
    sourceId: string;
    sourceRecordId: string;
    confidence: number;
}
export interface EdgeSignal {
    fromCandidate: EntityCandidate;
    toCandidate: EntityCandidate;
    type: EdgeType;
    confidence: number;
    evidenceText?: string;
    sourceId: string;
}
export interface LinkedInExperience {
    title: string;
    company: string;
    startDate?: string;
    endDate?: string;
    description?: string;
}
export interface LinkedInEducation {
    school: string;
    degree?: string;
    field?: string;
    startYear?: number;
    endYear?: number;
}
export interface LinkedInRecommendation {
    authorName: string;
    authorTitle?: string;
    text: string;
    direction: "received" | "given";
}
export interface LinkedInProfile {
    username: string;
    url: string;
    fullName: string;
    headline?: string;
    location?: string;
    about?: string;
    experience: LinkedInExperience[];
    education: LinkedInEducation[];
    skills: string[];
    mutualConnectionCount?: number;
    sharedConnections: string[];
    recommendations: LinkedInRecommendation[];
    fetchedAt: Date;
}
/**
 * Parse a LinkedIn profile page HTML string into a structured LinkedInProfile.
 *
 * Uses real CSS selectors verified against live LinkedIn DOM (2026-03-08).
 * Returns null if the page contains no recognizable name element.
 * Never throws.
 *
 * @param html     - Raw HTML of the /in/<username>/ page
 * @param username - LinkedIn URL slug (e.g. "alice-example")
 * @returns        - Parsed profile, or null if page is unrecognizable
 */
export declare function parseContactProfile(html: string, username: string): LinkedInProfile | null;
/**
 * Transform a LinkedInProfile into ShadowDB-ready ExtractedContent.
 *
 * Produces a text block suitable for entity filtering, LLM scoring, and embedding:
 *   - Full name + headline + location
 *   - About section
 *   - Experience entries (title at company, dates)
 *   - Education entries
 *   - Recommendations received (author + text)
 *
 * Returns null if profile has no fullName (can't create a meaningful record).
 * Never throws.
 *
 * @param profile - Parsed LinkedInProfile
 * @returns       - ExtractedContent ready for pipeline, or null
 */
export declare function profileToExtractedContent(profile: LinkedInProfile): ExtractedContent | null;
/**
 * Extract candidate graph edges from a LinkedIn profile.
 *
 * Emits EdgeSignal[] representing relationships detectable from profile data:
 *   - works_at   → current experience entries (endDate = "Present")
 *   - worked_at  → past experience entries
 *   - member_of  → education entries (person → school)
 *   - referred   → recommendations received (author → profile subject)
 *   - knows      → shared connections (when available)
 *
 * All edges are from the profile subject (fromCandidate = person).
 * Confidence levels:
 *   - works_at (current):  0.95
 *   - works_at (present):  0.95
 *   - worked_at (past):    0.80
 *   - member_of (school):  0.85
 *   - referred (rec):      0.90 — recommendation is strong signal
 *   - knows (shared conn): 0.70
 *
 * Never throws.
 *
 * @param profile   - Parsed LinkedInProfile
 * @param selfName  - The name of the logged-in user (used to exclude self-edges)
 * @returns         - Array of candidate edges for EntityResolver
 */
export declare function extractEdgeSignals(profile: LinkedInProfile, selfName: string): EdgeSignal[];
