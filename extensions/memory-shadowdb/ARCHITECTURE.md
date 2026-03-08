# ShadowDB Intelligence Layer — Architecture Contracts

**Last updated:** 2026-03-08
**Status:** Living document — update before implementing any new module

---

## 1. The Two Problems Being Solved Here

### 1.1 LLM Context Tier Mismatch

Not all operations need the same model. Running a 128K-context cross-reference
analysis with a 2K-context model will silently produce garbage. Routing a
200-token interestingness score to a 128K model wastes money and latency.

The current `LlmClient` interface is:

```typescript
interface LlmClient {
  complete(prompt: string): Promise<string>;
}
```

This is **too thin**. It has no concept of:
- What context size the task needs
- Whether the model supports JSON output mode
- Whether the model supports structured function calling
- What the latency/cost tradeoff is (fast cheap vs slow powerful)

**Fix:** Replace with a tiered routing system. Tasks declare their tier.
The `LlmRouter` picks the right model. Each tier has a fallback chain.

### 1.2 Source Heterogeneity

`MessageFetcher` covers message streams (email, iMessage, LinkedIn DMs) well.
But not all data sources are message streams:

| Source Type | Shape | Example Sources |
|-------------|-------|-----------------|
| Message stream | Timestamped text from/to parties | Gmail, iMessage, LinkedIn DMs |
| Entity registry | Structured records with fields | Apple Contacts, Crunchbase, HubSpot |
| Event log | Time-bounded structured events | Calendar, Eventbrite, Meetup |
| Document store | Files with metadata | Contracts folder, Notion, Obsidian |
| Social feed | Posts with engagement metrics | LinkedIn posts, Twitter |

`MessageFetcher` forces entity registries into a message-stream shape.
That's wrong: Apple Contacts doesn't have "new messages since watermark" —
it has "contacts modified since date" with a completely different field schema.

**Fix:** Two parallel interface families:
1. `MessageFetcher` — remains for message streams (already built, keep it)
2. `DataSource<T>` — generic interface for entity registries and event logs

---

## 2. LLM Context Tier System

### 2.1 Tier Definitions

```
TIER_FLASH    ≤ 4K tokens    → scoring, classification, single-fact extraction
TIER_STANDARD ≤ 32K tokens   → behavioral analysis, summarization, entity extraction
TIER_DEEP     ≤ 128K tokens  → cross-reference, dossier synthesis, network analysis
TIER_MASSIVE  ≤ 1M tokens    → full corpus analysis (future, not yet used)
```

### 2.2 Task → Tier Mapping

| Task | Tier | Why |
|------|------|-----|
| `scoreInterestingness` | FLASH | Input ≤ 500 tokens, output = single number |
| `extractBehavioralSignals` | STANDARD | Input = 1 message + 3 context msgs; output = JSON object |
| `computePsychographicDelta` | STANDARD (pure) | Pure function — no LLM |
| `crossReferenceDocument` | DEEP | Needs full document + top-N similar chunks in context |
| `detectNetworkOpportunities` | DEEP | Needs graph summary + all dossiers for cluster |
| `generateOpportunityBriefing` | STANDARD | Takes structured opportunities, outputs prose |
| `extractContractTerms` | STANDARD | Medium-length doc + structured output |

### 2.3 `TieredLlmClient` Interface (replaces `LlmClient`)

