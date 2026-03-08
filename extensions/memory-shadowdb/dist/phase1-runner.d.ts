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
 * Run a full Gmail ingestion pass.
 *
 * This function calls the gog CLI, the LLM, and the store — it is NOT unit
 * tested (all deps are external). Call from a cron job or CLI script.
 *
 * @param config  - Ingestion configuration
 * @param db      - Database client (for watermark + party resolution)
 * @param store   - ShadowDB store instance (for write())
 * @param llm     - LLM client for scoreInterestingness
 * @returns       - Run statistics
 */
export declare function runGmailIngestion(config: IngestionConfig, db: DbClient, store: {
    write: (params: Record<string, unknown>) => Promise<{
        id: number;
    }>;
}, llm: LlmClient): Promise<IngestionRunRow>;
