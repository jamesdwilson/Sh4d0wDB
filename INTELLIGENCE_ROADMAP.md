# ShadowDB Intelligence Initiative — Implementation Roadmap

**Created:** 2026-03-07  
**Author:** Claude (OpenClaw agent)  
**Status:** Pre-implementation — roadmap phase  
**DB Backup:** `backups/shadow_backup_20260307_182322.sql` (251MB)

---

## High-Level Goals

1. **Ingest everything interesting** — Gmail (1yr), contracts/PDFs, LinkedIn messages, Apple Notes
2. **Curated, not comprehensive** — entity-filter first, LLM-score second, embed only what passes
3. **Relevance + Confidence as separate dimensions** — not collapsed into one score
4. **Temporal decay by record type** — timeless rules never decay; contact facts decay slowly; emails decay fast
5. **Proactive pattern detection** — surface connections James didn't ask for, now and on a schedule
6. **TDD throughout** — every module has tests written before implementation
7. **Strong types** — TypeScript strict mode, no `any`, explicit interfaces for every function boundary
8. **Frequent commits** — commit after each passing test suite, each migration, each module

---

## Definition of Done — All Phases

### Phase 0: Foundation (Schema + Types + Scoring) ✅ COMPLETE 2026-03-07
- [x] Migrations 001–002 applied to `shadow` database, all reversible
- [x] `memories` table has: `confidence`, `confidence_decay_rate`, `is_timeless`, `source`, `source_id`, `relevance_tier`
- [x] `documents` table exists with indexes on `source`, `source_id`, `date`, `parties`
- [x] `pattern_events` table exists with indexes on `type`, `detected_at`, `unresolved`
- [x] `ingestion_runs` audit table exists
- [x] Existing timeless records (rule/directive/playbook/system categories) have `is_timeless=TRUE` — 88 records
- [x] Existing contacts/dossiers have `confidence_decay_rate=0.003851` (half-life 180d)
- [x] `computeRecordConfidence()` — 7 tests passing
- [x] `assignRelevanceTier()` — 6 tests passing
- [x] `computeFinalScore()` — 5 tests passing
- [x] `resolveDecayProfile()` — 9 tests passing
- [x] `filterByTier()` — 6 tests passing
- [x] `applySearchScoring()` — 15 tests passing, wired into search pipeline
- [x] All three postgres.ts search legs (vector/FTS/fuzzy) SELECT confidence/tier columns
- [x] `score` field in SearchResult now reflects finalScore (confidence × tier × rerank × vector)
- [x] DB backup taken before (`shadow_backup_20260307_182322.sql`) and after (`shadow_backup_20260307_210427.sql`) migrations
- [x] All migrations, scoring modules, and tests committed and pushed

### Phase 1: Gmail Ingestion
- [ ] `gog` CLI can fetch emails + attachments for last 365 days
- [ ] `extractGmailContent()` strips HTML, quoted replies, footers — passes unit tests
- [ ] `passesEntityFilter()` correctly identifies emails with named entities — passes unit tests (≥5 true, ≥5 false fixtures)
- [ ] `scoreInterestingness()` returns 0–10 float, uses local LLM, mocked in tests
- [ ] `chunkDocument()` produces ≤400-token chunks with 100-token overlap — passes unit tests
- [ ] `resolveParties()` fuzzy-matches against existing ShadowDB contacts — passes unit tests
- [ ] Full backfill run: last 365 days ingested, interestingness ≥6 kept
- [ ] Ingestion is idempotent — re-running produces zero duplicates (keyed on gmail message id)
- [ ] `write()` deduplication via `operationId` in metadata implemented — fixes pre-existing RED test in `duplicate-detection-integration.test.mjs`
- [ ] Each ingested email creates: 1 `documents` row + N `memories` chunk rows
- [ ] Party names linked to existing contact records where matched
- [ ] `ingestion_runs` audit row written for every run (started, finished, counts, status)
- [ ] Ongoing cron: every 6 hours, new mail only
- [ ] Integration test: ingest 5 fixture emails, verify DB state

### Phase 2: PDF / Contract Ingestion
- [ ] `extractPdfContent()` extracts text from PDF preserving section structure — passes unit tests with 3 fixture PDFs
- [ ] `extractContractTerms()` identifies parties, dates, dollar values, obligation verbs — passes unit tests
- [ ] Folder watcher configured for `~/Documents/Contracts/` (and user-configured paths)
- [ ] Contracts scored at threshold ≥7 (higher bar than email)
- [ ] Section-aware chunking: splits at headers/page boundaries
- [ ] Idempotent: re-processing same file produces zero duplicates (keyed on file path hash)
- [ ] Integration test: ingest 2 fixture contracts, verify DB state