```typescript
/**
 * A task to be executed by the LLM router.
 * The router picks the appropriate model based on the task's tier and options.
 */
export interface LlmTask {
  /** The prompt to send */
  prompt: string;

  /**
   * Minimum context tier required for this task.
   * Router will never downgrade — only use this tier or higher.
   */
  tier: LlmTier;

  /**
   * Expected output format. Router will enable JSON mode if supported by the model.
   * "text"   — free-form text (default)
   * "json"   — structured JSON object
   * "number" — single number (router may use logit bias if supported)
   */
  outputFormat?: "text" | "json" | "number";

  /**
   * Maximum tokens in the completion. Router uses model-appropriate default if omitted.
   * Set explicitly when you need to control cost (e.g., scoring: maxTokens=16).
   */
  maxTokens?: number;

  /**
   * If true, instruct the model to skip chain-of-thought / thinking blocks.
   * Useful for scoring tasks where thinking bloats output and costs tokens.
   * Maps to chat_template_kwargs.enable_thinking=false for Qwen3 models.
   */
  disableThinking?: boolean;
}

/**
 * Extended LLM client with context tier awareness.
 *
 * Replaces the original `LlmClient` (single complete() method).
 * All existing callers that pass `llm: LlmClient` will accept a
 * `TieredLlmClient` because `complete()` is preserved for backward compat.
 *
 * New callers should use `run(task)` for tier-aware routing.
 */
export interface TieredLlmClient extends LlmClient {
  /**
   * Execute an LLM task with automatic model selection based on tier.
   *
   * Selection rules:
   *   1. Find all configured models that support the requested tier (contextWindow >= tier.minTokens)
   *   2. Among eligible models, prefer the fastest/cheapest that covers the tier
   *   3. If preferred model fails, fall back to next in chain
   *   4. If all fail, throw LlmRoutingError
   *
   * @param task - Task spec including prompt, tier, output format
   * @returns    - Raw completion text (caller parses)
   * @throws     - LlmRoutingError if no eligible model available
   */
  run(task: LlmTask): Promise<string>;

  /**
   * Backward-compatible shorthand. Equivalent to:
   *   run({ prompt, tier: LlmTier.FLASH, outputFormat: "text" })
   *
   * Existing callers that use complete() get FLASH tier by default.
   * This means simple scoring tasks still work with the old interface.
   */
  complete(prompt: string): Promise<string>;
}
```

### 2.4 `LlmTier` Enum

```typescript
export enum LlmTier {
  FLASH    = "flash",     // ≤ 4K context, fast + cheap
  STANDARD = "standard",  // ≤ 32K context, balanced
  DEEP     = "deep",      // ≤ 128K context, powerful
  MASSIVE  = "massive",   // ≤ 1M context, future use
}
```

### 2.5 `ModelConfig` and Router Config

```typescript
/** Configuration for a single model in the router's pool */
export interface ModelConfig {
  /** OpenAI-compatible API model name */
  id: string;
  /** Human-readable label (for logging) */
  label: string;
  /** Base URL for the API endpoint */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Maximum context window in tokens (input + output) */
  contextWindow: number;
  /** Tier this model is optimized for */
  tier: LlmTier;
  /** Whether this model supports JSON output mode */
  supportsJsonMode: boolean;
  /** Whether this model is a Qwen3-family model (for thinking block handling) */
  isQwen3: boolean;
  /** Priority within tier — lower = preferred (0 = most preferred) */
  priority: number;
}

/** Router configuration: a pool of models, one per tier (with fallbacks) */
export interface LlmRouterConfig {
  models: ModelConfig[];
}
```

### 2.6 Default Model Pool (for this deployment)

```
FLASH:    qwen3.5-35b-a3b-4bit @ oMLX :8000 (priority 0)
          — fast MoE, good at classification, cheap per token

STANDARD: qwen3.5-35b-a3b-4bit @ oMLX :8000 (priority 0)
          — same model, fits standard tasks comfortably

DEEP:     qwen3.5-35b-a3b-4bit @ oMLX :8000 (priority 0)
          — 32K+ context available; deep tasks use full window
          — fallback: openrouter/auto (remote, paid) if local fails

MASSIVE:  Not configured — no 1M-context model available locally
```

Note: on this hardware (M3 Max 36GB), the same model covers all three local
tiers. The tier system exists so that when a 128K+ model becomes available,
the router can automatically upgrade DEEP tasks without touching any caller.

---

## 3. Data Source Interface Family

### 3.1 `DataSource<T>` — Generic Interface

