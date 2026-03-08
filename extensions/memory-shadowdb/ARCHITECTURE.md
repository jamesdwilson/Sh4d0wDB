# ShadowDB Intelligence Layer — Architecture Contracts

**Last updated:** 2026-03-07
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

## 7. What This Unlocks

With `TieredLlmClient` + `DataSource<T>`:

- Adding Crunchbase = implement `DataSource<CrunchbaseEntity>`, nothing else changes
- Adding a 128K model = add a `DEEP` tier entry to `LlmRouterConfig`, all DEEP tasks automatically use it
- Running cross-reference analysis = request `DEEP` tier, router handles model selection
- Testing all of it = inject mock implementations of both interfaces, no live API calls

No global state. No hardcoded model names in business logic. No "oops, the
behavior analysis prompt is 35K tokens and the scoring model only has 4K."
