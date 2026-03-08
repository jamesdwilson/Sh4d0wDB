/**
 * phase4-fetcher-linkedin.ts — LinkedIn message ingestion via browser scraping
 *
 * Implements LinkedInFetcher conforming to the MessageFetcher interface.
 * Uses the OpenClaw host browser (Chrome profile with active LinkedIn session)
 * so no auth flow is needed — cookies are already present.
 *
 * Architecture:
 *   - BrowserClient is injected for full testability (mock HTML in tests)
 *   - parseThreadList / parseThreadMessages are pure functions — tested with
 *     fixture HTML that matches real LinkedIn DOM selectors (verified 2026-03-08)
 *   - threadToExtractedContent assembles thread → ExtractedContent
 *   - LinkedInFetcher wires everything into the MessageFetcher interface
 *
 * LinkedIn DOM selectors (stable as of 2026-03-08):
 *   Thread list:    li.msg-conversation-listitem
 *   Names:          .msg-conversation-listitem__participant-names
 *   Timestamp:      time.msg-conversation-listitem__time-stamp
 *   Snippet:        .msg-conversation-card__message-snippet
 *   Message group:  li.msg-s-message-list__event
 *   Sender:         .msg-s-message-group__name
 *   Msg time:       time.msg-s-message-group__timestamp
 *   Msg body:       .msg-s-event-listitem__body p
 *
 * Thread ID strategy:
 *   LinkedIn does not expose threadId in DOM attributes.
 *   The fetcher injects data-thread-id onto each <li> before calling getPageSource
 *   by running a JS snippet that reads the thread URL from each card's click handler.
 *   For the thread detail page, the threadId is read from window.location.href.
 *
 * Timestamp strategy:
 *   LinkedIn uses relative timestamps ("Mar 7", "4:24 AM", "Wednesday").
 *   We parse best-effort into a Date relative to the current year/week.
 *   Unparseable timestamps fall back to the fetch time.
 *
 * See: ARCHITECTURE.md § 3.2, INTELLIGENCE_ROADMAP.md § Phase 4
 */
import type { ExtractedContent } from "./phase1-gmail.js";
import type { MessageFetcher } from "./phase1-runner.js";
/**
 * Injectable browser abstraction.
 * Real implementation wraps the OpenClaw browser tool.
 * Test implementation returns mock HTML.
 */
export interface BrowserClient {
    /** Navigate to a URL and wait for the page to load. */
    navigate(url: string): Promise<void>;
    /** Return the current page's full HTML source. */
    getPageSource(): Promise<string>;
    /** Return the current page URL. */
    getCurrentUrl(): Promise<string>;
    /** Wait for a CSS selector to appear in the DOM (optional). */
    waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
    /** Scroll to page bottom to trigger lazy-loaded content. */
    scrollToBottom(): Promise<void>;
}
/**
 * A parsed thread entry from the LinkedIn inbox list.
 * Extracted from li.msg-conversation-listitem elements.
 */
export interface LinkedInThread {
    /** LinkedIn thread ID (base64-encoded URN like "2-abc123") */
    threadId: string;
    /** Full thread URL */
    url: string;
    /** Participant display names from the thread list */
    participants: string[];
    /** Best-effort parsed timestamp of last message */
    lastMessageAt: Date;
    /** Message preview text shown in inbox */
    snippet: string;
}
/**
 * A fully fetched thread with all visible messages.
 */
export interface LinkedInThreadContent {
    threadId: string;
    url: string;
    participants: string[];
    messages: LinkedInMessage[];
    fetchedAt: Date;
}
/**
 * A single message within a thread.
 */
export interface LinkedInMessage {
    sender: string;
    sentAt: Date;
    text: string;
}
/**
 * Parse the LinkedIn inbox HTML and return a list of thread entries.
 *
 * Reads: li.msg-conversation-listitem elements, expecting:
 *   - data-thread-id attribute (set by fetcher via JS injection)
 *   - .msg-conversation-listitem__participant-names for names
 *   - time.msg-conversation-listitem__time-stamp for timestamp text
 *   - .msg-conversation-card__message-snippet for preview
 *
 * Never throws — malformed items are skipped or given fallback values.
 *
 * @param html - Raw HTML string of the /messaging/ page
 * @returns    - Array of parsed thread entries (may be empty)
 */
export declare function parseThreadList(html: string): LinkedInThread[];
/**
 * Parse a LinkedIn thread detail page and extract all messages.
 *
 * Reads: li.msg-s-message-list__event elements, each containing:
 *   - .msg-s-message-group__name — sender display name
 *   - time.msg-s-message-group__timestamp — timestamp text
 *   - .msg-s-event-listitem__body p — message body paragraphs
 *
 * Returns null if the page has no parseable messages.
 * Never throws.
 *
 * @param html     - Raw HTML string of the thread detail page
 * @param threadId - Thread ID (used to construct the result)
 * @returns        - Parsed thread content, or null if no messages found
 */
export declare function parseThreadMessages(html: string, threadId: string): LinkedInThreadContent | null;
/**
 * Transform a LinkedInThreadContent into ShadowDB-ready ExtractedContent.
 *
 * Concatenates all messages as:
 *   "[SenderName]: message text\n\n"
 *
 * Returns null for threads with no messages.
 * Never throws.
 *
 * @param thread - Fully fetched thread
 * @returns      - ExtractedContent ready for entity filter → scoring → write, or null
 */