```typescript
/**
 * Generic data source interface for entity registries and event logs.
 * Covers sources that are NOT message streams (use MessageFetcher for those).
 *
 * Type parameter T is the raw record shape returned by this source
 * (e.g., AppleContact, CrunchbaseCompany, CalendarEvent).
 *
 * Implementing a new source = implementing these 4 methods.
 * The ingestion runner handles all pipeline logic.
 */
export interface DataSource<T> {
  /**
   * Stable identifier for this source. Stored in ingestion_runs.source.
   * Convention: "contacts:apple", "contacts:crunchbase", "calendar:apple",
   * "social:linkedin", "crm:hubspot"
   */
  readonly sourceId: string;

  /**
   * Human-readable name for logging.
   */
  readonly displayName: string;

  /**
   * Return records modified since the watermark.
   * For sources without modification timestamps, return all records.
   * Never throws — return [] on any error.
   *
   * @param watermark - Timestamp of last successful sync, or null for full sync
   * @returns         - Array of raw records from this source
   */
  getUpdatedRecords(watermark: Date | null): Promise<T[]>;

  /**
   * Extract a stable unique ID from a raw record.
   * Used as operationId for dedup (same ID = same record, idempotent write).
   * Must be stable across re-fetches of the same record.
   *
   * @param record - Raw record from getUpdatedRecords()
   * @returns      - Stable unique string ID
   */
  getRecordId(record: T): string;

  /**
   * Transform a raw record into ShadowDB-ready ExtractedContent.
   * Returns null to skip (e.g., record has no useful text content).
   * Never throws.
   *
   * @param record - Raw record from getUpdatedRecords()
   * @returns      - Extracted content ready for scoring + write, or null to skip
   */
  extractContent(record: T): ExtractedContent | null;

  /**
   * Category to assign when writing to ShadowDB.
   * "contacts" for people, "events" for calendar, "companies" for orgs, etc.
   */
  readonly category: string;
}
```

### 3.2 Planned Implementations

| Implementation | `sourceId` | Type T | Status |
|----------------|------------|--------|--------|
| `GmailFetcher` | `"gmail"` | `ExtractedContent` (message stream) | ✅ Done |
| `IMessageFetcher` | `"imsg"` | `ExtractedContent` (message stream) | ✅ Done |
| `LinkedInFetcher` | `"linkedin"` | `ExtractedContent` (message stream) | Phase 4 |
| `AppleContactsSource` | `"contacts:apple"` | `AppleContact` | Phase 3+ |
| `CrunchbaseSource` | `"contacts:crunchbase"` | `CrunchbaseCompany` | Phase 3+ |
| `CalendarSource` | `"calendar:apple"` | `CalendarEvent` | Phase 3+ |
| `NotionSource` | `"docs:notion"` | `NotionPage` | Future |
| `HubSpotSource` | `"crm:hubspot"` | `HubSpotContact` | Future |

### 3.3 `DataSource<T>` raw record shapes

```typescript
/** Apple Contacts record (via osxphotos CLI or applescript) */
export interface AppleContact {
  id: string;           // vCard UID or phone number
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  company?: string;
  title?: string;
  notes?: string;
  modifiedAt: Date;
}

/** Crunchbase company/person record (via Crunchbase API) */
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

/** Apple Calendar event (via icalBuddy or applescript) */
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

/** LinkedIn post or activity (via browser scrape or API) */
export interface LinkedInPost {
  urn: string;
  authorUrn: string;
  authorName: string;
  text: string;
  publishedAt: Date;
  likes: number;
  comments: number;
}
```

---

## 4. `runDataSourceIngestion` — Generic Runner

Parallel to `runIngestion` (for message streams), this runner handles
`DataSource<T>` sources. Same pipeline stages, different input shape.

```typescript
/**
 * Run a full ingestion pass for a DataSource<T>.
 *
 * Pipeline:
 *   getUpdatedRecords(watermark)
 *   → for each record:
 *       extractContent()          — source-provided transformation
 *       → passesEntityFilter()    — cheap regex gate
 *       → scoreInterestingness()  — LLM gate (FLASH tier)
 *       → chunkDocument()         — split into embeddable segments
 *       → resolveParties()        — fuzzy-match to known contacts
 *       → store.write()           — idempotent (operationId = sourceId:recordId)
 *       → onNewContactSignal()    — Phase 3 hook
 *
 * Same watermark-based dedup as message stream runner.
 * DataSource sources use `sourceId:recordId` as operationId.
 *
 * @param config  - Ingestion config
 * @param source  - DataSource<T> implementation
 * @param db      - Database client
 * @param store   - ShadowDB store
 * @param llm     - Tiered LLM client
 * @param hooks   - Optional lifecycle hooks (onNewContactSignal, etc.)
 * @returns       - Run statistics
 */
export async function runDataSourceIngestion<T>(
  config: IngestionConfig,
  source: DataSource<T>,
  db: DbClient,
  store: ShadowStore,
  llm: TieredLlmClient,
  hooks?: IngestionHooks,
): Promise<IngestionRunRow>;
```

---

## 5. Backward Compatibility Guarantees

1. **`LlmClient` interface is NOT removed** — `TieredLlmClient extends LlmClient`.
   Any code that accepts `LlmClient` will accept a `TieredLlmClient`.
   Any code that only needs `complete()` continues to work unchanged.

