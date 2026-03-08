# ShadowDB Intelligence Initiative — Implementation Roadmap

**Created:** 2026-03-07
**Last updated:** 2026-03-08 00:45 CST
**Status:** Phase 1 complete · Phase 4 in progress · Phase 2–3–5 planned

---

## High-Level Goals

1. **Ingest everything interesting** — email, iMessage, LinkedIn, contracts/PDFs
2. **Curated, not comprehensive** — hard veto → entity filter → LLM score gate → embed only what passes
3. **Relevance + Confidence as separate dimensions** — not collapsed into one score
4. **Temporal decay by record type** — timeless rules never decay; contacts decay slowly; emails decay fast
5. **Contact re-scoring on new signal** — new message from a known contact triggers dossier delta analysis
6. **Network-level intelligence** — bottleneck detection, competitive voids, obligation cascades, predictive positioning
7. **Source-agnostic ingestion** — `MessageFetcher` interface; adding a new source = implementing one class
8. **TDD throughout** — every module has tests written before implementation
9. **Strong types** — TypeScript strict mode, no `any`, explicit interfaces for every function boundary
10. **Frequent commits** — commit after each passing test suite, each migration, each module

---

## Architecture Overview

```
Sources                 Pipeline                  Storage              Intelligence
───────                 ────────                  ───────              ───────────
Gmail (gog)    ┐                                  memories             Contact re-scoring
iMessage (imsg)├→ MessageFetcher                  (chunks, 2560d       Pattern detection
LinkedIn       ┘  │                                embeddings)         Cross-reference engine
                  ├→ extractContent()                                  Network analysis
Contracts/PDF ──→ │                               documents            Opportunity briefing
                  ├→ TRANSACTIONAL_VETO (regex)    (parent records)
                  ├→ passesEntityFilter (regex)
                  ├→ scoreInterestingness (LLM)   ingestion_runs
                  ├→ chunkDocument()              (audit log)
                  ├→ resolveParties()
                  ├→ store.write() (dedup)        pattern_events
                  └→ onNewContactSignal()         (detected patterns)
```

---

## Phase 0: Foundation ✅ COMPLETE 2026-03-07

Schema, scoring, and retrieval pipeline.

- [x] Migrations 001–002 applied (`confidence`, `confidence_decay_rate`, `is_timeless`, `source`, `source_id`, `relevance_tier`, `documents`, `pattern_events`, `ingestion_runs` tables)
- [x] `phase0-scoring.ts` — 34 tests: `computeRecordConfidence`, `assignRelevanceTier`, `computeFinalScore`, `resolveDecayProfile`, `filterByTier`
- [x] `phase0-search-scoring.ts` — 15 tests: `applySearchScoring()` wired into `store.ts::search()` after reranking
- [x] `phase0-last-verified.test.mjs` — 7 tests: `lastVerifiedAt` as decay clock reset
- [x] `reranker.ts` — 23 tests: Qwen3-Reranker cross-encoder, graceful degradation
- [x] All three postgres.ts search legs SELECT confidence/tier/lastVerifiedAt columns
- [x] Three-stage retrieval: FTS (BM25) → ANN vector (1536d HNSW planned) → Qwen3-Reranker → confidence/tier scoring
- [x] Re-embedded all 7,842 records at 2560d using Qwen3-Embedding-4B

---

## Phase 1: Ingestion Pipeline ✅ COMPLETE 2026-03-07

Source-agnostic ingestion with Gmail and iMessage fetchers.

### Modules

| Module | Tests | Description |
|--------|-------|-------------|
| `phase1-gmail.ts` | 28 | `extractGmailContent`, `passesEntityFilter`, `chunkDocument` |
| `phase1-scoring.ts` | 12 | `scoreInterestingness` — injected LlmClient, thinking-block-safe parser |
| `phase1-parties.ts` | 13 | `resolveParties` — fuzzy contact matching with suffix stripping |
| `phase1-runner.ts` | 19 | `MessageFetcher` interface, `GmailFetcher`, `runIngestion` (source-agnostic) |
| `phase1-fetcher-imsg.ts` | 14 | `IMessageFetcher` — `imsg` CLI, reaction filtering, cache-based fetch |
| `store.ts` | — | `findByOperationId` + dedup in `write()` |
| `duplicate-detection-integration.test.mjs` | 2 | Integration test for operationId dedup |

**Total: 444/444 tests passing, zero RED**

### Three-Tier Entity Filtering

1. **Hard veto** (TRANSACTIONAL_VETO_PATTERNS) — receipts, shipping, auth codes, bank alerts → drop unconditionally, no LLM call
2. **Entity filter** (ENTITY_PATTERNS) — requires named entities, money, dates, deal terms. Newsletters pass intentionally.
3. **LLM gate** (scoreInterestingness, threshold configurable) — VC digest scores 5-7 → keep; promo blast 0-2 → drop

### MessageFetcher Interface

```typescript
interface MessageFetcher {
  readonly source: string;  // "gmail" | "imsg" | "linkedin" | etc.
  getNewMessageIds(watermark: Date | null): Promise<string[]>;
  fetchMessage(id: string): Promise<ExtractedContent | null>;
}
```

