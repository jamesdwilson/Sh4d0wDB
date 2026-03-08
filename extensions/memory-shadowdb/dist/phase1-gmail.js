/**
 * phase1-gmail.ts — Gmail content extraction and ingestion pipeline
 *
 * Implements the first stage of Phase 1: extract, filter, and chunk Gmail
 * messages for embedding and storage in ShadowDB.
 *
 * Pipeline per message:
 *   1. extractGmailContent()   — strip HTML, footers, quoted replies; parse metadata
 *   2. passesEntityFilter()    — fast gate: skip if no named entities, money, dates, or commitments
 *   3. scoreInterestingness()  — LLM gate (in phase1-gmail-scoring.ts): skip if score < threshold
 *   4. chunkDocument()         — split into embeddable segments with overlap
 *
 * All functions are pure where possible. No DB writes here — caller handles storage.
 * Designed for idempotent operation: caller keys on sourceId to detect duplicates.
 *
 * Data source: gog CLI (gog gmail get <id> --json --account <email>)
 * Output shape compatible with: documents table + memories chunks
 */
// ============================================================================
// Constants
// ============================================================================
/**
 * Regex patterns for stripping quoted reply sections.
 * Matches common email client quote formats:
 *   - Lines starting with >
 *   - "On [date], [person] wrote:" and following content
 */
const QUOTE_PATTERNS = [
    /^>.*$/gm,
    /^On .+wrote:$/gm,
];
/**
 * Regex patterns for stripping email footers and signatures.
 * Applied line by line — remove line and everything after if matched.
 */
const FOOTER_TRIGGERS = [
    /^--\s*$/m, // Standard signature delimiter
    /^Sent from my (iPhone|Android|iPad|mobile)/im,
    /^Unsubscribe/im,
    /^View (this email |in browser)/im,
    /^To unsubscribe/im,
    /^This email was sent to/im,
    /^You're receiving this (email|message)/im,
    /^CONFIDENTIALITY NOTICE/im,
    /^This message (is|contains) (confidential|privileged)/im,
];
/**
 * Entity detection patterns for passesEntityFilter().
 * A document passes if ANY of these match.
 *
 * Design: fast regex-only gate — no LLM, no external calls.
 * Intentionally broad — false positives are fine; false negatives waste embeddings.
 */
const ENTITY_PATTERNS = [
    // Dollar amounts: $1,000 / $2M / $500K / $1.5B
    /\$[\d,]+(\.\d+)?[KMBkmb]?/,
    // Percentages in financial context: 20% / 15.5%
    /\d+(\.\d+)?%\s*(equity|ownership|stake|interest|return|IRR|MOIC)/i,
    // Dates: March 15, 2026 / Mar 15 / 2026-03-15 / 03/15/2026
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(,?\s+\d{4})?/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
    // Commitment verbs: agree, shall, will, must, commit, warrant
    /\b(agree(s|d)?|shall|commit(s|ted)?|warrant(s|ed)?|oblig(ate|ation)|covenant)\b/i,
    // Deal terms
    /\b(term sheet|SAFE|convertible note|Series [A-Z]|pro.rata|MFN|valuation|cap table|vesting|cliff|liquidation preference)\b/i,
    // Named entities: Capitalized proper nouns (2+ words) — crude NER
    /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/,
    // Email addresses (potential contacts)
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    // Company-like names: "XYZ Capital", "ABC Ventures", "Sequoia", etc.
    /\b[A-Z][a-zA-Z]+\s+(Capital|Ventures?|Partners?|Fund|Group|Holdings?|Inc|LLC|Corp|Ltd)\b/i,
];
/**
 * Patterns that, if the ENTIRE text matches or is dominated by them,
 * indicate the message is a transactional/automated email not worth indexing.
 * Used to veto passesEntityFilter even if other patterns matched.
 */
const SPAM_VETO_PATTERNS = [
    /your (order|package|shipment|delivery|receipt|subscription)/i,
    /track(ing)? (your )?(package|order|shipment)/i,
    /unsubscribe|mailing list|email preferences/i,
];
/** Approximate chars per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;
/** Default max tokens per chunk */
const DEFAULT_MAX_TOKENS = 400;
/** Overlap between adjacent chunks in characters */
const CHUNK_OVERLAP_CHARS = 200;
// ============================================================================
// Public API
// ============================================================================
/**
 * Extract and clean content from a Gmail message.
 *
 * Steps:
 *   1. Parse headers (From, Subject, Date) from payload.headers
 *   2. Strip HTML tags from body
 *   3. Strip quoted reply sections
 *   4. Strip email footers/signatures
 *   5. Normalize whitespace
 *   6. Extract party names from From header
 *
 * Returns null if the cleaned text is effectively empty (< 20 chars).
 *
 * @param raw - Gmail message object from gog CLI --json output
 * @returns   - Extracted content, or null if message is empty after cleaning
 */
