/**
 * phase1-scoring.ts — LLM-based interestingness scoring for ingested documents
 *
 * Implements the second gate in the ingestion pipeline (after passesEntityFilter).
 * Sends the first ~500 tokens of a document to a fast LLM and asks it to score
 * business relevance on a 0-10 scale.
 *
 * Design principles:
 * - Dependency-injected LLM client — fully mockable, no global state
 * - NEVER throws — returns DEFAULT_SCORE (5) on any failure
 * - Score is always clamped to [0, 10]
 * - Prompt is designed to be cheap: short, single-number output expected
 *
 * Typical LLM targets:
 *   - GLM-5 via z.ai API (fast, cheap, good instruction following)
 *   - Groq llama3.1-8b (very fast, good for classification)
 *   - Either model via OpenAI-compatible API
 *
 * Insertion point in ingestion pipeline:
 *   extractGmailContent()
 *   → passesEntityFilter()      ← fast regex gate
 *   → scoreInterestingness()    ← LLM gate (this module)
 *   → chunkDocument()
 *   → embed + store
 */
/**
 * Minimal LLM client interface required by scoreInterestingness().
 * Inject a real client (OpenAI-compatible) or a mock for testing.
 *
 * The complete() method should return the raw completion text.
 * Error handling (retries, timeouts) should be done by the implementation.
 */
export interface LlmClient {
    /**
     * Send a prompt and return the completion text.
     * May throw on network errors or API failures.
     *
     * @param prompt  - Full prompt string to send
     * @returns       - Raw completion text from the model
     */
    complete(prompt: string): Promise<string>;
}
/**
 * Optional metadata to include in the scoring prompt.
 * Improves scoring accuracy by giving the model context about the document.
 */
export interface ScoringMetadata {
    /** Email subject line */
    subject?: string;
    /** Named parties extracted from the document */
    parties?: string[];
    /** Document type hint */
    docType?: string;
}
/**
 * Default score returned when LLM fails or returns an unparseable response.
 * 5 = "neutral" — neither promoted nor filtered out by threshold checks.
 * Callers using threshold ≥ 6 will reject these; threshold ≥ 5 will keep them.
 */
export declare const DEFAULT_SCORE = 5;
/**
 * Score the business relevance of a document using a fast LLM.
 *
 * Sends the first MAX_CHARS characters of the text to the LLM with a
 * structured prompt asking for a single integer score 0-10.
 *
 * Score interpretation:
 *   0-3: Spam, receipts, automated notifications, irrelevant
 *   4-5: Marginally relevant — personal correspondence, generic updates
 *   6-7: Relevant — business communication, mentions deals or contacts
 *   8-9: Highly relevant — term sheets, commitments, deal-stage emails
 *  10:   Critical — contracts, signed agreements, explicit obligations
 *
 * NEVER throws. Returns DEFAULT_SCORE (5) on any error.
 *
 * @param text      - Document plain text (will be truncated to MAX_CHARS)
 * @param metadata  - Optional context: subject, parties, docType
 * @param llm       - LLM client implementation (injected for testability)
 * @returns         - Relevance score in [0, 10]
 */
export declare function scoreInterestingness(text: string, metadata: ScoringMetadata, llm: LlmClient): Promise<number>;