### Phase 3: Cross-Reference + Pattern Detection
- [ ] `crossReferenceDocument()` runs on every new ingest — passes integration test
- [ ] `classifyPassageRelationship()` correctly classifies contradiction vs confirmation vs drift — passes unit tests with 6 fixture pairs
- [ ] `generateIntelligenceBrief()` produces structured brief from unresolved `pattern_events` — passes unit test
- [ ] Pattern events stored in `pattern_events` table with correct type, confidence, record_ids
- [ ] High-confidence patterns (≥0.80) trigger immediate SMS alert to James
- [ ] Weekly cron: surface top 5 unresolved patterns as intelligence brief
- [ ] Pattern types covered: `contradiction`, `relationship_graph`, `temporal_drift`, `recurring_term`
- [ ] Integration test: ingest 2 related documents, verify pattern detected and stored

### Phase 4: LinkedIn Ingestion
- [ ] Browser scrape extracts LinkedIn messages from last 90 days
- [ ] Message threads preserved as single units (not chunked mid-thread)
- [ ] Entity filter + interestingness score applied (threshold ≥6)
- [ ] Idempotent: keyed on thread URL + timestamp
- [ ] Periodic cron: weekly scrape
- [ ] Integration test: scrape fixture HTML, verify DB state

### Phase 5: Intelligence Brief Cron
- [ ] Weekly cron generates brief covering: new patterns, stale important contacts, temporal drift alerts
- [ ] Brief delivered via SMS (OpenClaw message tool)
- [ ] Brief includes: pattern type, confidence, which documents involved, one-line summary
- [ ] "Resolved" flow: James can dismiss a pattern (sets `resolved_at`)
- [ ] Dismissed patterns excluded from future briefs
- [ ] Integration test: seed 3 pattern events, generate brief, verify format

---

## Cross-Cutting Definition of Done (All Phases)
- [ ] Every module: test file written before implementation file
- [ ] Every function in public API: JSDoc contract comment present
- [ ] No `any` in TypeScript — strict mode throughout
- [ ] Every migration: reversible (UP + DOWN)
- [ ] Every commit: after corresponding tests pass
- [ ] No phase ships without DB backup taken first
- [ ] Graceful degradation: ingestion failure never crashes OpenClaw
- [ ] All external API calls (Gmail, LLM scorer) mockable via dependency injection

---

## Architecture Overview

```
Sources                 Pipeline                  Storage              Intelligence
───────                 ────────                  ───────              ───────────
Gmail          →        Extract                   documents            pattern_events
Contracts/PDF  →        Entity Filter   →         doc_chunks    →      cross_refs
LinkedIn       →        LLM Score       →         memories             weekly_brief
Apple Notes    →        Chunk                     (existing)
               →        Embed (Qwen3-4B)
               →        Store + Link
               →        Cross-reference Pass
```

---

## Phase 0: Foundation — Schema + Types + Backup (Pre-req for all phases)

### Goals
- Extend `memories` table with confidence/decay/timeless columns
- Add `documents` table (parent records for ingested content)
- Add `pattern_events` table (detected cross-document patterns)
- Add `ingestion_runs` table (audit log)
- No breaking changes to existing records
- All migrations reversible

### DB Migrations (ordered)