export function extractGmailContent(raw) {
    const { message } = raw;
    const headerMap = buildHeaderMap(message.payload.headers);
    const subject = headerMap['subject'] ?? '(no subject)';
    const from = headerMap['from'] ?? '';
    const dateStr = headerMap['date'] ?? '';
    // Parse date: prefer Date header, fall back to internalDate (ms timestamp)
    const date = parseDateHeader(dateStr, message.internalDate);
    // Extract body text
    let text = raw.body ?? '';
    // Strip HTML
    text = stripHtml(text);
    // Strip quoted replies
    text = stripQuotedReplies(text);
    // Strip footers/signatures
    text = stripFooters(text);
    // Normalize whitespace
    text = normalizeWhitespace(text);
    // Reject if effectively empty
    if (text.length < 20)
        return null;
    const parties = extractParties(from);
    return {
        sourceId: message.id,
        threadId: message.threadId,
        subject,
        from,
        date,
        text,
        parties,
    };
}
/**
 * Fast entity filter — determines if a document contains enough signal
 * to be worth LLM scoring and embedding.
 *
 * Returns true if the text contains ANY of:
 *   - Dollar amounts ($1M, $500K, etc.)
 *   - Dates (March 15, 2026 / 2026-03-15 / etc.)
 *   - Commitment verbs (agree, shall, commit, etc.)
 *   - Deal terms (term sheet, SAFE, Series A, etc.)
 *   - Named person or company (Capitalized multi-word, "XYZ Capital", etc.)
 *   - Email addresses
 *
 * Returns false for:
 *   - Empty text
 *   - Transactional/automated emails (shipment, receipt, mailing list)
 *     that lack meaningful entities
 *
 * NOTE: This is a FAST GATE — designed for recall, not precision.
 * Interestingness scoring (LLM) handles the precision pass.
 *
 * @param text - Plain text to analyze (should already be HTML-stripped)
 * @returns    - true if text contains named entities worth indexing
 */
export function passesEntityFilter(text) {
    if (!text || text.trim().length === 0)
        return false;
    // Check for spam veto first — these override entity matches
    const isSpam = SPAM_VETO_PATTERNS.some((p) => p.test(text)) &&
        !ENTITY_PATTERNS.slice(0, 6).some((p) => p.test(text)); // Allow if strong deal signals
    if (isSpam)
        return false;
    // Pass if ANY entity pattern matches
    return ENTITY_PATTERNS.some((pattern) => pattern.test(text));
}
/**
 * Chunk a document into embeddable segments.
 *
 * Chunking strategy:
 *   - Short text (≤ maxTokens): single chunk, no split
 *   - Long text: split at paragraph boundaries (double newlines)
 *   - Each chunk is at most maxTokens tokens (~maxTokens * 4 chars)
 *   - Adjacent chunks overlap by CHUNK_OVERLAP_CHARS to preserve context
 *
 * Each chunk carries the parent document's sourceId, threadId, and date
 * so it can be linked back to its document record.
 *
 * @param content   - Extracted document content
 * @param maxTokens - Maximum tokens per chunk (default: 400)
 * @returns         - Array of DocumentChunk objects; empty if text is empty
 */