Implementations: `GmailFetcher` (gog CLI), `IMessageFetcher` (imsg CLI). Runner is fully source-agnostic.

### Entry Points & Execution Model

- `scripts/ingest.mjs` — CLI: `node scripts/ingest.mjs --source all|gmail|imsg [--dry-run] [--limit N]`
- `scripts/preview-ingest.mjs` — Live preview: shows VETO/DROP/KEEP per message with LLM scores
- OpenClaw cron (`f03618f3`): daily 6am CST, wraps `ingest.mjs --source all --limit 200`

**Execution principle:** Scripts are pure execution — CLI-accessible, no OC dependency, callable by anything.
OC cron jobs wrap them with scheduling, context, and access. Browser-dependent sources (LinkedIn) run
as OC agent jobs directly since `exec` isn't enough — OC owns all browser execution.

### Config (openclaw.plugin.json → ingestion)

```json
{
  "ingestion": {
    "enabled": true,
    "account": "user@example.com",
    "scoringModel": "local-qwen35",
    "scoreThreshold": 5,
    "maxMessagesPerRun": 100,
    "searchQuery": "",
    "logPath": "~/models/eval-results/gmail-ingestion.log"
  }
}
```

### Remaining Phase 1 Work

- [ ] First real backfill run against live Gmail (older business correspondence)
- [ ] iMessage ingestion run (74K+ messages via `imsg` CLI)
- [ ] Integration test: ingest N fixture emails, verify DB state end-to-end
- [ ] `documents` table population (currently writes to `memories` only — Phase 2 adds parent document records)

---

## Phase 3b: Entity Resolution Layer

Must be complete before Phase 5. Bad entity resolution = wrong graph = wrong network analysis.

### Goals
- Cross-source identity: `amy@acme.com` (Gmail) + `Amy Chen, VP at Acme` (LinkedIn) + `+1-404-555-0192` (iMessage) = one node
- Node types: person, company, group, fund, school, event
- Edge types: knows, referred, co_invested, mentioned, works_at, founded, member_of, attended, etc.
- Confidence-weighted resolution — fuzzy name alone = 50%, linkedinUrl = 100%
- Idempotent edge registration — re-seen edge updates `lastVerifiedAt` + confidence, no duplicate
- `resolveParties()` in `phase1-parties.ts` becomes a thin wrapper around `EntityResolver`

### Definition of Done
- [ ] `EntityResolver` interface + `resolve()` + `merge()` + `addEdge()` — tests with all confidence tiers
- [ ] `EntityCandidate`, `ResolvedEntity`, `EntityEdge`, `EdgeSignal` types
- [ ] Cross-source resolution: Gmail email + LinkedIn name+company → same node (integration test)
- [ ] `resolveParties()` updated to delegate to `EntityResolver`
- [ ] Edge signals from LinkedIn profile scrape wired through resolver

---

## Phase 2: PDF / Contract Ingestion

### Goals
- Watch configurable paths for new PDFs (e.g., `~/Documents/Contracts/`)
- Extract text via `pdftotext` (local, no API)
- Section-aware chunking: split at headers/page boundaries
- Higher interestingness threshold (≥7) — contracts are signal-dense
- Extract key terms: parties, dates, dollar values, obligation verbs
- Idempotent: re-processing same file produces zero duplicates (keyed on file path hash)

### Definition of Done
- [ ] `extractPdfContent()` extracts text preserving section structure — tests with 3 fixture PDFs
- [ ] `extractContractTerms()` identifies parties, dates, dollar values, obligation verbs — unit tests
- [ ] `PdfFetcher` implements `MessageFetcher` interface (watches folder, watermark = last modified time)
- [ ] Contracts scored at threshold ≥7
- [ ] Integration test: ingest 2 fixture contracts, verify DB state

---

## Phase 3: Contact Re-Scoring + Cross-Reference Engine

### Goals

When a new message is ingested from a known contact, automatically:
1. Pull existing dossier for that contact
2. Run behavioral analysis on the new message (tone shifts, commitment signals, power dynamics)
3. Compute psychographic delta (does this message shift DISC, MBTI, Voss negotiator type?)
4. If delta is meaningful → update dossier record + emit `pattern_event`
5. Detect cross-document patterns: contradiction, temporal drift, recurring terms

This is the bridge between **ingestion** (Phase 1) and **intelligence** (Phase 5). The ingestion runner already resolves parties — Phase 3 adds the `onNewContactSignal` callback that triggers post-write analysis.

### Core Abstractions