```sql
-- Migration 001: memories confidence + decay
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS confidence         FLOAT   NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS confidence_decay_rate FLOAT NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS last_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_timeless       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source            TEXT,        -- 'gmail'|'pdf'|'linkedin'|'notes'|'agent'
  ADD COLUMN IF NOT EXISTS source_id         TEXT,        -- external ID (gmail message id, file path, etc.)
  ADD COLUMN IF NOT EXISTS relevance_tier    SMALLINT NOT NULL DEFAULT 1; -- 1=hot, 2=warm, 3=cool, 4=archive

-- Migration 002: documents table (parent records for ingested content)  
CREATE TABLE IF NOT EXISTS documents (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT        NOT NULL,          -- 'gmail'|'pdf'|'linkedin'|'notes'
  source_id       TEXT        NOT NULL UNIQUE,   -- gmail thread id, file path hash, etc.
  title           TEXT,
  doc_type        TEXT,                          -- 'email'|'contract'|'message'|'note'
  parties         TEXT[],                        -- extracted named parties
  date            TIMESTAMPTZ,                   -- document date (not ingestion date)
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity   TIMESTAMPTZ,                   -- last email in thread, last edit, etc.
  interestingness FLOAT,                         -- LLM score 0-1
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  metadata        JSONB   NOT NULL DEFAULT '{}',
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_documents_source     ON documents(source);
CREATE INDEX idx_documents_source_id  ON documents(source_id);
CREATE INDEX idx_documents_date       ON documents(date DESC);
CREATE INDEX idx_documents_parties    ON documents USING GIN(parties);

-- Migration 003: pattern_events table
CREATE TABLE IF NOT EXISTS pattern_events (
  id              BIGSERIAL PRIMARY KEY,
  pattern_type    TEXT        NOT NULL,  -- 'contradiction'|'relationship_graph'|'temporal_drift'|'recurring_term'
  confidence      FLOAT       NOT NULL DEFAULT 0.5,
  summary         TEXT        NOT NULL,
  detail          TEXT,
  record_ids      INTEGER[]   NOT NULL,  -- memories.id references involved
  document_ids    BIGINT[],              -- documents.id references involved
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  surfaced_at     TIMESTAMPTZ,           -- when James was notified
  resolved_at     TIMESTAMPTZ,           -- when James dismissed/resolved
  metadata        JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_pattern_events_type      ON pattern_events(pattern_type);
CREATE INDEX idx_pattern_events_detected  ON pattern_events(detected_at DESC);
CREATE INDEX idx_pattern_events_unresolved ON pattern_events(resolved_at) WHERE resolved_at IS NULL;

-- Migration 004: ingestion_runs audit log
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'running',  -- 'running'|'complete'|'failed'
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_kept INTEGER NOT NULL DEFAULT 0,  -- passed filter
  records_new  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'
);

-- Migration 005: decay rate defaults by record type (UPDATE existing)
-- Timeless: rules, playbooks, config
UPDATE memories SET is_timeless = TRUE, confidence_decay_rate = 0.0
  WHERE record_type IN ('rule', 'directive', 'playbook')
     OR category IN ('rules', 'directives', 'system', 'config');

-- Contacts/dossiers: slow decay (half-life ~180 days)
UPDATE memories SET confidence_decay_rate = 0.0039  -- ln(2)/180
  WHERE record_type IN ('contact', 'dossier', 'person', 'atom')
    AND is_timeless = FALSE;

-- Facts/general: medium decay (half-life ~90 days)
UPDATE memories SET confidence_decay_rate = 0.0077  -- ln(2)/90
  WHERE record_type IN ('fact', 'section')
    AND is_timeless = FALSE;

-- Documents/chunks: fast decay (handled by relevance_tier)
-- tier set at ingestion time based on document date
```

### New TypeScript Types (types.ts additions)

```typescript
// Relevance tier — maps to temporal decay bucket
export type RelevanceTier = 1 | 2 | 3 | 4;

// Tier weights applied to final search score
export const TIER_WEIGHTS: Record<RelevanceTier, number> = {
  1: 1.00,  // 0-10 days
  2: 0.70,  // 10-30 days
  3: 0.40,  // 30-90 days
  4: 0.15,  // 90-365 days
  // 365+ days: excluded from default search (archived)
};

// Decay profile — assigned per record_type at write time
export interface DecayProfile {
  /** Half-life in days. 0 = no decay. */
  halfLifeDays: number;
  /** Whether this record is timeless (no decay, no tier weighting) */
  isTimeless: boolean;
}

export const DECAY_PROFILES: Record<string, DecayProfile> = {
  rule:      { halfLifeDays: 0,   isTimeless: true  },
  directive: { halfLifeDays: 0,   isTimeless: true  },
  playbook:  { halfLifeDays: 0,   isTimeless: true  },
  contact:   { halfLifeDays: 180, isTimeless: false },
  dossier:   { halfLifeDays: 180, isTimeless: false },
  fact:      { halfLifeDays: 90,  isTimeless: false },
  section:   { halfLifeDays: 90,  isTimeless: false },
  document:  { halfLifeDays: 30,  isTimeless: false },
  chunk:     { halfLifeDays: 30,  isTimeless: false },
  atom:      { halfLifeDays: 90,  isTimeless: false },
};

// Document record (ingested external content)
export interface DocumentRecord {
  id: number;
  source: IngestSource;
  sourceId: string;
  title: string | null;
  docType: DocType;
  parties: string[];
  date: Date | null;
  ingestedAt: Date;
  lastActivity: Date | null;
  interestingness: number | null;
  chunkCount: number;
  metadata: Record<string, unknown>;
}

export type IngestSource = 'gmail' | 'pdf' | 'linkedin' | 'notes' | 'agent';
export type DocType = 'email' | 'contract' | 'message' | 'note' | 'unknown';

// Pattern event — detected cross-document intelligence
export interface PatternEvent {
  id: number;
  patternType: PatternType;
  confidence: number;       // 0-1
  summary: string;          // one-line human-readable description
  detail: string | null;    // full explanation
  recordIds: number[];      // memories.id
  documentIds: number[];    // documents.id
  detectedAt: Date;
  surfacedAt: Date | null;
  resolvedAt: Date | null;
  metadata: Record<string, unknown>;
}

export type PatternType =
  | 'contradiction'       // conflicting commitments or facts
  | 'relationship_graph'  // A→B→C path James didn't know about
  | 'temporal_drift'      // same term/value changed over time
  | 'recurring_term'      // same clause/pattern across N docs
  | 'stale_contact';      // important contact with no recent activity

// Final search score breakdown (for debugging/tuning)
export interface ScoredResult {
  memoryId: number;
  vectorScore: number;       // cosine similarity [0,1]
  rerankScore: number | null; // Qwen3-Reranker P(yes) [0,1]
  confidenceWeight: number;  // decay-adjusted confidence [0,1]
  tierWeight: number;        // recency tier weight [0,1]
  isTimeless: boolean;
  finalScore: number;        // vector * rerank * confidence * tier
}
```

