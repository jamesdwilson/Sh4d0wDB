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

import { execSync } from "node:child_process";
import { extractGmailContent, passesEntityFilter, chunkDocument } from "./phase1-gmail.js";
import { scoreInterestingness } from "./phase1-scoring.js";
import { resolveParties } from "./phase1-parties.js";
import type { ExtractedContent, GogGmailMessage } from "./phase1-gmail.js";
import type { LlmClient } from "./phase1-scoring.js";
import type { DbClient } from "./phase1-parties.js";

// ============================================================================
// MessageFetcher interface — source-agnostic fetch contract
// ============================================================================

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

// ============================================================================
// Types
// ============================================================================

/** Run completion status */
export enum RunStatus {
  COMPLETE = "complete",
  PARTIAL  = "partial",   // Some messages failed but run finished
  FAILED   = "failed",    // Run aborted (e.g., gog CLI failure)
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

// ============================================================================
// Public pure functions (tested)
// ============================================================================

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
export function buildSearchQuery(params: SearchQueryParams): string {
  const parts: string[] = [];

  if (params.watermark) {
    const d = params.watermark;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    parts.push(`after:${y}/${m}/${day}`);
  }

  if (params.searchQuery?.trim()) {
    parts.push(params.searchQuery.trim());
  }

  // Default: exclude promotions + social noise if no extra query
  // (still lets newsletters through — they're in Primary/Updates)
  if (!params.searchQuery?.trim()) {
    parts.push("-in:promotions -in:social -in:spam");
  }

  return parts.join(" ").trim();
}

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
export function parseGogSearchResults(gogJson: string): string[] {
  try {
    const parsed = JSON.parse(gogJson);
    if (!Array.isArray(parsed?.threads)) return [];
    return parsed.threads
      .map((t: { id?: string }) => t.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Parse a gog gmail get --json response into ExtractedContent.
 *
 * Wraps extractGmailContent() with JSON parse error handling.
 * Returns null if JSON is malformed or body is empty after extraction.
 *
 * @param gogJson - Raw JSON string from gog gmail get <id> --json
 * @returns       - Extracted content, or null if unparseable/empty
 */
export function parseGogMessage(gogJson: string): ExtractedContent | null {
  try {
    const raw = JSON.parse(gogJson) as GogGmailMessage;
    return extractGmailContent(raw);
  } catch {
    return null;
  }
}

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
export function shouldIngestMessage(
  content: ExtractedContent,
  threshold: number,
  llmScore?: number,
): IngestDecision {
  // Gate 1: entity filter (includes hard transactional veto)
  if (!passesEntityFilter(content.text)) {
    return { ingest: false, reason: "entity_filter" };
  }

  // Gate 2: LLM score (if provided)
  if (llmScore !== undefined) {
    if (llmScore < threshold) {
      return { ingest: false, reason: "score_below_threshold", score: llmScore };
    }
    return { ingest: true, reason: "passed", score: llmScore };
  }

  // No score provided — entity filter passed, tentatively ingest
  return { ingest: true, reason: "passed" };
}

/**
 * Build a DB row for the ingestion_runs table from run statistics.
 *
 * @param params - Run parameters and statistics
 * @returns      - Row ready for INSERT into ingestion_runs
 */
export function buildIngestionRunRecord(params: RunRecordParams): IngestionRunRow {
  return {
    source:              params.source,
    account:             params.account,
    started_at:          params.startedAt,
    completed_at:        params.completedAt,
    messages_processed:  params.messagesProcessed,
    messages_ingested:   params.messagesIngested,
    messages_skipped:    params.messagesSkipped,
    status:              params.status,
    watermark_used:      params.watermarkUsed,
    new_watermark:       params.newWatermark,
  };
}

// ============================================================================
// Runtime runner (not unit tested — integration only)
// ============================================================================

/**
 * Gmail implementation of MessageFetcher — uses gog CLI.
 *
 * Handles Gmail-specific concerns: search query construction, gog CLI calls,
 * JSON parsing. The runner (runIngestion) knows nothing about gog.
 */
export class GmailFetcher implements MessageFetcher {
  readonly source = "gmail";

  constructor(private readonly config: IngestionConfig) {}

  async getNewMessageIds(watermark: Date | null): Promise<string[]> {
    const query = buildSearchQuery({
      watermark,
      account: this.config.account,
      searchQuery: this.config.searchQuery,
    });
    const maxFlag = this.config.maxMessagesPerRun > 0
      ? `--max ${this.config.maxMessagesPerRun}`
      : "";
    const gogOutput = execSync(
      `gog gmail search ${JSON.stringify(query)} --json --account ${this.config.account} ${maxFlag}`,
      { timeout: 30_000, encoding: "utf8" },
    );
    return parseGogSearchResults(gogOutput);
  }

  async fetchMessage(id: string): Promise<ExtractedContent | null> {
    try {
      const gogJson = execSync(
        `gog gmail get ${id} --json --account ${this.config.account}`,
        { timeout: 15_000, encoding: "utf8" },
      );
      return parseGogMessage(gogJson);
    } catch {
      return null;
    }
  }
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
export async function runIngestion(
  config: IngestionConfig,
  db: DbClient,
  store: { write: (params: Record<string, unknown>) => Promise<{ id: number }> },
  llm: LlmClient,
  fetcher: MessageFetcher,
): Promise<IngestionRunRow> {
  const startedAt = new Date();
  let messagesProcessed = 0;
  let messagesIngested = 0;
  let messagesSkipped = 0;
  let status = RunStatus.COMPLETE;
  let newWatermark: Date | null = null;

  // Step 1: Get watermark for this source + account
  const watermark = await getWatermark(db, fetcher.source, config.account);

  // Step 2: Get new message IDs from fetcher
  let messageIds: string[];
  try {
    messageIds = await fetcher.getNewMessageIds(watermark);
  } catch (err) {
    console.error(`[ingestion:${fetcher.source}] fetch IDs failed:`, err);
    return buildIngestionRunRecord({
      source: fetcher.source, account: config.account,
      startedAt, completedAt: new Date(),
      messagesProcessed: 0, messagesIngested: 0, messagesSkipped: 0,
      status: RunStatus.FAILED,
      watermarkUsed: watermark, newWatermark: null,
    });
  }

  console.log(`[ingestion:${fetcher.source}] ${messageIds.length} messages (watermark: ${watermark?.toISOString() ?? "none"})`);

  // Step 3: Process each message through the pipeline
  for (const msgId of messageIds) {
    if (config.maxMessagesPerRun > 0 && messagesProcessed >= config.maxMessagesPerRun) break;

    try {
      const content = await fetcher.fetchMessage(msgId);
      if (!content) { messagesSkipped++; messagesProcessed++; continue; }

      const score = await scoreInterestingness(content.text, {
        subject: content.subject,
        parties: content.parties,
      }, llm);

      const decision = shouldIngestMessage(content, config.scoreThreshold, score);
      messagesProcessed++;

      if (!decision.ingest) { messagesSkipped++; continue; }

      const resolved = await resolveParties(content.parties, db);
      const chunks = chunkDocument(content);

      for (const chunk of chunks) {
        const operationId = chunks.length === 1
          ? content.sourceId
          : `${content.sourceId}_chunk${chunk.chunkIndex}`;

        await store.write({
          content: chunk.text,
          category: "emails",
          record_type: "document",
          title: content.subject,
          metadata: {
            operationId,
            sourceId: content.sourceId,
            threadId: content.threadId,
            from: content.from,
            date: content.date.toISOString(),
            chunkIndex: chunk.chunkIndex,
            chunkTotal: chunk.chunkTotal,
            parties: resolved.map(p => ({ name: p.name, memoryId: p.memoryId })),
            llmScore: score,
            ingestSource: fetcher.source,
          },
          source: fetcher.source,
          source_id: operationId,
        });
      }

      messagesIngested++;
      if (!newWatermark || content.date > newWatermark) newWatermark = content.date;

    } catch (err) {
      console.error(`[ingestion:${fetcher.source}] failed on ${msgId}:`, err);
      status = RunStatus.PARTIAL;
      messagesSkipped++;
      messagesProcessed++;
    }
  }

  return buildIngestionRunRecord({
    source: fetcher.source, account: config.account,
    startedAt, completedAt: new Date(),
    messagesProcessed, messagesIngested, messagesSkipped,
    status, watermarkUsed: watermark, newWatermark,
  });
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Get the watermark (completed_at of last successful run) for an account.
 * Returns null if no prior run exists (triggers full backfill).
 */
async function getWatermark(db: DbClient, source: string, account: string): Promise<Date | null> {
  try {
    const result = await db.query(
      `SELECT completed_at FROM ingestion_runs
       WHERE source = $1 AND account = $2 AND status = 'complete'
       ORDER BY completed_at DESC LIMIT 1`,
      [source, account],
    ) as unknown as { rows: Array<{ completed_at: Date | string }> };
    const row = result.rows[0];
    if (!row) return null;
    return row.completed_at instanceof Date
      ? row.completed_at
      : new Date(row.completed_at);
  } catch {
    return null;
  }
}