```typescript
/**
 * Hook called after a message from a known contact is successfully ingested.
 * Runs behavioral analysis and psychographic delta detection.
 *
 * @param contactId  - ShadowDB memory id of the matched contact
 * @param content    - The newly ingested ExtractedContent
 * @param existing   - Existing dossier record (if any)
 * @returns          - Delta analysis result, or null if no meaningful change
 */
export function onNewContactSignal(
  contactId: number,
  content: ExtractedContent,
  existing: DossierRecord | null,
): Promise<ContactDelta | null>;

/**
 * Detect behavioral signals in a message that indicate personality,
 * communication style, or relationship dynamics.
 *
 * Behavioral signals (from rule framework):
 * - Who deferred to who ("As [person] mentioned..." = deference)
 * - Tone shifts (template → real = where the actual info is)
 * - Commitment language (shall, agree, will → obligation signal)
 * - Silence on expected topics (didn't mention X = behavioral signal)
 * - Unexpected topics (why did they bring up Y?)
 *
 * @param text     - Message text
 * @param context  - Prior messages in thread (if available)
 * @param llm      - LLM client for analysis
 * @returns        - Behavioral signal report
 */
export function extractBehavioralSignals(
  text: string,
  context: string[],
  llm: LlmClient,
): Promise<BehavioralSignals>;

/**
 * Compute psychographic delta between existing profile and new behavioral signals.
 * Returns null if change is below threshold (noise, not signal).
 *
 * @param existing  - Current psychographic profile (DISC, MBTI, Voss type, etc.)
 * @param newSignals - Behavioral signals from new message
 * @returns          - Delta description, or null if below threshold
 */
export function computePsychographicDelta(
  existing: PsychProfile,
  newSignals: BehavioralSignals,
): PsychDelta | null;

/**
 * Run cross-reference pass on a newly ingested document.
 * Finds semantically similar content in OTHER documents and classifies
 * the relationship: contradiction, confirmation, temporal drift, coincidence.
 *
 * @param documentChunks - The new document's chunks (already embedded)
 * @param db             - Database connection
 * @param threshold      - Minimum confidence to return (default: 0.6)
 * @returns              - Detected pattern events
 */
export function crossReferenceDocument(
  documentChunks: DocumentChunk[],
  db: DbClient,
  threshold?: number,
): Promise<PatternEvent[]>;
```

### Definition of Done
- [x] `onNewContactSignal` hook wired into `runIngestion` (commit 6d3516d) and `runDataSourceIngestion` (commit 5cc3312)
- [ ] `extractBehavioralSignals` — unit tests with 5+ fixture messages
- [ ] `computePsychographicDelta` — unit tests covering DISC shift, no-change, and threshold edge cases
- [ ] `crossReferenceDocument` — integration test: ingest 2 related docs, verify pattern detected
- [ ] `classifyPassageRelationship` — unit tests: contradiction, confirmation, drift, unrelated
- [ ] Pattern events stored in `pattern_events` table with correct type, confidence, record_ids
- [ ] High-confidence patterns (≥0.80) trigger proactive alert

---

## Phase 4: LinkedIn Ingestion

### Assumptions
- **Browser:** OpenClaw host browser (Chrome profile) with active LinkedIn session — cookies already present, no auth flow needed
- **Interface:** `LinkedInFetcher` implements `MessageFetcher` — fits the existing runner without changes
- **Scrape target:** LinkedIn messaging inbox (`/messaging/`) — thread list + individual thread pages
- **No LinkedIn API** — scraping only; rate-limit-friendly (small batches, delay between requests)

### Design Philosophy
- The browser is injected as a `BrowserClient` interface — tests use a mock, production uses the OC browser tool
- All HTML parsing is pure functions (`parseThreadList`, `parseThreadMessages`) — fully unit testable with fixture HTML
- Thread URL is the stable ID: `linkedin.com/messaging/thread/<threadId>/` → operationId = `linkedin:<threadId>`
- Watermark = most recent message timestamp across all threads on last run
- Messages within a thread are concatenated into one `ExtractedContent` (thread as unit, not per-message chunks)
- Idempotent: same thread re-fetched = same operationId = zero duplicate writes

### Exported Surface (`phase4-fetcher-linkedin.ts`)

```typescript
// Injectable browser client — real = OC browser tool, test = mock HTML
export interface BrowserClient {
  navigate(url: string): Promise<void>;
  getPageSource(): Promise<string>;   // raw HTML of current page
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
  scrollToBottom(): Promise<void>;    // trigger lazy-load
}

// A parsed thread entry from the inbox list
export interface LinkedInThread {
  threadId: string;     // extracted from URL
  url: string;          // full thread URL
  participants: string[]; // names from thread list
  lastMessageAt: Date;
  snippet: string;      // preview text from inbox
}

// A fully fetched thread with all message content
export interface LinkedInThreadContent {
  threadId: string;
  url: string;
  participants: string[];
  messages: LinkedInMessage[];
  fetchedAt: Date;
}

export interface LinkedInMessage {
  sender: string;
  sentAt: Date;
  text: string;
}

// Pure parsing functions — testable with fixture HTML
export function parseThreadList(html: string): LinkedInThread[];
export function parseThreadMessages(html: string, threadId: string): LinkedInThreadContent | null;
export function threadToExtractedContent(thread: LinkedInThreadContent): ExtractedContent | null;

// MessageFetcher implementation
export class LinkedInFetcher implements MessageFetcher {
  readonly source = "linkedin";
  constructor(browser: BrowserClient, options?: { maxThreads?: number; delayMs?: number });
  getNewMessageIds(watermark: Date | null): Promise<string[]>;   // threadIds newer than watermark
  fetchMessage(threadId: string): Promise<ExtractedContent | null>;
}
```

### Test Plan (`phase4-fetcher-linkedin.test.mjs`)