### Function Contracts (before implementation)

```typescript
/**
 * Compute current confidence for a record based on decay rate and last_verified_at.
 *
 * Uses exponential decay: confidence(t) = initial * e^(-decay_rate * age_days)
 * If is_timeless=true, always returns initial confidence unchanged.
 * If last_verified_at is null, uses created_at as the start of decay.
 *
 * @param record    - Memory record with confidence fields
 * @param asOf      - Date to compute confidence at (default: now)
 * @returns         - Decayed confidence in [0, 1]
 */
export function computeRecordConfidence(
  record: Pick<MemoryRecord, 'confidence' | 'confidenceDecayRate' | 'lastVerifiedAt' | 'isTimeless' | 'createdAt'>,
  asOf?: Date
): number;

/**
 * Assign relevance tier based on document date.
 *
 * Tiers:
 *   1 = within 10 days of asOf
 *   2 = 10-30 days
 *   3 = 30-90 days
 *   4 = 90-365 days
 *   null = older than 365 days (archive)
 *
 * @param documentDate  - Date of the source document
 * @param asOf          - Reference date (default: now)
 * @returns             - Tier 1-4 or null (archive)
 */
export function assignRelevanceTier(
  documentDate: Date,
  asOf?: Date
): RelevanceTier | null;

/**
 * Compute final search score from component scores.
 *
 * Formula: vectorScore * rerankScore * confidenceWeight * tierWeight
 * If isTimeless=true: confidenceWeight=1.0 and tierWeight=1.0 always.
 * If rerankScore=null: omit from formula (vector * confidence * tier only).
 *
 * @param components - Score components
 * @returns          - ScoredResult with finalScore
 */
export function computeFinalScore(components: Omit<ScoredResult, 'finalScore'>): ScoredResult;

/**
 * Filter candidate memories by relevance tier before reranking.
 * Excludes archived records (tier=null) unless includeArchived=true.
 * Timeless records always included regardless of tier.
 *
 * @param candidates      - Raw vector search results
 * @param includeArchived - Include 365+ day old records (default: false)
 * @returns               - Filtered and tier-weighted candidates
 */
export function filterByTier(
  candidates: MemoryRecord[],
  includeArchived?: boolean
): MemoryRecord[];

/**
 * Determine decay profile for a record based on record_type and category.
 * Falls back to 'fact' profile if type not in DECAY_PROFILES.
 *
 * @param recordType  - memories.record_type
 * @param category    - memories.category
 * @returns           - DecayProfile for this record
 */
export function resolveDecayProfile(
  recordType: string,
  category: string | null
): DecayProfile;
```

---

## Phase 1: Gmail Ingestion

### Goals
- Ingest last 1 year of Gmail
- Entity filter: skip emails with no named entities
- LLM interestingness score: keep only ≥ 6/10
- Adaptive chunking: emails = whole unit; long threads = per-email chunks
- Store as `document` parent + `chunk` children in memories
- Link parties to existing ShadowDB contacts via entity resolution
- Idempotent: re-running never creates duplicates (keyed on gmail message id)

