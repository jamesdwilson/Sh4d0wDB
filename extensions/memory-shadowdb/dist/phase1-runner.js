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
// ============================================================================
// Types
// ============================================================================
/** Run completion status */
export var RunStatus;
(function (RunStatus) {
    RunStatus["COMPLETE"] = "complete";
    RunStatus["PARTIAL"] = "partial";
    RunStatus["FAILED"] = "failed";
})(RunStatus || (RunStatus = {}));
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
export function buildSearchQuery(params) {
    const parts = [];
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
export function parseGogSearchResults(gogJson) {
    try {
        const parsed = JSON.parse(gogJson);
        if (!Array.isArray(parsed?.threads))
            return [];
        return parsed.threads
            .map((t) => t.id)
            .filter((id) => typeof id === "string" && id.length > 0);
    }
    catch {
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
export function parseGogMessage(gogJson) {
    try {
        const raw = JSON.parse(gogJson);
        return extractGmailContent(raw);
    }
    catch {
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
export function shouldIngestMessage(content, threshold, llmScore) {
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
export function buildIngestionRunRecord(params) {
    return {
        source: params.source,
        account: params.account,
        started_at: params.startedAt,
        completed_at: params.completedAt,
        messages_processed: params.messagesProcessed,
        messages_ingested: params.messagesIngested,
        messages_skipped: params.messagesSkipped,
        status: params.status,
        watermark_used: params.watermarkUsed,
        new_watermark: params.newWatermark,
    };
}
// ============================================================================
// Runtime runner (not unit tested — integration only)
// ============================================================================
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
export async function runGmailIngestion(config, db, store, llm) {
    const startedAt = new Date();
    let messagesProcessed = 0;
    let messagesIngested = 0;
    let messagesSkipped = 0;
    let status = RunStatus.COMPLETE;
    let newWatermark = null;
    // Step 1: Get watermark
    const watermark = await getWatermark(db, config.account);
    // Step 2: Build search query
    const query = buildSearchQuery({
        watermark,
        account: config.account,
        searchQuery: config.searchQuery,
    });
    // Step 3: Fetch message list from gog
    let messageIds;
    try {
        const maxFlag = config.maxMessagesPerRun > 0 ? `--max ${config.maxMessagesPerRun}` : "";
        const gogOutput = execSync(`gog gmail search ${JSON.stringify(query)} --json --account ${config.account} ${maxFlag}`, { timeout: 30_000, encoding: "utf8" });
        messageIds = parseGogSearchResults(gogOutput);
    }
    catch (err) {
        console.error(`[ingestion] gog search failed:`, err);
        return buildIngestionRunRecord({
            source: "gmail", account: config.account,
            startedAt, completedAt: new Date(),
            messagesProcessed: 0, messagesIngested: 0, messagesSkipped: 0,
            status: RunStatus.FAILED,
            watermarkUsed: watermark, newWatermark: null,
        });
    }
    console.log(`[ingestion] ${messageIds.length} messages to process (watermark: ${watermark?.toISOString() ?? "none"})`);
    // Step 4: Process each message
    for (const msgId of messageIds) {
        if (config.maxMessagesPerRun > 0 && messagesProcessed >= config.maxMessagesPerRun)
            break;
        try {
            // Fetch full message
            const gogJson = execSync(`gog gmail get ${msgId} --json --account ${config.account}`, { timeout: 15_000, encoding: "utf8" });
            // Extract content
            const content = parseGogMessage(gogJson);
            if (!content) {
                messagesSkipped++;
                messagesProcessed++;
                continue;
            }
            // Score with LLM
            const score = await scoreInterestingness(content.text, {
                subject: content.subject,
                parties: content.parties,
            }, llm);
            // Decide
            const decision = shouldIngestMessage(content, config.scoreThreshold, score);
            messagesProcessed++;
            if (!decision.ingest) {
                messagesSkipped++;
                continue;
            }
            // Resolve parties
            const resolved = await resolveParties(content.parties, db);
            // Chunk
            const chunks = chunkDocument(content);
            // Write each chunk (idempotent via operationId = sourceId + chunkIndex)
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
                    },
                    source: "gmail",
                    source_id: operationId,
                });
            }
            messagesIngested++;
            if (!newWatermark || content.date > newWatermark) {
                newWatermark = content.date;
            }
        }
        catch (err) {
            console.error(`[ingestion] failed on message ${msgId}:`, err);
            status = RunStatus.PARTIAL;
            messagesSkipped++;
            messagesProcessed++;
        }
    }
    return buildIngestionRunRecord({
        source: "gmail", account: config.account,
        startedAt, completedAt: new Date(),
        messagesProcessed, messagesIngested, messagesSkipped,
        status,
        watermarkUsed: watermark,
        newWatermark,
    });
}
// ============================================================================
// Private helpers
// ============================================================================
/**
 * Get the watermark (completed_at of last successful run) for an account.
 * Returns null if no prior run exists (triggers full backfill).
 */
async function getWatermark(db, account) {
    try {
        const result = await db.query(`SELECT completed_at FROM ingestion_runs
       WHERE source = 'gmail' AND account = $1 AND status = 'complete'
       ORDER BY completed_at DESC LIMIT 1`, [account]);
        const row = result.rows[0];
        if (!row)
            return null;
        return row.completed_at instanceof Date
            ? row.completed_at
            : new Date(row.completed_at);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=phase1-runner.js.map