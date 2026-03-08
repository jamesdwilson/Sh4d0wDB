/**
 * phase1-runner.ts — Gmail ingestion runner
 *
 * Orchestrates the full watermark-based Gmail ingestion pipeline:
 *
 *   1. getWatermark()         — query ingestion_runs for last completed run
 *   2. buildSearchQuery()     — construct gog gmail search query with after: date
 *   3. parseGogSearchResults()— extract thread IDs from gog search JSON
 *   4. parseGogMessage()      — parse gog gmail get --json output via extractGmailContent
 *   5. shouldIngestMessage()  — hard-veto + entity filter + LLM score gate
 *   6. chunkDocument()        — split into embeddable segments
 *   7. resolveParties()       — fuzzy-match to ShadowDB contacts
 *   8. store.write()          — idempotent write (dedup by sourceId as operationId)
 *   9. recordRun()            — write ingestion_runs row with stats
 *
 * External dependencies (gog CLI, LLM, store) are injected for testability.
 * The runner itself (runGmailIngestion) is an async function that can be
 * called from a cron job or CLI.
 *
 * Watermark: tracks `completed_at` of last successful run per source+account.
 * Re-running always produces zero duplicates (operationId = gmail message_id).
 */
import type { ExtractedContent } from "./phase1-gmail.js";
import type { LlmClient } from "./phase1-scoring.js";
import type { DbClient } from "./phase1-parties.js";
import type { DossierRecord } from "./phase3-contact-signal.js";
/**
 * Source-agnostic interface for fetching messages into the ingestion pipeline.
 *
 * Implement this interface for each message source (Gmail via gog CLI, IMAP,
 * LinkedIn, etc.). The runner only depends on this interface — it has no
 * knowledge of gog, IMAP, or any specific protocol.
 *
 * Current implementations:
 *   - GmailFetcher (below) — gog CLI, single account
 *
 * Future implementations:
 *   - ImapFetcher — raw IMAP for any mailbox
 *   - LinkedInFetcher — LinkedIn messages via browser automation
 *
 * @example
 *   const fetcher = new GmailFetcher({ account: "alice@example.com", maxResults: 100 });
 *   const runner = await runIngestion(config, db, store, llm, fetcher);
 */
export interface MessageFetcher {
    /**
     * Identifies the source system. Stored in ingestion_runs.source.
     * Use a stable lowercase string: "gmail", "imap", "linkedin", etc.
     */
    readonly source: string;
    /**
     * Return IDs of messages newer than the watermark.
     * When watermark is null, return all available messages (full backfill).
     * IDs must be stable and unique within this source — used as operationId for dedup.
     *
     * @param watermark - Timestamp of last successful run, or null for backfill
     * @returns         - Array of message IDs to process (may be empty)
     */
    getNewMessageIds(watermark: Date | null): Promise<string[]>;
    /**
     * Fetch and extract a single message by ID.
     * Returns null if the message is unavailable, empty, or unparseable.
     * NEVER throws — catch and return null on any error.
     *
     * @param id - Message ID as returned by getNewMessageIds()
     * @returns  - Extracted content, or null to skip
     */
    fetchMessage(id: string): Promise<ExtractedContent | null>;
}
/** Run completion status */
export declare enum RunStatus {
    COMPLETE = "complete",
    PARTIAL = "partial",// Some messages failed but run finished
    FAILED = "failed"
}
/** Parameters for buildIngestionRunRecord() */
export interface RunRecordParams {
    source: string;
    account: string;
    startedAt: Date;
    completedAt: Date;
    messagesProcessed: number;
    messagesIngested: number;
    messagesSkipped: number;
    status: RunStatus;
    watermarkUsed: Date | null;
    newWatermark: Date | null;
}
/** DB row for the ingestion_runs table */
export interface IngestionRunRow {
    source: string;
    account: string;
    started_at: Date;
    completed_at: Date;
    messages_processed: number;
    messages_ingested: number;
    messages_skipped: number;
    status: RunStatus;
    watermark_used: Date | null;
    new_watermark: Date | null;
}
/** Result of shouldIngestMessage() */
export interface IngestDecision {
    ingest: boolean;
    reason: "passed" | "entity_filter" | "score_below_threshold";
    score?: number;
}
/** Parameters for buildSearchQuery() */
export interface SearchQueryParams {
    watermark: Date | null;
    account: string;
    searchQuery?: string;
}
/** Full ingestion config (subset of PluginConfig.ingestion) */
export interface IngestionConfig {
    account: string;
    scoringModel: string;
    scoreThreshold: number;
    maxMessagesPerRun: number;
    searchQuery: string;
    logPath: string;
}
/**
 * Optional runtime hooks for the ingestion runner.
 * All hooks are fire-and-forget — failures are logged but never abort the run.
 */
