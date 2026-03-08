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
import { parse } from "node-html-parser";
// ============================================================================
// parseContactProfile — pure function
// ============================================================================
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
export function parseContactProfile(html, username) {
    try {
        const root = parse(html);
        // Name — required; return null if missing
        const nameEl = root.querySelector("h1.text-heading-xlarge");
        const fullName = nameEl?.textContent?.trim() ?? "";
        if (!fullName)
            return null;
        const headline = root.querySelector(".text-body-medium.break-words")?.textContent?.trim();
        const location = root.querySelector(".text-body-small.inline.t-black--light.break-words")?.textContent?.trim();
        // About — first span[aria-hidden="true"] under #about with >20 chars
        const about = parseAbout(root);
        const experience = parseExperienceSection(root, "#experience");
        const education = parseEducationSection(root, "#education");
        const recommendations = parseRecommendations(root);
        const url = `https://www.linkedin.com/in/${username}/`;
        return {
            username,
            url,
            fullName,
            headline,
            location,
            about,
            experience,
            education,
            skills: [],
            mutualConnectionCount: undefined,
            sharedConnections: [],
            recommendations,
            fetchedAt: new Date(),
        };
    }
    catch {
        return null;
    }
}
// ============================================================================
// profileToExtractedContent — pure function
// ============================================================================
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
export function profileToExtractedContent(profile) {
    if (!profile.fullName)
        return null;
    const lines = [];
    lines.push(`Name: ${profile.fullName}`);
    if (profile.headline)
        lines.push(`Headline: ${profile.headline}`);
    if (profile.location)
        lines.push(`Location: ${profile.location}`);
    if (profile.about) {
        lines.push(`\nAbout:\n${profile.about}`);
    }
    if (profile.experience.length > 0) {
        lines.push("\nExperience:");
        for (const exp of profile.experience) {
            const dates = [exp.startDate, exp.endDate].filter(Boolean).join(" - ");
            lines.push(`  ${exp.title} at ${exp.company}${dates ? ` (${dates})` : ""}`);
            if (exp.description)
                lines.push(`    ${exp.description}`);
        }
    }
    if (profile.education.length > 0) {
        lines.push("\nEducation:");
        for (const edu of profile.education) {
            const deg = [edu.degree, edu.field].filter(Boolean).join(", ");
            const years = edu.startYear && edu.endYear ? ` (${edu.startYear}–${edu.endYear})` : "";
            lines.push(`  ${edu.school}${deg ? ` — ${deg}` : ""}${years}`);
        }
    }
    if (profile.recommendations.length > 0) {
        lines.push("\nRecommendations:");
        for (const rec of profile.recommendations) {
            const dir = rec.direction === "received" ? "from" : "for";
            lines.push(`  ${dir} ${rec.authorName}${rec.authorTitle ? ` (${rec.authorTitle})` : ""}:`);
            lines.push(`    "${rec.text}"`);
        }
    }
    const text = lines.join("\n");
    // parties = profile subject + all companies mentioned in experience
    const parties = [profile.fullName];
    for (const exp of profile.experience) {
        if (exp.company && !parties.includes(exp.company))
            parties.push(exp.company);
    }
    return {
        sourceId: `linkedin:profile:${profile.username}`,
        threadId: profile.username,
        subject: `LinkedIn Profile: ${profile.fullName}`,
        from: profile.fullName,
        date: profile.fetchedAt,
        text,
        parties,
    };
}
// ============================================================================
// extractEdgeSignals — pure function
// ============================================================================
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
export function extractEdgeSignals(profile, selfName) {
    const signals = [];
    try {
        const sourceId = `linkedin:profile:${profile.username}`;
        const fromCandidate = {
            type: "person",
            name: profile.fullName,
            linkedinUrl: profile.url,
            sourceId,
            sourceRecordId: profile.username,
            confidence: 0.95,
        };
        // Experience → works_at (current) or worked_at (past)
        for (const exp of profile.experience) {
            if (!exp.company)
                continue;
            const isCurrent = !exp.endDate || exp.endDate.toLowerCase().includes("present");
            const edgeType = isCurrent ? "works_at" : "worked_at";
            const confidence = isCurrent ? 0.95 : 0.80;
            signals.push({
                fromCandidate,
                toCandidate: {
                    type: "company",
                    companyName: exp.company,
                    sourceId,
                    sourceRecordId: `${profile.username}:exp:${exp.company}`,
                    confidence,
                },
                type: edgeType,
                confidence,
                evidenceText: `${exp.title} at ${exp.company}`,
                sourceId,
            });
        }
        // Education → member_of school
        for (const edu of profile.education) {
            if (!edu.school)
                continue;
            signals.push({
                fromCandidate,
                toCandidate: {
                    type: "school",
                    name: edu.school,
                    companyName: edu.school, // dual-populate for resolver compatibility
                    sourceId,
                    sourceRecordId: `${profile.username}:edu:${edu.school}`,
                    confidence: 0.85,
                },
                type: "member_of",
                confidence: 0.85,
                evidenceText: edu.degree ? `${edu.degree} at ${edu.school}` : edu.school,
                sourceId,
            });
        }
        // Recommendations received → referred edge (author → subject)
        for (const rec of profile.recommendations) {
            if (!rec.authorName || rec.authorName === selfName)
                continue;
            if (rec.direction !== "received")
                continue;
            signals.push({
                // Edge is FROM the recommender TO the profile subject
                fromCandidate: {
                    type: "person",
                    name: rec.authorName,
                    title: rec.authorTitle,
                    sourceId,
                    sourceRecordId: `${profile.username}:rec:${rec.authorName}`,
                    confidence: 0.75,
                },
                toCandidate: fromCandidate,
                type: "referred",
                confidence: 0.90,
                evidenceText: rec.text.slice(0, 100),
                sourceId,
            });
        }
        // Shared connections → knows edges
        for (const conn of profile.sharedConnections) {
            if (!conn || conn === selfName)
                continue;
            signals.push({
                fromCandidate,
                toCandidate: {
                    type: "person",
                    name: conn,
                    sourceId,
                    sourceRecordId: `${profile.username}:mutual:${conn}`,
                    confidence: 0.60,
                },
                type: "knows",
                confidence: 0.70,
                evidenceText: `Shared connection: ${conn}`,
                sourceId,
            });
        }
    }
    catch {
        // Never throw — return whatever signals were collected before the error
    }
    return signals;
}
// ============================================================================
// Internal parsing helpers
// ============================================================================
function parseAbout(root) {
    const aboutSection = root.querySelector("#about");
    if (!aboutSection)
        return undefined;
    // Walk up to the containing section, then find spans
    const section = aboutSection.closest("section") ?? aboutSection.parentNode;
    if (!section)
        return undefined;
    const spans = section.querySelectorAll('span[aria-hidden="true"]');
    for (const span of spans) {
        const text = span.textContent?.trim() ?? "";
        if (text.length > 20 && text !== "About")
            return text;
    }
    return undefined;
}
function parseExperienceSection(root, sectionId) {
    const results = [];
    try {
        // Find the section element containing the anchor id, then query within it.
        // node-html-parser does not support CSS general sibling combinators (~ *).
        const anchor = root.querySelector(sectionId);
        if (!anchor)
            return results;
        const section = (anchor.closest("section") ?? anchor.parentNode);
        if (!section)
            return results;
        const items = section.querySelectorAll("li.artdeco-list__item");
        for (const li of items) {
            try {
                const title = li.querySelector(".t-bold span")?.textContent?.trim();
                if (!title)
                    continue;
                // company = first .t-14.t-normal span (NOT .t-black--light)
                const allNormal = li.querySelectorAll(".t-14.t-normal span");
                let company = "";
                let datesText = "";
                for (const span of allNormal) {
                    const parent = span.parentNode;
                    const parentClass = parent?.classNames ?? "";
                    if (parentClass.includes("t-black--light")) {
                        datesText = span.textContent?.trim() ?? "";
                    }
                    else if (!company) {
                        company = span.textContent?.trim() ?? "";
                    }
                }
                if (!company)
                    continue;
                const { startDate, endDate } = parseDateRange(datesText);
                results.push({ title, company, startDate, endDate });
            }
            catch {
                // Skip malformed entries
            }
        }
    }
    catch {
        // Return whatever was collected
    }
    return results;
}
function parseEducationSection(root, sectionId) {
    const results = [];
    try {
        const anchor = root.querySelector(sectionId);
        if (!anchor)
            return results;
        const section = (anchor.closest("section") ?? anchor.parentNode);
        if (!section)
            return results;
        const items = section.querySelectorAll("li.artdeco-list__item");
        for (const li of items) {
            try {
                const school = li.querySelector(".t-bold span")?.textContent?.trim();
                if (!school)
                    continue;
                const allNormal = li.querySelectorAll(".t-14.t-normal span");
                let degreeField = "";
                let yearsText = "";
                for (const span of allNormal) {
                    const parent = span.parentNode;
                    const parentClass = parent?.classNames ?? "";
                    if (parentClass.includes("t-black--light")) {
                        yearsText = span.textContent?.trim() ?? "";
                    }
                    else if (!degreeField) {
                        degreeField = span.textContent?.trim() ?? "";
                    }
                }
                // Parse "MBA, Finance" → degree + field
                const [degree, field] = degreeField.split(",").map(s => s.trim());
                // Parse years "2016 - 2018"
                const yearMatch = yearsText.match(/(\d{4})\s*[-–]\s*(\d{4})/);
                const startYear = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
                const endYear = yearMatch ? parseInt(yearMatch[2], 10) : undefined;
                results.push({ school, degree: degree || undefined, field: field || undefined, startYear, endYear });
            }
            catch {
                // Skip
            }
        }
    }
    catch {
        // Return whatever was collected
    }
    return results;
}
function parseRecommendations(root) {
    const results = [];
    try {
        const section = root.querySelector("#recommendations");
        if (!section)
            return results;
        const items = root.querySelectorAll("#recommendations li.artdeco-list__item");
        for (const li of items) {
            try {
                const authorName = li.querySelector(".t-bold span")?.textContent?.trim();
                if (!authorName)
                    continue;
                const authorTitle = li.querySelector(".t-14.t-normal span")?.textContent?.trim();
                const text = li.querySelector(".pv-recommendation-entity__text span")?.textContent?.trim()
                    ?? li.querySelector('span[aria-hidden="true"]:last-child')?.textContent?.trim()
                    ?? "";
                if (!text)
                    continue;
                results.push({ authorName, authorTitle, text, direction: "received" });
            }
            catch {
                // Skip
            }
        }
    }
    catch {
        // Return whatever was collected
    }
    return results;
}
/**
 * Parse a LinkedIn date range string into startDate and endDate.
 * Input examples: "Jan 2022 - Present · 3 yrs", "Jun 2018 - Dec 2021 · 3 yrs 6 mos"
 */
function parseDateRange(text) {
    if (!text)
        return {};
    // Strip duration suffix after "·"
    const clean = text.split("·")[0].trim();
    const parts = clean.split(/\s*[-–]\s*/);
    const startDate = parts[0]?.trim() || undefined;
    const endDate = parts[1]?.trim() || undefined;
    return { startDate, endDate };
}
//# sourceMappingURL=phase4-profile-linkedin.js.map