export declare function threadToExtractedContent(thread: LinkedInThreadContent): ExtractedContent | null;
/**
 * Evasion strategy for LinkedIn scraping.
 *
 * LinkedIn detects automation via:
 *   - Uniform inter-request timing (bots are too consistent)
 *   - Missing mouse movement / scroll events before clicks
 *   - Navigator fingerprinting (headless Chrome flags)
 *   - Suspiciously fast page transitions
 *   - High request frequency from a single session
 *
 * These fields configure the evasion layer. None are implemented yet —
 * the interface is the contract. Implementations live in BrowserClient
 * (e.g. randomized delays, human-like scroll, stealth plugin config).
 *
 * Leave all fields undefined to use safe defaults (conservative delays).
 */
export interface LinkedInEvasionConfig {
    /**
     * Jitter factor applied to delayMs: actual delay = delayMs * (1 ± jitter).
     * E.g. jitter=0.3 means delay varies ±30% — looks human, not robotic.
     * Default: 0.3. Set to 0 for deterministic delays (tests only).
     */
    jitter?: number;
    /**
     * If true, emit random mouse-move events before clicking or navigating.
     * Requires BrowserClient to implement moveMouse() — no-op if not supported.
     * Default: false (not yet implemented).
     */
    simulateMouseMovement?: boolean;
    /**
     * If true, scroll slowly through the inbox before reading threads.
     * Mimics human reading behavior; triggers lazy-load as a side effect.
     * Default: false (not yet implemented).
     */
    humanScroll?: boolean;
    /**
     * If true, randomize the order threads are fetched (not newest-first).
     * Reduces the "bot always reads in order" fingerprint.
     * Default: false.
     */
    randomizeOrder?: boolean;
    /**
     * Maximum threads to fetch in a single session before pausing.
     * LinkedIn's abuse detection is session-scoped — fetching 200 threads
     * in one session is a red flag. Use small batches and rely on watermark
     * to resume where you left off.
     * Default: 20 (conservative).
     */
    sessionBatchLimit?: number;
}
/** Options for the LinkedIn fetcher */
export interface LinkedInFetcherOptions {
    /** Maximum number of threads to return per run (default: 50) */
    maxThreads?: number;
    /**
     * Base delay in ms between thread fetches.
     * Actual delay = delayMs * (1 ± evasion.jitter).
     * Default: 2000ms — conservative. Do not set below 500ms in production.
     */
    delayMs?: number;
    /**
     * Evasion configuration. All fields are optional with safe defaults.
     * Not yet implemented — reserved for future anti-detection work.
     */
    evasion?: LinkedInEvasionConfig;
}
/**
 * LinkedIn message fetcher implementing the MessageFetcher interface.
 *
 * Uses a BrowserClient (injected) to navigate the LinkedIn messaging UI.
 * Requires an active LinkedIn session in the browser (cookies present).
 *
 * getNewMessageIds:
 *   1. Navigates to /messaging/
 *   2. Injects data-thread-id attributes onto each thread <li> via JS
 *   3. Calls getPageSource() to get the annotated HTML
 *   4. Parses thread list, filters by watermark
 *   5. Returns threadIds newer than watermark
 *
 * fetchMessage:
 *   1. Navigates to /messaging/thread/{threadId}/
 *   2. Scrolls to load all messages
 *   3. Gets page source + parses messages
 *   4. Returns ExtractedContent or null
 */
export declare class LinkedInFetcher implements MessageFetcher {
    private readonly browser;
    readonly source = "linkedin";
    private readonly maxThreads;
    private readonly delayMs;
    private readonly evasion;
    constructor(browser: BrowserClient, options?: LinkedInFetcherOptions);
    /**
     * Return threadIds for threads with messages newer than the watermark.
     * When watermark is null, returns all visible threads (up to maxThreads).
     *
     * @param watermark - Timestamp of last successful run, or null for full sync
     * @returns         - Array of threadIds to process
     */
    getNewMessageIds(watermark: Date | null): Promise<string[]>;
    /**
     * Fetch a single thread by ID and return its ExtractedContent.
     * Returns null if the thread is empty, unavailable, or on any error.
     *
     * @param threadId - Thread ID as returned by getNewMessageIds()
     * @returns        - Extracted content, or null to skip
     */
    fetchMessage(threadId: string): Promise<ExtractedContent | null>;
    /**
     * Sleep for delayMs ± jitter to avoid uniform timing fingerprint.
     *
     * With jitter=0.3 and delayMs=2000:
     *   actual delay ∈ [1400ms, 2600ms] — looks human, not robotic.
     *
     * Set delayMs=0 in tests to skip delay entirely (jitter has no effect).
     */
    private jitteredDelay;
    /**
     * Inject data-thread-id attributes onto thread list items.
     * LinkedIn doesn't expose threadId in static HTML — we read the URL
     * that each thread card would navigate to (from nested link href or
     * from clicking and reading window.location).
     *
     * This is called before getPageSource() so parseThreadList can read
     * the attribute without needing live DOM access.
     *
     * Implementation note: in production this calls browser.evaluate();
     * in tests the fixture HTML already has data-thread-id set.
     */
    private injectThreadIds;
}
/**
 * Parse LinkedIn's relative timestamp strings into a best-effort Date.
 *
 * LinkedIn uses formats like:
 *   "Mar 7"        → March 7, current year
 *   "Mar 7, 2025"  → March 7, 2025
 *   "4:24 AM"      → today at 4:24 AM
 *   "Wednesday"    → most recent Wednesday
 *   "Yesterday"    → yesterday
 *   "Just now"     → now
 *
 * Returns null if the string is empty or completely unparseable.
 * Never throws.
 */
export declare function parseLinkedInTimestamp(text: string): Date | null;
