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

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Constants
// ============================================================================

/**
 * Default score returned when LLM fails or returns an unparseable response.
 * 5 = "neutral" — neither promoted nor filtered out by threshold checks.
 * Callers using threshold ≥ 6 will reject these; threshold ≥ 5 will keep them.
 */
export const DEFAULT_SCORE = 5;

/** Maximum characters sent to LLM (~500 tokens at 4 chars/token) */
const MAX_CHARS = 2000;

/** Score range */
const SCORE_MIN = 0;
const SCORE_MAX = 10;

// ============================================================================
// Public API
// ============================================================================

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
export async function scoreInterestingness(
  text: string,
  metadata: ScoringMetadata,
  llm: LlmClient,
): Promise<number> {
  try {
    const prompt = buildPrompt(text, metadata);
    const response = await llm.complete(prompt);
    return parseScore(response);
  } catch {
    return DEFAULT_SCORE;
  }
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Build the scoring prompt.
 *
 * Designed to elicit a single-number response from small, instruction-following
 * models (GLM-5, Llama 3.1 8B). Deliberately short to minimize token cost.
 */
function buildPrompt(text: string, metadata: ScoringMetadata): string {
  const truncated = text.slice(0, MAX_CHARS);
  const contextLines: string[] = [];

  if (metadata.subject) {
    contextLines.push(`Subject: ${metadata.subject}`);
  }
  if (metadata.parties && metadata.parties.length > 0) {
    contextLines.push(`Parties: ${metadata.parties.join(', ')}`);
  }
  if (metadata.docType) {
    contextLines.push(`Type: ${metadata.docType}`);
  }

  const contextBlock = contextLines.length > 0
    ? `\n${contextLines.join('\n')}\n`
    : '';

  return `You are evaluating whether a business email or document is worth storing in a personal CRM intelligence system for a venture capital investor.

Score the following content for business relevance on a scale of 0 to 10, where:
0-3 = spam, receipts, automated notifications, unsubscribe confirmations
4-5 = personal email, generic updates, low-signal correspondence
6-7 = relevant business communication — mentions deals, companies, or contacts
8-9 = high-signal — term sheets, investment discussions, commitments, negotiations
10 = critical — signed contracts, legal obligations, explicit agreements
${contextBlock}
Content:
${truncated}

Respond with ONLY a single number from 0 to 10. No explanation.`;
}

/**
 * Parse a score from LLM completion text.
 *
 * Handles formats:
 *   - Plain number: "8"
 *   - "Score: 7.5"
 *   - Number embedded in text: "I rate this 9 out of 10"
 *
 * Returns DEFAULT_SCORE if no parseable number is found.
 * Always clamps to [SCORE_MIN, SCORE_MAX].
 *
 * @param response - Raw LLM completion text
 * @returns        - Parsed and clamped score in [0, 10]
 */
function parseScore(response: string): number {
  if (!response) return DEFAULT_SCORE;

  // Strip thinking blocks — Qwen3 models emit <think>...</think> or
  // "Thinking Process:\n..." before the actual answer. Remove it.
  let cleaned = response
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/Thinking Process[\s\S]*?(?=\n\n\d|\n\n[A-Z]|$)/i, "")
    .trim();

  // If cleaning consumed everything, fall back to full response
  if (!cleaned) cleaned = response;

  // Extract ALL numbers (including negative). The LAST one is most likely
  // the final answer when the model reasons before concluding.
  const matches = [...cleaned.matchAll(/(-?\d+(?:\.\d+)?)/g)];
  if (!matches.length) return DEFAULT_SCORE;

  // Use last match — model concludes with the score after reasoning
  const parsed = parseFloat(matches[matches.length - 1][1]);
  if (isNaN(parsed)) return DEFAULT_SCORE;

  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, parsed));
}