### Function Contracts

```typescript
/**
 * Extract plain text and metadata from a Gmail message.
 * Strips HTML, quoted replies, email headers, unsubscribe footers.
 * Returns null if message is empty after stripping.
 *
 * @param raw - Raw Gmail API message object
 * @returns   - Extracted content or null
 */
export function extractGmailContent(raw: GmailMessage): ExtractedContent | null;

/**
 * Run entity detection pass on extracted text.
 * Returns true if text contains ≥1 of: named person, company, dollar amount, date, commitment verb.
 * Uses regex + NER (no LLM required — this is the cheap fast gate).
 *
 * @param text - Plain text to analyze
 * @returns    - True if text passes entity filter
 */
export function passesEntityFilter(text: string): boolean;

/**
 * Score document interestingness using local LLM (GLM-5 or Groq).
 * Sends first 500 tokens of text + metadata as context.
 * Returns score 0-10 (float). Throws on LLM failure.
 *
 * @param text      - Document text (first 500 tokens used)
 * @param metadata  - Document metadata (parties, date, subject)
 * @returns         - Interestingness score 0-10
 */
export function scoreInterestingness(
  text: string,
  metadata: { subject?: string; parties?: string[]; date?: Date }
): Promise<number>;

/**
 * Chunk a single email or document into embeddable segments.
 * Strategy: emails ≤2000 chars = single chunk; longer = split at paragraph boundaries.
 * Each chunk overlaps 100 tokens with adjacent chunks.
 * Preserves source metadata on every chunk.
 *
 * @param content   - Extracted document content
 * @param maxTokens - Maximum tokens per chunk (default: 400)
 * @returns         - Array of chunks with metadata
 */
export function chunkDocument(
  content: ExtractedContent,
  maxTokens?: number
): DocumentChunk[];

/**
 * Resolve named parties in text to existing ShadowDB contact records.
 * Uses fuzzy name matching against people table + existing memory titles.
 * Returns array of {name, memoryId|null} — null if no match found.
 *
 * @param parties - Extracted party names
 * @param db      - Database connection
 * @returns       - Resolved party references
 */
export function resolveParties(
  parties: string[],
  db: DatabaseConnection
): Promise<ResolvedParty[]>;
```

---

## Phase 2: PDF/Contract Ingestion

### Goals
- Watch `~/Documents/Contracts/` (and configurable paths)
- Extract text via `pdftotext` (local, no API)
- Section-aware chunking: split at headers/page boundaries
- Higher interestingness threshold (≥7) — contracts are signal-dense
- Extract key terms: parties, dates, dollar values, obligation verbs

### Function Contracts

```typescript
/**
 * Extract text from PDF preserving section structure.
 * Returns page-separated text with section headers detected via font size heuristic.
 * Falls back to plain text if structure detection fails.
 *
 * @param filePath - Absolute path to PDF file
 * @returns        - Structured PDF content or null if extraction fails
 */
export function extractPdfContent(filePath: string): Promise<ExtractedContent | null>;

/**
 * Extract key terms from contract/legal text.
 * Identifies: party names, effective date, dollar values, defined terms,
 * obligation verbs (shall/will/must/agree), termination clauses.
 *
 * @param text - Contract plain text
 * @returns    - Extracted key terms
 */
export function extractContractTerms(text: string): ContractTerms;
```

---

## Phase 3: Cross-Reference + Pattern Detection

### Goals
- On each new document ingest: run cross-reference pass
- Three pattern types: contradiction, relationship_graph, temporal_drift
- Store detected patterns in `pattern_events`
- Alert James immediately if confidence > 0.80
- Weekly cron: surface unresolved patterns as intelligence brief

### Function Contracts

