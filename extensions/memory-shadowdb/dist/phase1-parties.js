/**
 * phase1-parties.ts — Party resolution: fuzzy-match extracted names to ShadowDB contacts
 *
 * Resolves named parties extracted from ingested documents (email From headers,
 * PDF signatories, etc.) against existing ShadowDB contact records.
 *
 * Contact title format in DB: "First Last — Dossier (Type)"
 * Name is extracted as everything before the " — " (em dash) separator.
 *
 * Matching strategy (in order):
 *   1. Exact match (case-insensitive) on extracted name → score 1.0
 *   2. Exact match after stripping suffixes (PhD, Jr, III, etc.) → score 0.95
 *   3. All query tokens appear in contact name → score 0.80
 *   4. Single token match (last name only) — only if unambiguous → score 0.70
 *   5. No match → memoryId null, score 0
 *
 * NEVER throws — DB errors yield null memoryId for all parties.
 *
 * @module phase1-parties
 */
// ============================================================================
// Constants
// ============================================================================
/** Categories to search for contacts */
const CONTACT_CATEGORIES = ['contacts', 'persons', 'people'];
/**
 * Suffixes to strip before matching (case-insensitive).
 * Handles academic titles, generational suffixes, credentials.
 */
const NAME_SUFFIXES = /,?\s*(PhD|MD|JD|MBA|CPA|CFA|CEcD|Jr\.?|Sr\.?|II|III|IV|Esq\.?)$/i;
/** Score thresholds */
const SCORE_EXACT = 1.0;
const SCORE_SUFFIX_STRIP = 0.95;
const SCORE_ALL_TOKENS = 0.80;
const SCORE_SINGLE_TOKEN = 0.70;
const SCORE_NO_MATCH = 0;
/** Minimum match score to accept a result (rejects very weak matches) */
const MIN_ACCEPT_SCORE = SCORE_SINGLE_TOKEN;
export async function resolveParties(parties, db, resolver) {
    if (parties.length === 0)
        return [];
    // Fetch all contact records once — cheaper than per-name queries at our scale
    let contacts;
    try {
        const placeholders = CONTACT_CATEGORIES.map((_, i) => `$${i + 1}`).join(', ');
        const result = await db.query(`SELECT id, title, category
       FROM memories
       WHERE category IN (${placeholders})
         AND deleted_at IS NULL
       ORDER BY id`, CONTACT_CATEGORIES);
        contacts = result.rows;
    }
    catch {
        // DB failure — return all null, never throw
        return parties.map((name) => ({ name, memoryId: null, matchScore: SCORE_NO_MATCH }));
    }
    // Build lookup: contact name (normalized) → row
    const contactIndex = buildContactIndex(contacts);
    const results = parties.map((party) => matchParty(party, contactIndex));
    // Fire-and-forget: register each party as an EntityCandidate in the resolver.
    // This builds the entity graph incrementally as messages are ingested.
    // Errors are swallowed — resolver failure never blocks ingestion.
    if (resolver) {
        for (const party of parties) {
            resolver.resolve({
                type: "person",
                name: party,
                sourceId: "parties",
                sourceRecordId: `parties:${party}`,
                confidence: 0.50, // name-only — resolver applies its own confidence logic
            }).catch(() => { });
        }
    }
    return results;
}
/**
 * Extract and normalize contact names from DB rows.
 * Title format: "First Last — Dossier (Type)" → extract "First Last"
 */
function buildContactIndex(rows) {
    return rows.map((row) => {
        // Extract name part: everything before " — " (em dash) or end of string
        const rawName = row.title.split(/\s+[—–-]\s+/)[0].trim();
        // Strip suffixes for normalization
        const normalizedName = stripSuffix(rawName).toLowerCase();
        const tokens = normalizedName.split(/\s+/).filter(Boolean);
        return { id: row.id, normalizedName, tokens };
    });
}
/**
 * Match a single party name against the contact index.
 * Returns the best match above MIN_ACCEPT_SCORE, or a null result.
 */
function matchParty(party, index) {
    if (!party.trim())
        return { name: party, memoryId: null, matchScore: SCORE_NO_MATCH };
    const queryNorm = party.toLowerCase().trim();
    const queryStrip = stripSuffix(queryNorm).toLowerCase();
    const queryTokens = queryStrip.split(/\s+/).filter(Boolean);
    let bestId = null;
    let bestScore = SCORE_NO_MATCH;
    let bestCount = 0; // track how many contacts tied at bestScore (for ambiguity detection)
    for (const contact of index) {
        const score = computeMatchScore(queryNorm, queryStrip, queryTokens, contact);
        if (score > bestScore) {
            bestScore = score;
            bestId = contact.id;
            bestCount = 1;
        }
        else if (score === bestScore && score > SCORE_NO_MATCH) {
            bestCount++;
        }
    }
    // Ambiguity check: if multiple contacts tied at a weak score, reject
    if (bestCount > 1 && bestScore < SCORE_ALL_TOKENS) {
        return { name: party, memoryId: null, matchScore: SCORE_NO_MATCH };
    }
    if (bestScore < MIN_ACCEPT_SCORE) {
        return { name: party, memoryId: null, matchScore: SCORE_NO_MATCH };
    }
    return { name: party, memoryId: bestId, matchScore: bestScore };
}
/**
 * Compute match score between a query and a single contact.
 * Returns the highest applicable score.
 */
function computeMatchScore(queryNorm, queryStrip, queryTokens, contact) {
    const cn = contact.normalizedName;
    // 1. Exact match (case-insensitive)
    if (queryNorm === cn || queryStrip === cn)
        return SCORE_EXACT;
    // 2. Match after stripping suffixes from contact name too
    const cnStrip = stripSuffix(cn);
    if (queryStrip === cnStrip)
        return SCORE_SUFFIX_STRIP;
    // 3. All query tokens appear in contact name tokens
    if (queryTokens.length > 1 && queryTokens.every((t) => contact.tokens.includes(t))) {
        return SCORE_ALL_TOKENS;
    }
    // 4. Single-token query matches a contact token (unambiguity checked by caller)
    if (queryTokens.length === 1 && contact.tokens.includes(queryTokens[0])) {
        return SCORE_SINGLE_TOKEN;
    }
    return SCORE_NO_MATCH;
}
/**
 * Strip academic/professional suffixes from a name string.
 * "Dave Smith, PhD" → "Dave Smith"
 */
function stripSuffix(name) {
    return name.replace(NAME_SUFFIXES, '').trim();
}
//# sourceMappingURL=phase1-parties.js.map