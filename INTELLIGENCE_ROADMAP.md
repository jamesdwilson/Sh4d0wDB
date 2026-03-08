# ShadowDB Intelligence Initiative — Implementation Roadmap

**Created:** 2026-03-07
**Last updated:** 2026-03-07 23:20 CST
**Status:** Phase 1 complete · Phase 2–5 planned

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

### Entry Points

- `scripts/ingest.mjs` — CLI: `node scripts/ingest.mjs --source all|gmail|imsg [--dry-run] [--limit N]`
- `scripts/preview-ingest.mjs` — Live preview: shows VETO/DROP/KEEP per message with LLM scores
- OpenClaw cron: daily 6am CST, `--source all --limit 200`

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
- [ ] `onNewContactSignal` stub wired into ingestion runner (callback, no-op default)
- [ ] `extractBehavioralSignals` — unit tests with 5+ fixture messages
- [ ] `computePsychographicDelta` — unit tests covering DISC shift, no-change, and threshold edge cases
- [ ] `crossReferenceDocument` — integration test: ingest 2 related docs, verify pattern detected
- [ ] `classifyPassageRelationship` — unit tests: contradiction, confirmation, drift, unrelated
- [ ] Pattern events stored in `pattern_events` table with correct type, confidence, record_ids
- [ ] High-confidence patterns (≥0.80) trigger proactive alert

---

## Phase 4: LinkedIn Ingestion

### Goals
- Implement `LinkedInFetcher` conforming to `MessageFetcher` interface
- Browser-based scrape (LinkedIn lazy-loads, no API)
- Message threads preserved as single units (not chunked mid-thread)
- Cross-source linking: Gmail LinkedIn notification → triggers LinkedIn message fetch
- Idempotent: keyed on thread URL + timestamp

### Definition of Done
- [ ] `LinkedInFetcher` implements `MessageFetcher`
- [ ] `extractLinkedInHints()` detects LinkedIn notification emails and extracts fetch hints
- [ ] `FetchHint` type added to `MessageFetcher` interface (optional `extractHints?()` method)
- [ ] Browser automation extracts messages from last 90 days
- [ ] Entity filter + interestingness score applied (threshold ≥6)
- [ ] Integration test: fixture HTML → DB state verification

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

### Definition of Done
- [ ] `computeBetweennessCentrality` — unit tests with fixture graphs
- [ ] `detectClusters` — unit tests with known cluster structures
- [ ] `detectNetworkOpportunities` — integration test: seed graph, verify all 8 plays detected
- [ ] `generateOpportunityBriefing` — unit test: fixture opportunities → formatted output
- [ ] Predictions follow the specific/testable/actionable format
- [ ] Daily cron: runs analysis, announces if new high-impact opportunities detected
- [ ] Staleness check: dossiers >7 days old are flagged for revalidation before use in analysis

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
| 1 — Ingestion | ✅ Complete | 108 | `fd1a5e2` |
| 2 — PDF/Contract | 🔲 Planned | — | — |
| 3 — Contact Re-Scoring | 🔲 Planned | — | — |
| 4 — LinkedIn | 🔲 Planned | — | — |
| 5 — Network Intelligence | 🔲 Planned | — | — |

**Total test count:** 444/444 passing, zero RED
**Repo:** `git@github.com:jamesdwilson/Sh4d0wDB.git`