export interface IngestionHooks {
    /**
     * Called after each message is successfully written to the store,
     * for each resolved party that maps to an existing ShadowDB contact.
     *
     * @param contactId  - ShadowDB memory id of the matched contact
     * @param content    - The ingested message content
     * @param dossier    - Fetched dossier record, or null if not found
     * @param llm        - LLM client (same instance as the runner)
     */
    onNewContactSignal?: (contactId: number, content: ExtractedContent, dossier: DossierRecord | null, llm: LlmClient) => Promise<unknown>;
}
/**
 * Build a gog gmail search query string.
 *
 * When watermark is set, adds `after:YYYY/MM/DD` to only fetch new messages.
 * When null (first run / backfill), no date restriction — full history.
 * Additional searchQuery is appended if provided.
 *
 * @param params - watermark date, account, optional extra query
 * @returns      - gog-compatible search query string
 */
export declare function buildSearchQuery(params: SearchQueryParams): string;
/**
 * Parse thread IDs from gog gmail search --json output.
 *
 * gog output shape: { threads: [{ id, date, from, subject }] }
 *
 * Returns empty array on any parse error — never throws.
 *
 * @param gogJson - Raw JSON string from gog gmail search --json
 * @returns       - Array of thread/message IDs
 */
export declare function parseGogSearchResults(gogJson: string): string[];
/**
 * Parse a gog gmail get --json response into ExtractedContent.
 *
 * Wraps extractGmailContent() with JSON parse error handling.
 * Returns null if JSON is malformed or body is empty after extraction.
 *
 * @param gogJson - Raw JSON string from gog gmail get <id> --json
 * @returns       - Extracted content, or null if unparseable/empty
 */
export declare function parseGogMessage(gogJson: string): ExtractedContent | null;
/**
 * Decide whether a message should be ingested.
 *
 * Decision flow:
 *   1. passesEntityFilter() — hard-veto transactional, require entities
 *   2. If llmScore provided and >= threshold → ingest
 *   3. If llmScore provided and < threshold → skip
 *
 * When llmScore is omitted (undefined), only the entity filter is applied
 * (useful for pre-LLM-scoring checks or tests without LLM).
 *
 * @param content       - Extracted message content
 * @param threshold     - Minimum score to ingest [0-10]
 * @param llmScore      - LLM interestingness score (omit to skip score gate)
 * @returns             - IngestDecision with ingest flag and reason
 */
export declare function shouldIngestMessage(content: ExtractedContent, threshold: number, llmScore?: number): IngestDecision;
/**
 * Build a DB row for the ingestion_runs table from run statistics.
 *
 * @param params - Run parameters and statistics
 * @returns      - Row ready for INSERT into ingestion_runs
 */
export declare function buildIngestionRunRecord(params: RunRecordParams): IngestionRunRow;
/**
 * Gmail implementation of MessageFetcher — uses gog CLI.
 *
 * Handles Gmail-specific concerns: search query construction, gog CLI calls,
 * JSON parsing. The runner (runIngestion) knows nothing about gog.
 */
export declare class GmailFetcher implements MessageFetcher {
    private readonly config;
    readonly source = "gmail";
    constructor(config: IngestionConfig);
    getNewMessageIds(watermark: Date | null): Promise<string[]>;
    fetchMessage(id: string): Promise<ExtractedContent | null>;
}
/**
 * Run a full ingestion pass against any MessageFetcher source.
 *
 * Source-agnostic orchestrator — fetcher handles all protocol specifics.
 * This function calls the LLM and the store — NOT unit tested (deps are external).
 * Call from a cron job or CLI script.
 *
 * @param config  - Ingestion configuration
 * @param db      - Database client (for watermark + party resolution)
 * @param store   - ShadowDB store instance (for write())
 * @param llm     - LLM client for scoreInterestingness
 * @param fetcher - Source-specific message fetcher (GmailFetcher, etc.)
 * @returns       - Run statistics row (ready to INSERT into ingestion_runs)
 */
export declare function runIngestion(config: IngestionConfig, db: DbClient, store: {
    write: (params: Record<string, unknown>) => Promise<{
        id: number;
    }>;
}, llm: LlmClient, fetcher: MessageFetcher, hooks?: IngestionHooks): Promise<IngestionRunRow>;