**Group A — `parseThreadList` (pure, fixture HTML)**
- A1: Extracts threadId from thread URL in inbox HTML
- A2: Extracts participant names from thread list
- A3: Extracts lastMessageAt timestamp
- A4: Extracts snippet text
- A5: Returns empty array for empty inbox HTML
- A6: Skips threads with unparseable timestamps (never throws)
- A7: Handles multiple threads in one inbox page

**Group B — `parseThreadMessages` (pure, fixture HTML)**
- B1: Extracts all messages from a thread page
- B2: Each message has sender, sentAt, text
- B3: Returns null for empty/unparseable thread HTML
- B4: Filters out empty message bodies
- B5: Handles single-message thread

**Group C — `threadToExtractedContent` (pure)**
- C1: Concatenates all messages into a single text block with sender attribution
- C2: `subject` is `"LinkedIn: {participant names}"`
- C3: `from` is the first non-self participant
- C4: `date` is the most recent message sentAt
- C5: `parties` is the deduplicated list of all participants
- C6: Returns null for thread with no messages
- C7: `sourceId` is `"linkedin:{threadId}"`

**Group D — `LinkedInFetcher.getNewMessageIds` (mock browser)**
- D1: Navigates to `/messaging/` and returns threadIds
- D2: Filters out threads older than watermark
- D3: Returns all threads when watermark is null
- D4: Returns empty array when inbox is empty
- D5: Respects `maxThreads` option

**Group E — `LinkedInFetcher.fetchMessage` (mock browser)**
- E1: Navigates to thread URL and returns ExtractedContent
- E2: Returns null when thread page returns no messages
- E3: Returns null on browser navigation error (never throws)
- E4: Respects `delayMs` between requests (rate limiting)

**Total: ~22 tests before implementation**

### Definition of Done
- [x] Phase 4 TDD spec written in INTELLIGENCE_ROADMAP.md
- [x] `phase4-fetcher-linkedin.test.mjs` written — 28 tests, all GREEN (commit 502006a)
- [x] `phase4-fetcher-linkedin.ts` implemented — `parseThreadList`, `parseThreadMessages`, `threadToExtractedContent`, `LinkedInFetcher`, `parseLinkedInTimestamp`, `LinkedInEvasionConfig`
- [x] Real LinkedIn DOM selectors verified against live page 2026-03-08
- [x] Evasion interface specced — jitter (implemented), mouse sim / human scroll / randomize order / session batch limit (stubs, not yet needed)
- [x] Execution model settled — LinkedIn is OC agent job, NOT wired into `ingest.mjs` (commit 3cd8c87)
**Submodules** (three distinct scrape targets):
1. **Global message list** (`/messaging/`) — thread discovery, low signal, already built
2. **Contact message history** (`/messaging/thread/<id>/`) — behavioral signals, already built
3. **Contact profile** (`/in/<username>/`) — dossier enrichment + edge signals ← to build

- [ ] `parseContactProfile(html)` — pure function, fixture HTML from live DOM ← NEXT
- [ ] `profileToExtractedContent(profile)` — maps to ExtractedContent for pipeline
- [ ] `extractEdgeSignals(profile, selfName)` — emits EdgeSignal[] (feeds Phase 3b resolver)
- [ ] `LinkedInProfileFetcher` — navigates `/in/<username>/`, calls above
- [ ] Wire `BrowserClient` production impl using OC `browser` tool calls
- [ ] Register OC cron job for LinkedIn ingestion (agent job, uses browser tool directly)
- [ ] Smoke test: run OC agent job against live LinkedIn inbox

---

## Phase 5: Network Intelligence

### Goals

Automated detection of high-impact actions from the contact graph. Generalizes the offensive network intelligence framework into a reusable graph analysis layer that any ShadowDB user can run against their knowledge base.

### The 8 Plays (from schema/10783)

| # | Play | What It Detects | Signal Source |
|---|------|-----------------|---------------|
| 1 | **Network Gap** | Everyone in cluster needs X, no one provides | Contact dossiers + stated needs |
| 2 | **Implied Need** | They say Y, but context means they need Z | Message history + dossier context |
| 3 | **Bottleneck** | Who controls access to multiple clusters | Graph betweenness centrality |
| 4 | **Cluster Vulnerability** | Collective blind spot in a group | Cluster-wide dossier analysis |
| 5 | **Competitive Void** | High demand, zero supply in network | Cross-cluster need/supply matching |
| 6 | **Obligation Cascade** | Design favors to hit 3 people at once | Graph path analysis + need matching |
| 7 | **Information Arbitrage** | Cluster A needs what B has, they don't talk | Cross-cluster bridging analysis |
| 8 | **Predictive Positioning** | What they'll need in 6 months | Temporal signal + growth stage pattern matching |

### Core Abstractions