```typescript
/**
 * Run full cross-reference pass on a newly ingested document.
 * Steps:
 *   1. Embed key sentences from document
 *   2. Search ShadowDB for similar content in OTHER documents
 *   3. For each high-similarity pair: classify pattern type
 *   4. Store detected patterns with confidence score
 *   5. Return patterns with confidence > threshold
 *
 * @param documentId  - Newly ingested document id
 * @param db          - Database connection
 * @param threshold   - Minimum confidence to return (default: 0.6)
 * @returns           - Detected pattern events
 */
export function crossReferenceDocument(
  documentId: number,
  db: DatabaseConnection,
  threshold?: number
): Promise<PatternEvent[]>;

/**
 * Classify the relationship between two semantically similar text passages.
 * Uses LLM to determine if passages represent: contradiction, confirmation,
 * temporal drift, or unrelated coincidence.
 *
 * @param passageA  - First text passage with metadata
 * @param passageB  - Second text passage with metadata
 * @returns         - Classification with confidence score
 */
export function classifyPassageRelationship(
  passageA: PassageWithMetadata,
  passageB: PassageWithMetadata
): Promise<PatternClassification>;

/**
 * Generate weekly intelligence brief from unresolved pattern events.
 * Groups patterns by type, ranks by confidence * recency.
 * Returns structured brief ready for delivery to James.
 *
 * @param db          - Database connection
 * @param lookbackDays - How many days to include (default: 7)
 * @returns            - Intelligence brief
 */
export function generateIntelligenceBrief(
  db: DatabaseConnection,
  lookbackDays?: number
): Promise<IntelligenceBrief>;
```

---

## Testing Strategy (TDD)

### Principles
- Write test file before implementation file — always
- Each function contract = one describe block with ≥3 test cases
- Test edge cases explicitly: null inputs, empty arrays, boundary dates
- No mocking of the database in integration tests — use test schema `shadow_test`
- Mock only: LLM calls (expensive), external APIs (Gmail, etc.)

### Test Structure
```
confidence-scoring.test.mjs       → Phase 0
relevance-tier.test.mjs           → Phase 0
decay-profiles.test.mjs           → Phase 0
final-score.test.mjs              → Phase 0
gmail-extract.test.mjs            → Phase 1
entity-filter.test.mjs            → Phase 1
interestingness-score.test.mjs    → Phase 1
document-chunking.test.mjs        → Phase 1
party-resolution.test.mjs         → Phase 1
pdf-extract.test.mjs              → Phase 2
contract-terms.test.mjs           → Phase 2
cross-reference.test.mjs          → Phase 3
pattern-classification.test.mjs   → Phase 3
intelligence-brief.test.mjs       → Phase 3
```

### Test Database Setup
```sql
-- Create shadow_test schema for integration tests
CREATE SCHEMA IF NOT EXISTS shadow_test;
-- All tables mirrored with test prefix
-- Seeded with 50 synthetic records per type
```

---

## Commit Strategy

- `feat(schema): migration 001 — confidence/decay columns` → after migration passes tests
- `feat(schema): migration 002 — documents table` → after migration passes tests
- `feat(types): confidence/decay/tier types and profiles` → after type tests pass
- `feat(scoring): computeRecordConfidence` → after unit tests pass
- `feat(scoring): assignRelevanceTier + filterByTier` → after unit tests pass
- `feat(scoring): computeFinalScore` → after unit tests pass
- `feat(ingest): gmail extraction pipeline` → after integration tests pass
- etc.

---

## Non-Goals (explicitly out of scope for this initiative)

- Real-time streaming ingestion (batch/cron only)
- Multi-user / shared ShadowDB (single-user only)
- Cloud sync or external backups
- Automatic contact graph updates from ingested content (manual review only)

---

## Open Questions (resolve before Phase 1 implementation)

1. **Gmail scope**: 1 year backfill. How far back exactly? Any folders to exclude (promotions, spam already excluded)?
2. **Contract folder**: `~/Documents/Contracts/`? Other locations?
3. **LLM for scoring**: Use GLM-5 (local, free) or Groq (faster)? Budget per run?
4. **Alert channel**: Pattern events → SMS via OpenClaw? Or just weekly brief?
5. **Decay on existing records**: Apply decay profiles to existing 7,842 records now, or only on new writes?

---

## Prereqs Checklist

- [x] Qwen3-Embedding-4B working (oMLX port 8000)
- [x] Qwen3-Reranker-0.6B working (embed-rerank port 9000)
- [x] embed-rerank LaunchAgent installed (auto-starts on boot)
- [x] Re-embedding complete — 7,842/7,842 records, 2560d, Qwen3 task prefix
- [x] DB backup confirmed: `backups/shadow_backup_20260307_182322.sql` (251MB)
- [x] Reranker wired into memory_search — 23 tests, graceful degradation
- [ ] HNSW/IVFFlat index — blocked: pgvector 0.8.x caps HNSW at 2000d; sequential scan acceptable at current record count (~7,842), revisit at 50K+
- [ ] Open questions answered (Gmail scope, contract folder, LLM for scoring, alert channel, decay on existing records)
- [ ] This roadmap reviewed and approved by James
