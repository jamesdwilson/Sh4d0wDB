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

import { parse } from "node-html-parser";
import type { BrowserClient } from "./phase4-fetcher-linkedin.js";
import type {
  LinkedInExperience,
  LinkedInEducation,
  LinkedInProfile,
} from "./phase4-profile-linkedin.js";
import {
  profileToExtractedContent,
  extractEdgeSignals,
} from "./phase4-profile-linkedin.js";
import type { ExtractedContent } from "./phase1-gmail.js";

// ============================================================================
// Options
// ============================================================================

export interface LinkedInProfileFetcherOptions {
  /** Delay between the 3 sub-page fetches per contact. Default: 1500ms. */
  delayMs?: number;
  /** Self name — used by extractEdgeSignals to avoid self-edges. Default: "". */
  selfName?: string;
}

// ============================================================================
// Pure parsing — exported for unit tests
// ============================================================================

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
export function extractExperienceItems(html: string): LinkedInExperience[] {
  const items: LinkedInExperience[] = [];
  try {
    const root = parse(html);
    for (const li of root.querySelectorAll("li.artdeco-list__item")) {
      try {
        const texts = li
          .querySelectorAll('span[aria-hidden="true"]')
          .map(s => s.textContent.trim())
          .filter(t => t.length > 0);

        // Need at least title + company (2 texts)
        if (texts.length < 2) continue;

        // Noise filter: connection degree markers ("· 3rd", "· 3rd+")
        // appear as the second text in noise entries, or first text has "·"
        if (texts[0].includes("·") || texts[1]?.startsWith("·")) continue;

        const title = texts[0];
        const company = texts[1];
        const datesRaw = texts[2] ?? "";

        // Parse "Jan 2022 - Present · 3 yrs" → startDate / endDate
        const datePart = datesRaw.split("·")[0].trim();
        const [startDate, endDate] = datePart
          .split(/\s*[-–]\s*/)
          .map(s => s.trim())
          .filter(Boolean);

        items.push({ title, company, startDate, endDate });
      } catch {
        // Skip malformed items
      }
    }
  } catch {
    // Return whatever was collected
  }
  return items;
}

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
export function extractEducationItems(html: string): LinkedInEducation[] {
  const items: LinkedInEducation[] = [];
  try {
    const root = parse(html);
    for (const li of root.querySelectorAll("li.artdeco-list__item")) {
      try {
        const texts = li
          .querySelectorAll('span[aria-hidden="true"]')
          .map(s => s.textContent.trim())
          .filter(t => t.length > 0);

        if (texts.length < 1) continue;

        // Noise filter: connection degree marker in second position
        if (texts[0].includes("·") || texts[1]?.startsWith("·")) continue;

        const school = texts[0];

        // Determine if texts[1] is a degree/field or a year range
        let degree: string | undefined;
        let field: string | undefined;
        let startYear: number | undefined;
        let endYear: number | undefined;

        if (texts[1]) {
          const yearMatch = texts[1].match(/^(\d{4})\s*[-–]\s*(\d{4})$/);
          if (yearMatch) {
            startYear = parseInt(yearMatch[1], 10);
            endYear = parseInt(yearMatch[2], 10);
          } else {
            // It's a degree/field — parse "MBA, Finance"
            const [deg, fld] = texts[1].split(",").map(s => s.trim());
            degree = deg || undefined;
            field = fld || undefined;
          }
        }

        if (texts[2]) {
          const yearMatch = texts[2].match(/(\d{4})\s*[-–]\s*(\d{4})/);
          if (yearMatch) {
            startYear = parseInt(yearMatch[1], 10);
            endYear = parseInt(yearMatch[2], 10);
          }
        }

        items.push({ school, degree, field, startYear, endYear });
      } catch {
        // Skip
      }
    }
  } catch {
    // Return whatever was collected
  }
  return items;
}

/**
 * Extract name, headline, location, and about from the main profile page.
 * Returns null if no name found.
 */
function extractMainPageData(html: string, username: string): Partial<LinkedInProfile> | null {
  try {
    const root = parse(html);
    const fullName = root.querySelector("h1")?.textContent?.trim() ?? "";
    if (!fullName) return null;

    const headline = root.querySelector(".text-body-medium.break-words")?.textContent?.trim();
    const location = root
      .querySelector(".text-body-small.inline.t-black--light.break-words")
      ?.textContent?.trim();

    // About: first span[aria-hidden="true"] with >10 chars under #about section
    const aboutSection = root.querySelector("#about")?.closest("section");
    let about: string | undefined;
    if (aboutSection) {
      for (const span of aboutSection.querySelectorAll('span[aria-hidden="true"]')) {
        const text = span.textContent?.trim() ?? "";
        if (text.length > 10 && text !== "About") {
          about = text;
          break;
        }
      }
    }

    return {
      username,
      url: `https://www.linkedin.com/in/${username}/`,
      fullName,
      headline,
      location,
      about,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// LinkedInProfileFetcher
// ============================================================================

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
export class LinkedInProfileFetcher {
  private readonly delayMs: number;
  private readonly selfName: string;

  constructor(
    private readonly browser: BrowserClient,
    options: LinkedInProfileFetcherOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 1_500;
    this.selfName = options.selfName ?? "";
  }

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
  async fetchProfile(username: string): Promise<ExtractedContent | null> {
    try {
      const base = `https://www.linkedin.com/in/${username}`;

      // Page 1: main profile
      await this.browser.navigate(`${base}/`);
      await this.browser.waitForSelector("h1", 8_000).catch(() => {});
      const mainHtml = await this.browser.getPageSource();
      const mainData = extractMainPageData(mainHtml, username);
      if (!mainData?.fullName) return null;

      await this.jitter();

      // Page 2: experience
      await this.browser.navigate(`${base}/details/experience/`);
      await this.browser.waitForSelector("li.artdeco-list__item", 6_000).catch(() => {});
      const expHtml = await this.browser.getPageSource();
      const experience = extractExperienceItems(expHtml);

      await this.jitter();

      // Page 3: education
      await this.browser.navigate(`${base}/details/education/`);
      await this.browser.waitForSelector("li.artdeco-list__item", 6_000).catch(() => {});
      const eduHtml = await this.browser.getPageSource();
      const education = extractEducationItems(eduHtml);

      // Assemble full profile
      const profile: LinkedInProfile = {
        username,
        url: `${base}/`,
        fullName: mainData.fullName!,
        headline: mainData.headline,
        location: mainData.location,
        about: mainData.about,
        experience,
        education,
        skills: [],
        mutualConnectionCount: undefined,
        sharedConnections: [],
        recommendations: [],
        fetchedAt: new Date(),
      };

      return profileToExtractedContent(profile);
    } catch {
      return null;
    }
  }

  private async jitter(): Promise<void> {
    if (this.delayMs <= 0) return;
    // ±20% jitter — avoids perfectly uniform timing
    const factor = 0.8 + Math.random() * 0.4;
    await new Promise(r => setTimeout(r, Math.round(this.delayMs * factor)));
  }
}