```typescript
/**
 * Run all 8 network intelligence plays against the current graph.
 * Returns ranked opportunities with impact scores and recommended actions.
 *
 * @param db        - Database connection (graph edges, dossiers, memories)
 * @param llm       - LLM client for implied need / prediction analysis
 * @param options   - Filter options (cluster, min confidence, etc.)
 * @returns         - Ranked opportunity list
 */
export function detectNetworkOpportunities(
  db: DbClient,
  llm: LlmClient,
  options?: NetworkAnalysisOptions,
): Promise<NetworkOpportunity[]>;

/**
 * Compute betweenness centrality for all nodes in the contact graph.
 * Identifies bottleneck nodes that control information flow between clusters.
 *
 * @param edges - Graph edges from ShadowDB
 * @returns     - Nodes ranked by betweenness centrality score
 */
export function computeBetweennessCentrality(
  edges: GraphEdge[],
): CentralityResult[];

/**
 * Detect clusters in the contact graph using community detection.
 * Groups contacts by connection density, shared attributes, or shared events.
 *
 * @param edges - Graph edges
 * @param nodes - Contact nodes with metadata
 * @returns     - Detected clusters with member lists
 */
export function detectClusters(
  edges: GraphEdge[],
  nodes: ContactNode[],
): Cluster[];

/**
 * Generate a daily opportunity briefing from network analysis results.
 * Ranks by impact, groups by urgency (today / this week / predictive).
 *
 * @param opportunities - Output from detectNetworkOpportunities
 * @returns             - Formatted briefing
 */
export function generateOpportunityBriefing(
  opportunities: NetworkOpportunity[],
): OpportunityBriefing;
```

### Prediction Format (from rules/10344)

Every prediction must include:
```
P[number]: [Specific outcome statement]
- By when: [Date or range]
- What user can do to influence it: [Specific action]
- What happens if user does nothing: [Specific consequence]
- Confidence: [LOW/MEDIUM/HIGH] — [rationale]
- Falsification: [How we'll know this was wrong]
```

### Named Intelligence Queries (ARCHITECTURE.md § 9)

| Query | Natural language | Tier |
|-------|-----------------|------|
| `queryGroupRelationship` | "Does GroupA know GroupB?" | STANDARD |
| `queryGroupAffinity` | "Would GroupA like GroupB?" | STANDARD |
| `queryLeverage` | "Does GroupA have leverage over GroupB?" | DEEP |
| `queryIntroPath` | "How do I get intros from GroupA to GroupB?" | DEEP |

All queries: read-only, LLM-augmented, graceful degradation, cacheable as pattern_events.

### Definition of Done
- [ ] `computeBetweennessCentrality` — unit tests with fixture graphs
- [ ] `detectClusters` — unit tests with known cluster structures
- [ ] `computeGroupPsychProfile` — aggregate DISC, dominant language, blind spots, collective anxieties, entry point, decision pattern
- [ ] `queryGroupRelationship` — path search, bridge nodes, tension warnings
- [ ] `queryGroupAffinity` — psychometric compatibility, shared language, friction signals, verdict
- [ ] `queryLeverage` — dependency graph, obligation cascade, information asymmetry, reversibility
- [ ] `queryIntroPath` — optimal intro sequence, Voss-informed framing per step, risk factors
- [ ] `detectNetworkOpportunities` — all 8 plays against resolved graph
- [ ] `generateOpportunityBriefing` — ranked by urgency (today / this week / predictive)
- [ ] Group outreach generation — copy that reads as written by an in-group member
- [ ] Daily cron: runs analysis, announces high-impact opportunities
- [ ] Staleness check: dossiers >7 days flagged for revalidation before use

---

## Architecture: Before Phase 2 Starts

Two structural gaps must be closed before implementing any new intelligence
module. Both are spec'd in full in `extensions/memory-shadowdb/ARCHITECTURE.md`.

### Gap 1: LLM Context Tier Routing

The current `LlmClient` is a flat `{ complete(prompt): Promise<string> }`.
It has no concept of context window size, JSON mode, or model selection.

Scoring a 200-token email and running a 50K-token cross-reference analysis
are fundamentally different operations — they need different models.
Routing both through the same interface silently produces garbage when the
task exceeds the model's context window.

**Fix:** `TieredLlmClient` extends `LlmClient` (backward compatible) and adds:
- `LlmTier` enum: `FLASH` (≤4K) | `STANDARD` (≤32K) | `DEEP` (≤128K) | `MASSIVE`
- `LlmTask` type: prompt + tier + outputFormat + maxTokens + disableThinking
- `LlmRouter` class: selects model by tier, fallback chain, JSON mode wiring
- All existing callers continue to work via `complete()` (treated as FLASH)

**Task → Tier mapping:**
| Task | Tier |
|------|------|
| `scoreInterestingness` | FLASH |
| `extractBehavioralSignals` | STANDARD |
| `crossReferenceDocument` | DEEP |
| `detectNetworkOpportunities` | DEEP |
| `generateOpportunityBriefing` | STANDARD |
| `extractContractTerms` | STANDARD |

### Gap 2: Source Heterogeneity (`DataSource<T>`)

`MessageFetcher` is great for message streams (email, iMessage, LinkedIn DMs).
It's wrong for entity registries and event logs:

| Source Type | Shape | Examples |
|-------------|-------|---------|
| Message stream | Timestamped text from/to parties | Gmail, iMessage, LinkedIn DMs |
| Entity registry | Structured records with fields | Apple Contacts, Crunchbase, HubSpot |
| Event log | Time-bounded structured events | Calendar, Eventbrite |
| Document store | Files with metadata | Contracts, Notion, Obsidian |