2. **`MessageFetcher` interface is NOT changed** — Gmail and iMessage fetchers
   are unaffected. New message-stream sources just implement `MessageFetcher`.

3. **`runIngestion()` signature is backward compatible** — the new `hooks`
   parameter has a default of `{}`. Existing callers pass nothing and it works.

4. **`LlmTask.tier` defaults to `FLASH`** — if a caller uses `complete()` (old
   interface), the router treats it as FLASH tier. No behavior change.

---

## 6. Implementation Order (TDD)

All test files written before implementation files.

### Step 1: `llm-router.ts` + `llm-router.test.mjs`
- `LlmTier` enum
- `LlmTask`, `ModelConfig`, `LlmRouterConfig` interfaces
- `TieredLlmClient` interface
- `LlmRouter` class: `run()`, `complete()`, tier selection, fallback chain
- Tests: tier routing, fallback, JSON mode, disableThinking flag, error cases
- Commit: "feat(arch): LlmRouter — tiered model routing, 20+ tests"

### Step 2: `data-source.ts` — interface + shared types
- `DataSource<T>` generic interface
- `AppleContact`, `CrunchbaseEntity`, `CalendarEvent`, `LinkedInPost` types
- `runDataSourceIngestion<T>()` function
- Tests: mock source, verify pipeline stages, dedup, hook firing
- Commit: "feat(arch): DataSource<T> interface + runDataSourceIngestion runner"

### Step 3: Update callers
- `phase1-scoring.ts`: accept `TieredLlmClient` (extends `LlmClient`, backward compat)
- `phase3-contact-signal.ts`: use `STANDARD` tier for `extractBehavioralSignals`
- `INTELLIGENCE_ROADMAP.md`: update Phase 5 to use `DEEP` tier for network analysis
- Commit: "refactor: wire TieredLlmClient into scoring + signal modules"

### Step 4: First DataSource implementation
- `AppleContactsSource` — simplest source (no external API, local CLI)
- Tests: mock CLI output → verify ExtractedContent shape
- Commit: "feat: AppleContactsSource implements DataSource<AppleContact>"

---

## 7. Entity Graph — Cross-Source Node Resolution

### 7.1 The Problem

Every source speaks in its own identifiers:
- Gmail: `amy@acme.com`
- LinkedIn: `Amy Chen, VP at Acme Corp`
- iMessage: `+1-404-555-0192`
- LinkedIn message body: `"...as Amy mentioned..."`

Without resolution, Amy is four nodes. Betweenness centrality is wrong.
Group psychometrics are wrong. Every graph analysis is wrong.

### 7.2 Node Types

A node is any entity that can be a party to a relationship.

```typescript
export type EntityNodeType =
  | "person"    // Individual human
  | "company"   // Corporation, LLC, fund vehicle
  | "group"     // Informal cluster, cohort, circle ("Chicago PE crowd")
  | "fund"      // Investment fund ("Andreessen Bio Fund III")
  | "school"    // Educational institution
  | "event";    // Conference, meetup, dinner ("SaaStr 2026")
```

### 7.3 Edge Types

```typescript
export type EdgeType =
  // Person → Person
  | "knows"           // general relationship
  | "referred"        // A referred B (directional, high value)
  | "co_invested"     // appeared on same cap table
  | "mentioned"       // A mentioned B in a message (soft, directional)
  | "tension"         // detected conflict signal
  | "reports_to"      // org hierarchy
  // Person → Company/Fund
  | "works_at"        // current employment
  | "worked_at"       // former employment
  | "invested_in"     // person invested in company
  | "advises"         // advisory role
  | "founded"         // founder relationship
  // Person → Group/Event
  | "member_of"
  | "attended"
  // Company → Company
  | "acquired"
  | "competes_with"
  | "partners_with"
  | "raised_from"     // company raised from fund
  // Company → Fund
  | "portfolio_of";
```

### 7.4 `EntityCandidate` and `EntityResolver`

