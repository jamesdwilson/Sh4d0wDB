/**
 * data-source.ts — Generic DataSource<T> interface + runDataSourceIngestion runner
 *
 * The second interface family for ingestion, parallel to MessageFetcher.
 *
 * MessageFetcher models a timestamped message stream (email, iMessage DMs).
 * DataSource<T> models an entity registry or event log — sources where records
 * have identity and can be updated: Apple Contacts, Crunchbase, Calendar events,
 * HubSpot CRM contacts, etc.
 *
 * Design:
 *   - Generic over raw record type T. The implementation knows the shape; the runner doesn't.
 *   - Four methods only. Every source implements: getUpdatedRecords, getRecordId, extractContent,
 *     plus three readonly properties (sourceId, displayName, category).
 *   - Same watermark pattern as MessageFetcher — null = full sync, Date = incremental.
 *   - operationId = `sourceId:recordId` — globally unique, stable across re-syncs.
 *   - runDataSourceIngestion<T> runs the same pipeline as runIngestion:
 *       extractContent → entity filter → LLM score → chunk → resolveParties → write → Phase 3 hook
 *   - extractContent returning null or throwing → record is skipped, never crashes the run.
 *
 * Adding a new source:
 *   1. Define your raw record type (e.g. HubSpotContact)
 *   2. Implement DataSource<HubSpotContact>
 *   3. Call runDataSourceIngestion with your implementation — done.
 *
 * See: ARCHITECTURE.md § 3, INTELLIGENCE_ROADMAP.md § DataSource<T> TDD Spec
 */
import type { ExtractedContent } from "./phase1-gmail.js";
import type { LlmClient } from "./phase1-scoring.js";
import type { DbClient } from "./phase1-parties.js";
import type { IngestionConfig, IngestionRunRow, IngestionHooks } from "./phase1-runner.js";
/**
 * Generic interface for entity registries and event logs.
 *
 * Implement this to add any non-stream data source to the ingestion pipeline.
 * The runner (runDataSourceIngestion) handles all pipeline logic — the
 * implementation only needs to know how to fetch and transform records.
 *
 * @typeParam T - Raw record shape returned by this source
 */
export interface DataSource<T> {
    /**
     * Stable identifier for this source. Stored in ingestion_runs.source.
     * Convention: "contacts:apple", "contacts:crunchbase", "calendar:apple", "crm:hubspot"
     * Combined with getRecordId() to form the global operationId: `sourceId:recordId`
     */
    readonly sourceId: string;
    /**
     * Human-readable name used in log messages.
     * E.g. "Apple Contacts", "Crunchbase", "Google Calendar"
     */
    readonly displayName: string;
    /**
     * ShadowDB category for written records.
     * E.g. "contacts", "events", "companies"
     */
    readonly category: string;
    /**
     * Return records modified since the watermark date.
     * When watermark is null, return all records (full sync).
     * NEVER throws — return [] on any error.
     *
     * @param watermark - Timestamp of last successful sync, or null for full sync
     * @returns         - Raw records from this source (may be empty)
     */
    getUpdatedRecords(watermark: Date | null): Promise<T[]>;
    /**
     * Extract a stable unique ID from a raw record.
     * Used as the second part of the global operationId: `sourceId:recordId`
     * Must be stable across re-fetches of the same record (same data = same ID).
     *
     * @param record - Raw record from getUpdatedRecords()
     * @returns      - Stable unique string ID (e.g. vCard UID, Crunchbase UUID)
     */
    getRecordId(record: T): string;
    /**
     * Transform a raw record into ShadowDB-ready ExtractedContent.
     * Returns null to skip this record (e.g., no useful text content).
     * NEVER throws — catch internally and return null on any error.
     *
     * @param record - Raw record from getUpdatedRecords()
     * @returns      - Extracted content ready for scoring + write, or null to skip
     */
    extractContent(record: T): ExtractedContent | null;
}
/** Apple Contacts record (via `contacts` CLI or applescript) */
export interface AppleContact {
    id: string;
    firstName: string;
    lastName: string;
    emails: string[];
    phones: string[];
    company?: string;
    title?: string;
    notes?: string;
    modifiedAt: Date;
}
/** Crunchbase company or person entity (via Crunchbase API) */
export interface CrunchbaseEntity {
    uuid: string;
    name: string;
    entityType: "person" | "organization";
    shortDescription?: string;
    description?: string;
    fundingTotal?: number;
    lastFundingType?: string;
    primaryRole?: string;
    linkedinUrl?: string;
    websiteUrl?: string;
    updatedAt: Date;
}
/** Apple Calendar event (via `icalBuddy` CLI or applescript) */
export interface CalendarEvent {
    uid: string;
    title: string;
    startTime: Date;
    endTime: Date;
    attendees: string[];
    location?: string;
    notes?: string;
    calendar: string;
    modifiedAt: Date;
}
/** Minimal store interface required by runDataSourceIngestion */
export interface ShadowStore {
    write(params: Record<string, unknown>): Promise<{
        id: number;
    }>;
    findByOperationId(operationId: string): Promise<{
        id: number;
    } | null>;
}
/**
 * Run a full ingestion pass for any DataSource<T>.
 *
 * Pipeline per record:
 *   1. extractContent(record)    → ExtractedContent | null (null = skip)
 *   2. passesEntityFilter(text)  → cheap regex gate (false = skip)
 *   3. scoreInterestingness()    → LLM gate (score < threshold = skip)
 *   4. chunkDocument()           → split into embeddable segments
 *   5. resolveParties()          → fuzzy-match to known ShadowDB contacts
 *   6. store.write()             → idempotent (operationId = sourceId:recordId)
 *   7. onNewContactSignal()      → Phase 3 hook (fire-and-forget, never aborts run)
 *
 * Watermark behavior:
 *   - Queries ingestion_runs for last completed run for this source+account
 *   - Passes completed_at as watermark to getUpdatedRecords()
 *   - Returns IngestionRunRow with new_watermark = most recent record modifiedAt
 *
 * @param config  - Ingestion configuration (scoreThreshold, maxMessagesPerRun, etc.)
 * @param source  - DataSource<T> implementation (the "what" and "how" of fetching)
 * @param db      - Database client (watermark queries + party resolution)
 * @param store   - ShadowDB store (write + dedup check)
 * @param llm     - LLM client for interestingness scoring
 * @param hooks   - Optional lifecycle hooks (onNewContactSignal, etc.)
 * @returns       - IngestionRunRow ready to INSERT into ingestion_runs
 */
export declare function runDataSourceIngestion<T>(config: IngestionConfig, source: DataSource<T>, db: DbClient, store: ShadowStore, llm: LlmClient, hooks?: IngestionHooks): Promise<IngestionRunRow>;