**Fix:** `DataSource<T>` generic interface alongside `MessageFetcher`:
```typescript
interface DataSource<T> {
  readonly sourceId: string;
  readonly displayName: string;
  readonly category: string;
  getUpdatedRecords(watermark: Date | null): Promise<T[]>;
  getRecordId(record: T): string;
  extractContent(record: T): ExtractedContent | null;
}
```

Adding Crunchbase = implement `DataSource<CrunchbaseEntity>`.
Adding Apple Contacts = implement `DataSource<AppleContact>`.
Nothing else in the pipeline changes.

### Implementation Order (TDD, both gaps)

1. ~~`llm-router.test.mjs` written → `llm-router.ts` implemented → commit~~ ✅ done (c718bcb) — 42 tests
2. ~~`data-source.test.mjs` written → `data-source.ts` implemented → commit~~ ✅ done (5cc3312) — 23 tests
3. ~~Callers updated: `phase1-scoring`, `phase3-contact-signal` accept `TieredLlmClient`~~ ✅ done (ee0c221) — 11 tests
4. First `DataSource<T>` impl: `AppleContactsSource` ← NEXT

---

## `DataSource<T>` — Full TDD Spec

### Design Philosophy

`DataSource<T>` is the second interface family, parallel to `MessageFetcher`.
Where `MessageFetcher` models a timestamped message stream (email, iMessage),
`DataSource<T>` models an entity registry or event log — sources where records
have identity and can be updated, not just appended.

**Core principles:**
- Generic over the raw record type T. The implementation knows the shape; the runner doesn't.
- Four methods only. Every source implements exactly: `getUpdatedRecords`, `getRecordId`, `extractContent`, plus two readonly properties (`sourceId`, `displayName`, `category`).
- Same watermark pattern as `MessageFetcher` — `getUpdatedRecords(watermark)` returns records modified since that date. Null watermark = full sync.
- `getRecordId` returns a stable, unique string for dedup. The runner uses `sourceId:recordId` as `operationId` — same record re-synced = zero duplicate writes.
- `extractContent` returns `ExtractedContent | null`. Returning null skips the record (no scoring, no write). Never throws.
- `runDataSourceIngestion<T>` is the generic runner — identical pipeline to `runIngestion` (entity filter → LLM score → chunk → resolveParties → write → Phase 3 hook) but driven by a `DataSource<T>` instead of a `MessageFetcher`.

### Exported Surface (`data-source.ts`)

```typescript
// The generic interface — implement this for any new source
export interface DataSource<T> {
  readonly sourceId: string;       // "contacts:apple", "contacts:crunchbase", "calendar:apple"
  readonly displayName: string;    // "Apple Contacts"
  readonly category: string;       // "contacts", "events", "companies"
  getUpdatedRecords(watermark: Date | null): Promise<T[]>;
  getRecordId(record: T): string;
  extractContent(record: T): ExtractedContent | null;
}

// Concrete record types
export interface AppleContact { id, firstName, lastName, emails, phones, company?, title?, notes?, modifiedAt }
export interface CrunchbaseEntity { uuid, name, entityType, shortDescription?, description?, fundingTotal?, lastFundingType?, primaryRole?, linkedinUrl?, websiteUrl?, updatedAt }
export interface CalendarEvent { uid, title, startTime, endTime, attendees, location?, notes?, calendar, modifiedAt }

// Runner — same return type as runIngestion
export async function runDataSourceIngestion<T>(
  config: IngestionConfig,
  source: DataSource<T>,
  db: DbClient,
  store: ShadowStore,
  llm: TieredLlmClient | LlmClient,
  hooks?: IngestionHooks,
): Promise<IngestionRunRow>;
```

### Test Plan (`data-source.test.mjs`)

**Group A — DataSource interface contract (via mock implementation)**
- A1: Mock implementation satisfying the interface compiles and runs
- A2: `getUpdatedRecords(null)` returns all records (full sync)
- A3: `getUpdatedRecords(watermark)` returns only records modified after watermark
- A4: `getRecordId` returns stable unique string for same record
- A5: `extractContent` returning null causes record to be skipped
- A6: `extractContent` throwing is caught — never propagates to runner

**Group B — operationId dedup**
- B1: `operationId` is `sourceId:recordId` (e.g. `"contacts:apple:ABC123"`)
- B2: Same record processed twice = zero duplicate writes (idempotent)
- B3: Different records from same source get different operationIds

**Group C — `runDataSourceIngestion` pipeline**
- C1: Empty record list → run completes with 0 ingested
- C2: Record that passes entity filter + score threshold → written to store
- C3: Record whose `extractContent` returns null → skipped (not written)
- C4: Record that fails entity filter → skipped
- C5: Record that fails LLM score gate → skipped
- C6: `messages_ingested` + `messages_skipped` counts are correct
- C7: Run status is COMPLETE when all records processed without error
- C8: Run status is PARTIAL when some records throw during processing

**Group D — watermark and audit**
- D1: `ingestion_runs` row is returned with correct source + account
- D2: `new_watermark` is the most recent `modifiedAt` across ingested records
- D3: `new_watermark` is null when no records were ingested
- D4: Watermark from prior run is passed to `getUpdatedRecords`

