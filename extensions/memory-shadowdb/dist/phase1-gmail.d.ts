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
/**
 * Raw Gmail message as returned by: gog gmail get <id> --json
 * Matches the shape of the gog CLI v0.9.0 output.
 */
export interface GogGmailMessage {
    /** Plain-text or HTML body extracted by gog */
    readonly body: string;
    /** Raw headers (unused — prefer message.payload.headers) */
    readonly headers: Record<string, string>;
    /** Full Gmail API message resource */
    readonly message: {
        readonly id: string;
        readonly threadId: string;
        /** Unix timestamp in milliseconds as string */
        readonly internalDate: string;
        readonly labelIds: string[];
        readonly snippet: string;
        readonly sizeEstimate: number;
        readonly historyId: string;
        readonly payload: {
            readonly headers: Array<{
                name: string;
                value: string;
            }>;
            readonly mimeType: string;
            readonly body: {
                data?: string;
            };
            readonly parts?: GmailPart[];
        };
    };
}
/** A MIME part within a Gmail message */
interface GmailPart {
    readonly mimeType: string;
    readonly body: {
        data?: string;
        size?: number;
    };
    readonly parts?: GmailPart[];
}
/**
 * Extracted and cleaned content from a Gmail message.
 * Ready for entity filtering and chunking.
 */
export interface ExtractedContent {
    /** Gmail message id — used as source_id for deduplication */
    readonly sourceId: string;
    /** Gmail thread id */
    readonly threadId: string;
    /** Email subject line */
    readonly subject: string;
    /** Sender as raw From header value */
    readonly from: string;
    /** Message date (parsed from Date header or internalDate fallback) */
    readonly date: Date;
    /** Cleaned plain text — HTML stripped, footers removed, quotes stripped */
    readonly text: string;
    /**
     * Extracted party names from From header.
     * Format: "Display Name <email>" → ["Display Name"]
     * Plain email → ["email"]
     */
    readonly parties: string[];
}
/**
 * A single embeddable chunk from a document.
 * Multiple chunks may be produced from one ExtractedContent.
 */
export interface DocumentChunk {
    /** Chunk text — ready for embedding */
    readonly text: string;
    /** 0-based position within the parent document */
    readonly chunkIndex: number;
    /** Total number of chunks for the parent document */
    readonly chunkTotal: number;
    /** Source message id (same as ExtractedContent.sourceId) */
    readonly sourceId: string;
    /** Source thread id */
    readonly threadId: string;
    /** Document date (from parent ExtractedContent) */
    readonly date: Date;
}
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
export declare function extractGmailContent(raw: GogGmailMessage): ExtractedContent | null;
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
 *   - Hard-vetoed transactional content: receipts, shipping, order confirmations,
 *     bank/card alerts, auth codes, subscription lifecycle notices
 *
 * Newsletters and industry digests are NOT vetoed — they pass to
 * scoreInterestingness() which handles precision. A VC newsletter or founder
 * digest scores 5-7 and is worth keeping; a promo blast scores 1-2 and drops.
 *
 * NOTE: This is a FAST GATE — designed for recall, not precision.
 * Interestingness scoring (LLM) handles the precision pass.
 *
 * @param text - Plain text to analyze (should already be HTML-stripped)
 * @returns    - true if text contains named entities worth indexing
 */
export declare function passesEntityFilter(text: string): boolean;
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
export declare function chunkDocument(content: ExtractedContent, maxTokens?: number): DocumentChunk[];
export {};