```typescript
/**
 * A candidate entity extracted from any source.
 * The resolver attempts to match this to an existing node or creates a new one.
 */
export interface EntityCandidate {
  type: EntityNodeType;
  // Person fields
  name?: string;
  email?: string;
  phone?: string;
  title?: string;
  // Company/Group fields
  companyName?: string;
  domain?: string;
  // Cross-source anchors (highest confidence)
  linkedinUrl?: string;
  crunchbaseUrl?: string;
  // Provenance
  sourceId: string;       // which source emitted this candidate
  sourceRecordId: string; // which record within that source
  confidence: number;     // 0–1, how confident we are this is a real entity
}

/**
 * A resolved entity node in the graph.
 * Stored in ShadowDB memories table (category = entity type).
 */
export interface ResolvedEntity {
  id: number;             // ShadowDB memory record id
  type: EntityNodeType;
  canonicalName: string;
  aliases: string[];      // all known names/handles for this entity
  emails: string[];
  phones: string[];
  linkedinUrl?: string;
  sourceBitmask: number;  // which sources have contributed data (same as dossier bitmask)
}

/**
 * A directed edge between two resolved entities.
 * Stored in ShadowDB as relationship records (metadata graph fields).
 */
export interface EntityEdge {
  fromId: number;         // ResolvedEntity.id
  toId: number;           // ResolvedEntity.id
  type: EdgeType;
  confidence: number;     // 0–1
  sourceId: string;       // which source produced this edge
  evidenceText?: string;  // snippet that supports this edge
  firstSeenAt: Date;
  lastVerifiedAt: Date;
}

/**
 * Entity resolver — finds or creates canonical entity nodes.
 *
 * Resolution priority (highest confidence first):
 *   1. linkedinUrl match        → 100% same entity
 *   2. email match              → 99% same person
 *   3. name + company + title   → 85% same person
 *   4. name + company           → 70% same person
 *   5. name fuzzy only          → 50%, needs corroboration
 *   6. company + domain         → 90% same company
 *   7. company name fuzzy       → 60% same company
 */
export interface EntityResolver {
  /**
   * Find or create a canonical entity node for a candidate.
   * Returns null if confidence is below threshold.
   */
  resolve(candidate: EntityCandidate): Promise<ResolvedEntity | null>;

  /**
   * Merge two independently resolved entities into one canonical node.
   * All edges pointing to either node are repointed to the survivor.
   */
  merge(entityIdA: number, entityIdB: number, confidence: number): Promise<void>;

  /**
   * Register a directed edge between two resolved entities.
   * Idempotent — re-registering same edge updates lastVerifiedAt + confidence.
   */
  addEdge(edge: Omit<EntityEdge, "firstSeenAt" | "lastVerifiedAt">): Promise<void>;
}
```

### 7.5 `EdgeSignal` — Phase 4 Output

LinkedIn profile scraping emits `EdgeSignal[]` alongside `ExtractedContent`.
These are candidate edges that the resolver processes after ingestion.

```typescript
export interface EdgeSignal {
  fromCandidate: EntityCandidate;   // the profile being scraped
  toCandidate: EntityCandidate;     // the entity referenced
  type: EdgeType;
  confidence: number;
  evidenceText?: string;            // "Amy Chen, VP at Acme" → evidence = that sentence
  sourceId: string;
}
```

Cross-source linking example:
```
LinkedIn profile for Joe:
  → EdgeSignal { from: joe, to: "Amy Chen @ Acme", type: "knows", confidence: 0.6 }

EntityResolver.resolve("Amy Chen @ Acme"):
  → checks existing entities
  → finds amy@acme.com in Gmail (name + company match, confidence 0.85)
  → merges → single node: Amy Chen, emails: [amy@acme.com], linkedin: inferred

Result: joe → amy@acme.com edge, cross-source, no manual linking
```

### 7.6 Group Psychometric Profiles

Once individual psychographic profiles exist (Phase 3), groups become
first-class analytical targets.

```typescript
/**
 * Aggregate psychographic profile for a cluster of entities.
 * Computed from individual member profiles + inter-member message analysis.
 */
export interface GroupPsychProfile {
  groupId: number;                    // ResolvedEntity.id (type = "group")
  memberIds: number[];                // constituent entity ids
  computedAt: Date;

  // Aggregate DISC distribution across members
  disc: { D: number; I: number; S: number; C: number };

  // Dominant communication patterns across the group
  dominantLanguage: string[];         // exact phrases the group uses in-group

  // Collective blind spots (topics never raised = group avoidance)
  blindSpots: string[];

  // Collective anxieties (topics raised obliquely, never directly)
  collectiveAnxieties: string[];

  // Status hierarchy — who the group mirrors language from
  dominantVoiceId?: number;           // entity whose language others mirror

  // Decision pattern
  decisionPattern: "consensus" | "single_node" | "fragmented";

  // Effective entry point — person whose language most closely matches group norms
  // i.e. who you should sound like when writing to this group
  entryPointId?: number;
}
```