**Group E — Phase 3 hook wiring**
- E1: `onNewContactSignal` hook fires for records that resolve to a known contact
- E2: Hook failure does not abort the run

**Total: ~20 tests before implementation**

---

## `llm-router` — Full TDD Spec

### Design Philosophy

The router is a **policy layer**, not a model wrapper. It knows nothing about
what the model says — only which model to call based on declared task requirements.

**Core principles:**
- Tasks declare what they need (tier, output format, token budget). Router decides which model satisfies those requirements. No caller should hardcode a model name.
- Tier is a minimum, not a target. A FLASH task can run on a STANDARD model if FLASH is unavailable. A DEEP task must not run on a FLASH model (would silently truncate).
- Fallback chain is exhaustive. If all models for a tier fail, the router throws `LlmRoutingError` — a typed error with the tier and the list of models attempted. Callers can catch this.
- `complete(prompt)` is always FLASH tier. This preserves backward compatibility with all existing callers — they get correct behavior (fast, cheap model) without changes.
- JSON mode and thinking suppression are request-level options, not model-level. The router wires them into the API call if the selected model supports them.
- No global state. `LlmRouter` is a class — instantiate it with config. Tests inject mock HTTP servers or mock model pools.
- All network I/O goes through an injectable `HttpClient` interface so tests never hit real endpoints.

### What `LlmRouter` Does (and Does Not Do)

**Does:**
- Select the highest-priority eligible model for the requested tier
- Walk the fallback chain on failure (HTTP error, timeout, model overloaded)
- Apply `disableThinking` as `chat_template_kwargs: { enable_thinking: false }` for Qwen3 models
- Apply `response_format: { type: "json_object" }` when `outputFormat === "json"` and model supports it
- Clamp `maxTokens` to the model's output limit if exceeded
- Log which model was selected and which fell back (for debugging)
- Return raw completion text — no parsing, no interpretation