export function chunkDocument(content, maxTokens = DEFAULT_MAX_TOKENS) {
    const { text, sourceId, threadId, date } = content;
    if (!text || text.trim().length === 0)
        return [];
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    // Short text: single chunk
    if (text.length <= maxChars) {
        return [{
                text: text.trim(),
                chunkIndex: 0,
                chunkTotal: 1,
                sourceId,
                threadId,
                date,
            }];
    }
    // Long text: split at paragraph boundaries then merge into max-size chunks
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    const rawChunks = [];
    let current = '';
    for (const para of paragraphs) {
        const candidate = current ? `${current}\n\n${para}` : para;
        if (candidate.length <= maxChars) {
            current = candidate;
        }
        else {
            if (current)
                rawChunks.push(current.trim());
            // Para itself may exceed maxChars — split by sentence if needed
            if (para.length > maxChars) {
                const sentences = para.match(/[^.!?]+[.!?]+/g) ?? [para];
                let sentChunk = '';
                for (const sent of sentences) {
                    const sentCandidate = sentChunk ? `${sentChunk} ${sent}` : sent;
                    if (sentCandidate.length <= maxChars) {
                        sentChunk = sentCandidate;
                    }
                    else {
                        if (sentChunk)
                            rawChunks.push(sentChunk.trim());
                        sentChunk = sent.slice(0, maxChars);
                    }
                }
                if (sentChunk)
                    rawChunks.push(sentChunk.trim());
                current = '';
            }
            else {
                current = para;
            }
        }
    }
    if (current.trim())
        rawChunks.push(current.trim());
    // Add overlap: prepend tail of previous chunk to each chunk
    const chunksWithOverlap = rawChunks.map((chunk, i) => {
        if (i === 0)
            return chunk;
        const prev = rawChunks[i - 1];
        const overlap = prev.slice(-CHUNK_OVERLAP_CHARS);
        return `${overlap}\n\n${chunk}`;
    });
    const total = chunksWithOverlap.length;
    return chunksWithOverlap.map((text, i) => ({
        text,
        chunkIndex: i,
        chunkTotal: total,
        sourceId,
        threadId,
        date,
    }));
}
// ============================================================================
// Private helpers
// ============================================================================
/**
 * Build a lowercase header name → value map from Gmail payload headers.
 * Later headers override earlier ones (matches Gmail API behavior).
 */
function buildHeaderMap(headers) {
    const map = {};
    for (const h of headers) {
        if (h.name && h.value) {
            map[h.name.toLowerCase()] = h.value;
        }
    }
    return map;
}
/**
 * Parse an email Date header string to a Date object.
 * Falls back to internalDate (Unix ms as string) if header is missing/invalid.
 */
function parseDateHeader(dateStr, internalDate) {
    if (dateStr) {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime()))
            return parsed;
    }
    // Fallback: internalDate is Unix ms as string
    const ts = parseInt(internalDate, 10);
    if (!isNaN(ts) && ts > 0)
        return new Date(ts);
    return new Date();
}
/**
 * Strip HTML tags and decode common HTML entities.
 * Preserves whitespace structure (converts <br>, <p>, <div> to newlines).
 */
function stripHtml(html) {
    return html
        // Convert block-level elements to newlines
        .replace(/<\/(p|div|br|li|tr|h[1-6])\s*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        // Remove all remaining tags
        .replace(/<[^>]+>/g, '')
        // Decode common HTML entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–')
        // Collapse excessive whitespace
        .replace(/[ \t]+/g, ' ');
}
/**
 * Strip quoted reply sections from email body.
 * Removes lines starting with > and "On [date], [name] wrote:" headers.
 */
function stripQuotedReplies(text) {
    const lines = text.split('\n');
    const result = [];
    let inQuote = false;
    for (const line of lines) {
        // Detect "On ... wrote:" pattern — start of quoted section
        if (/^On .+wrote:\s*$/.test(line.trim())) {
            inQuote = true;
            continue;
        }
        // Quoted line
        if (line.trimStart().startsWith('>')) {
            inQuote = false; // reset — individual quoted lines don't extend inQuote
            continue;
        }
        inQuote = false;
        result.push(line);
    }
    return result.join('\n');
}
/**
 * Strip email footers and signatures.
 * Finds the first footer trigger and removes everything from that line onward.
 */
function stripFooters(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (FOOTER_TRIGGERS.some((p) => p.test(lines[i]))) {
            return lines.slice(0, i).join('\n');
        }
    }
    return text;
}
/**
 * Normalize whitespace: collapse multiple blank lines to one,
 * trim leading/trailing whitespace.
 */
function normalizeWhitespace(text) {
    return text
        .replace(/\n{3,}/g, '\n\n') // max 2 consecutive newlines
        .trim();
}
/**
 * Extract display names from a From header.
 * "John Smith <john@example.com>" → ["John Smith"]
 * "john@example.com" → ["john@example.com"]
 * "John Smith" → ["John Smith"]
 */
function extractParties(from) {
    if (!from)
        return [];
    // "Display Name <email@example.com>"
    const displayNameMatch = from.match(/^([^<]+)\s*</);
    if (displayNameMatch) {
        const name = displayNameMatch[1].trim().replace(/^["']|["']$/g, '');
        if (name)
            return [name];
    }
    // Plain email address
    const emailMatch = from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch)
        return [emailMatch[1]];
    return [from.trim()];
}
//# sourceMappingURL=phase1-gmail.js.map