Marketing/outreach implications:
- `dominantLanguage` → word-for-word vocabulary to use in outreach
- `collectiveAnxieties` → the tension to introduce or resolve
- `entryPointId` → who to contact first (their language = group's language)
- `blindSpots` → what competitors aren't addressing = positioning opportunity
- `decisionPattern` → whether to work the room or find the one decision node

### 7.7 Where This Fits in the Pipeline

```
Phase 4 (LinkedIn profile scrape)
  → parseContactProfile()
  → extractEdgeSignals()          ← new Phase 4 output
  → EntityResolver.resolve()      ← Phase 3b
  → EntityResolver.addEdge()      ← Phase 3b

Phase 3b (Entity Resolution layer)
  → EntityResolver (person + company + group nodes)
  → Cross-source merging (email + LinkedIn + iMessage = same node)
  → Edge registry (all detected relationships with confidence)

Phase 5 (Network Intelligence)
  → computeBetweennessCentrality() — reads resolved edge graph
  → detectClusters()               — reads resolved node pool
  → computeGroupPsychProfile()     — reads individual profiles + message history
  → detectNetworkOpportunities()   — runs 8 plays against resolved graph
  → generateOpportunityBriefing()  — produces actionable output
```

Phase 3b must be complete before Phase 5 — bad entity resolution = wrong graph = wrong analysis.

---

## 8. LinkedIn Submodule Architecture

Three distinct scrape targets, each with different DOM structure and signal value.

### 8.1 Submodules

| Submodule | URL pattern | `operationId` prefix | Signal value |
|-----------|-------------|----------------------|--------------|
| Global message list | `/messaging/` | `linkedin:msglist:<account>` | Low — discovery only |
| Contact message history | `/messaging/thread/<id>/` | `linkedin:thread:<threadId>` | High — behavioral signals |
| Contact profile | `/in/<username>/` | `linkedin:profile:<username>` | High — dossier + edge signals |

### 8.2 Profile Parsing Surface

```typescript
/** Parsed LinkedIn profile page */
export interface LinkedInProfile {
  username: string;         // from URL slug
  url: string;
  fullName: string;
  headline?: string;        // "VP of X at Acme"
  location?: string;
  about?: string;           // bio text
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
  skills: string[];
  mutualConnectionCount?: number;
  sharedConnections: string[];    // names of mutual connections (visible on page)
  recommendations: LinkedInRecommendation[];
  fetchedAt: Date;
}

export interface LinkedInExperience {
  title: string;
  company: string;
  startDate?: string;       // raw text from page ("Jan 2020")
  endDate?: string;         // "Present" or date
  description?: string;
}

export interface LinkedInEducation {
  school: string;
  degree?: string;
  field?: string;
  startYear?: number;
  endYear?: number;
}

export interface LinkedInRecommendation {
  authorName: string;
  authorTitle?: string;
  text: string;
  direction: "received" | "given";
}

// Pure function — no browser needed in tests
export function parseContactProfile(html: string): LinkedInProfile | null;
export function profileToExtractedContent(profile: LinkedInProfile): ExtractedContent | null;
export function extractEdgeSignals(profile: LinkedInProfile, selfName: string): EdgeSignal[];
```

### 8.3 Execution Model

- **Message threads** — `LinkedInFetcher` (already built), OC agent job
- **Contact profiles** — `LinkedInProfileFetcher` (new), same OC agent job, batch per run
- **Both** run as OC agent jobs — browser tool, not `ingest.mjs`
- **Edge signals** emitted during profile ingestion, processed by `EntityResolver`

---

## 9. What This Unlocks

With `TieredLlmClient` + `DataSource<T>`:

- Adding Crunchbase = implement `DataSource<CrunchbaseEntity>`, nothing else changes
- Adding a 128K model = add a `DEEP` tier entry to `LlmRouterConfig`, all DEEP tasks automatically use it
- Running cross-reference analysis = request `DEEP` tier, router handles model selection
- Testing all of it = inject mock implementations of both interfaces, no live API calls

No global state. No hardcoded model names in business logic. No "oops, the
behavior analysis prompt is 35K tokens and the scoring model only has 4K."