**Does not:**
- Parse, validate, or interpret the completion
- Retry on bad completions (garbage output = caller's problem)
- Cache completions
- Rate-limit or throttle
- Know anything about prompts, scores, or business logic

### Exported Surface

```typescript
// Tier enum — order matters (FLASH < STANDARD < DEEP < MASSIVE)
export enum LlmTier { FLASH = "flash", STANDARD = "standard", DEEP = "deep", MASSIVE = "massive" }

// A task submitted to the router
export interface LlmTask {
  prompt: string;
  tier: LlmTier;
  outputFormat?: "text" | "json" | "number";
  maxTokens?: number;
  disableThinking?: boolean;
}

// Configuration for one model in the pool
export interface ModelConfig {
  id: string;               // OpenAI-compatible model name ("qwen3.5-35b-a3b-4bit")
  label: string;            // Human-readable ("Qwen3.5-35B @ oMLX")
  baseUrl: string;          // API root ("http://localhost:8000/v1")
  apiKey: string;
  contextWindow: number;    // Max tokens (input + output) this model supports
  outputLimit: number;      // Max completion tokens (clamped if maxTokens exceeds this)
  tier: LlmTier;            // Which tier this model is optimized for
  supportsJsonMode: boolean; // Whether response_format: json_object works
  isQwen3: boolean;         // Whether to use chat_template_kwargs for thinking control
  priority: number;         // Lower = preferred within tier (0 = most preferred)
}

// The full pool config
export interface LlmRouterConfig {
  models: ModelConfig[];
  timeoutMs?: number;       // Per-request timeout (default 30000)
}

// Thrown when all fallbacks fail
export class LlmRoutingError extends Error {
  constructor(
    public readonly tier: LlmTier,
    public readonly attempted: string[],  // model ids tried
    public readonly lastError: Error,
  ) { ... }
}

// Injectable HTTP client (real = fetch; test = mock)
export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ text: string }>;
}

// The router class
export class LlmRouter implements TieredLlmClient {
  constructor(config: LlmRouterConfig, http?: HttpClient);
  run(task: LlmTask): Promise<string>;
  complete(prompt: string): Promise<string>;  // FLASH tier, backward compat
}
```

### Test Plan (all tests in `llm-router.test.mjs`)

**Group A — `LlmTier` enum**
- A1: Enum has exactly FLASH, STANDARD, DEEP, MASSIVE values
- A2: Tier values are stable strings (not numbers) — guards against accidental refactor

**Group B — Model selection (pure, no HTTP)**
- B1: Single FLASH model in pool → selected for FLASH task
- B2: Single STANDARD model in pool → selected for STANDARD task
- B3: STANDARD model satisfies DEEP task when no DEEP model configured (upward promotion allowed)
- B4: FLASH model must NOT satisfy DEEP task (downward demotion forbidden)
- B5: Two FLASH models → lower priority number wins
- B6: Two FLASH models same priority → first in config array wins (stable)
- B7: No model covers the requested tier → throws `LlmRoutingError` before HTTP call
- B8: `LlmRoutingError` carries tier, empty attempted list (no calls made)

**Group C — HTTP call construction (mock HTTP)**
- C1: Prompt is sent as user message in messages array
- C2: Model id is sent as `model` field
- C3: `maxTokens` maps to `max_tokens` in request body
- C4: `maxTokens` omitted → request uses model's `outputLimit`
- C5: `maxTokens` exceeds `outputLimit` → clamped to `outputLimit`
- C6: `outputFormat: "json"` + `supportsJsonMode: true` → `response_format: { type: "json_object" }` in body
- C7: `outputFormat: "json"` + `supportsJsonMode: false` → NO `response_format` field (model doesn't support it)
- C8: `disableThinking: true` + `isQwen3: true` → `chat_template_kwargs: { enable_thinking: false }` in body
- C9: `disableThinking: true` + `isQwen3: false` → NO `chat_template_kwargs` field
- C10: `disableThinking` omitted → NO `chat_template_kwargs` field regardless of isQwen3
- C11: Auth header sent as `Authorization: Bearer <apiKey>`
- C12: Content-Type header is `application/json`

**Group D — Response parsing**
- D1: Well-formed completion returns `choices[0].message.content` string
- D2: Empty `choices` array → throws (caller gets `LlmRoutingError` via fallback)
- D3: Missing `choices` key → throws
- D4: `content` is null → throws
- D5: Extra fields in response are ignored (resilient to API version drift)

**Group E — Fallback chain (mock HTTP)**
- E1: First model returns HTTP 500 → second model is tried → second succeeds → returns result
- E2: First model throws network error → second model tried → success
- E3: All models fail → throws `LlmRoutingError` with all model ids in `attempted`
- E4: `LlmRoutingError.lastError` is the error from the LAST attempted model
- E5: Fallback does not cross tier boundary downward (STANDARD model not used as fallback for DEEP if it doesn't cover DEEP's context needs)
- E6: Fallback respects priority ordering (priority=0 tried before priority=1)

**Group F — `complete()` backward compat**
- F1: `complete(prompt)` routes to FLASH tier
- F2: `complete(prompt)` returns raw completion string
- F3: `complete(prompt)` with only STANDARD model in pool → uses STANDARD (upward promotion)
- F4: `complete(prompt)` with no models → throws `LlmRoutingError`

**Group G — Timeout**
- G1: Request exceeding `timeoutMs` → throws (treated as model failure, triggers fallback)
- G2: Default timeout is 30000ms (verifiable via mock that delays)

**Group H — Logging**
- H1: Successful call logs selected model label (to injected logger)
- H2: Fallback logs which model failed and which was next (to injected logger)
- H3: Logger is optional — no logger = no crash

**Total: ~28 tests before implementation**

---

## Cross-Cutting Requirements

### Staleness Enforcement
- Records used for decisions/outreach/analysis must be checked for age
- Dossiers >7 days old → flag for rebuild (re-search web, Gmail, LinkedIn, calendar)
- Structural analysis >30 days old → flag for revalidation
- Timeless records (rules, directives) exempt
- Staleness check runs at retrieval time in the search pipeline

### Dossier Versioning (from rules/10350)
Every contact dossier carries a version: `v[methodology]:[source_bitmask]`
- Source bits: web(1) + LinkedIn(2) + Gmail(4) + iMessage(8) + CRM(16) + Calendar(32) + In-person(64) + Graph(128) + Personality(256) + Events(512)
- Ingestion pipeline automatically updates source bitmask when new source data is incorporated

### Testing Strategy
- Test file written before implementation — always
- Each function contract = one describe block with ≥3 test cases
- External calls (LLM, CLI) always mockable via dependency injection
- No `any` in TypeScript strict mode
- Graceful degradation: ingestion/analysis failure never crashes the host application

---

## Non-Goals

- Real-time streaming ingestion (batch/cron only)
- Multi-user / shared ShadowDB (single-user)
- Cloud sync or external backups
- Automatic contact graph mutations (analysis recommends, user approves)

---

## Current State

| Phase | Status | Tests | HEAD |
|-------|--------|-------|------|
| 0 — Foundation | ✅ Complete | 56 | `8ea2eed` |
| 1 — Ingestion (Gmail + iMessage) | ✅ Complete | 108 | `fd1a5e2` |
| Arch — LlmRouter (TieredLlmClient) | ✅ Complete | 42 | `c718bcb` |
| Arch — Tier wiring (scoring + signals) | ✅ Complete | 11 | `ee0c221` |
| Arch — DataSource\<T\> + runner | ✅ Complete | 23 | `5cc3312` |
| 3 — Contact Re-Scoring (foundation) | ✅ Complete | 19 | `6d3516d` |
| 4 — LinkedIn (threads + profile + edge signals) | 🟡 In progress | 28 | `3cd8c87` |
| 3b — Entity Resolution (cross-source node graph) | 🔲 Planned | — | — |
| 2 — PDF/Contract | 🔲 Planned | — | — |
| 3 — Contact Re-Scoring (full) | 🔲 Planned | — | — |
| 5 — Network Intelligence + Group Psychometrics | 🔲 Planned | — | — |

**Total test count:** 567/567 passing, zero RED, zero TS errors
**Repo:** `git@github.com:jamesdwilson/Sh4d0wDB.git`
**HEAD:** `3cd8c87`
