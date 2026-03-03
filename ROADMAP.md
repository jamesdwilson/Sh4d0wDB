# ShadowDB Roadmap

*Last updated: 2026-03-03 — Full audit + rewrite for accuracy*

---

## How to Read This Document

This ROADMAP is the single source of truth for what is built, what is in progress, and what comes next. It is written to be self-sufficient — any agent picking this up mid-stream should be able to orient without reading prior conversation history.

**Working rules (non-negotiable):**
- One task per commit. No batching.
- Commit hash must be posted after every unit of work.
- Update this file whenever sprint status changes.
- Tests must pass before any new feature work begins.
- Run tests: `cd extensions/memory-shadowdb && npm test`
- All 136 tests must remain green at all times. A red test is a blocker.

---

## Repository Layout

```
shadowdb/
├── extensions/
│   └── memory-shadowdb/         ← The OpenClaw plugin (main codebase)
│       ├── index.ts             ← Plugin entry, tool definitions, __test__ exports
│       ├── config.ts            ← Config resolution (connection string, embedding, primer)
│       ├── store.ts             ← Abstract base class: RRF merge, format, write/update logic
│       ├── postgres.ts          ← PostgreSQL backend (primary)
│       ├── sqlite.ts            ← SQLite backend (optional)
│       ├── mysql.ts             ← MySQL backend (optional)
│       ├── embedder.ts          ← Embedding client (Ollama, OpenAI, Voyage, Gemini, command)
│       ├── types.ts             ← Shared TypeScript types
│       ├── filters.ts           ← buildFilterClauses() — search WHERE builder (extracted)
│       ├── list-filters.ts      ← buildListConditions()+buildSortClause() — list WHERE/ORDER builder
│       ├── rrf.ts               ← mergeRRF() — Reciprocal Rank Fusion (extracted)
│       ├── dist/                ← Compiled JS (committed, kept in sync manually)
│       ├── *.test.mjs           ← Unit tests (node:test, no test framework)
│       └── package.json         ← "test": "node --test ./*.test.mjs"
├── ROADMAP.md                   ← This file
├── GRAPH_SPEC.md                ← Full graph intelligence design (entity schema, traversal, affinity)
├── schema.sql                   ← PostgreSQL DDL
├── schema-sqlite.sql
└── schema-mysql.sql
```

---

## Build Notes

**Full `tsc` compile is broken** — optional backends (`mysql2`, `sqlite-vec`) and `openclaw/plugin-sdk` are not installed as dev dependencies. Do not try to run `tsc` without a targeted file list.

**Correct compile pattern** (compile only what you changed):
```bash
cd extensions/memory-shadowdb
npx tsc --moduleResolution NodeNext --module NodeNext --target ES2022 \
  --outDir dist --declaration --skipLibCheck \
  <file1.ts> <file2.ts> ...
```

**Always compile the files you touch, then run tests before committing.**

The `dist/` directory is committed to the repo. It must stay in sync with source.

---

## Database Schema (current — no pending migrations)

The `memories` table has all columns needed for all planned features. No schema changes are required for Sprint 3 or 5.

```sql
CREATE TABLE memories (
  id           BIGSERIAL PRIMARY KEY,
  content      TEXT NOT NULL,
  category     TEXT DEFAULT 'general',
  title        TEXT,
  tags         TEXT[] DEFAULT '{}',
  metadata     JSONB DEFAULT '{}',
  parent_id    BIGINT REFERENCES memories(id) ON DELETE SET NULL,
  priority     INTEGER NOT NULL DEFAULT 5,
  record_type  TEXT,
  embedding    vector(768),
  fts_vector   tsvector,
  deleted_at   TIMESTAMP,
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);
```

**Record types in use:**
| Type | Purpose | Token budget |
|------|---------|-------------|
| `atom` | Single fact or relationship edge | 10-30 tokens |
| `section` | Named child of a document | 100-500 tokens |
| `document` | Full narrative (dossier) | 500-5000 tokens |
| `index` | Manifest of a document's sections | ~50 tokens |
| `fact` | Timestamped simple fact | 5-20 tokens |
| `stub` | Unresolved entity placeholder | 5-50 tokens |

**Priority field (1-10):**
- 10 = critical rules, identity, active deal context
- 7-9 = standing rules, active contact dossiers
- 5 = default
- 1-4 = low-priority reference, archived

---

## v0.3.0 — ✅ COMPLETE (2026-02-12, commit: 60c7674)

Delivered:
- `metadata` JSONB column + GIN index on `memories` table
- `parent_id` + `priority` columns with indexes
- `memory_list` tool — filter by category, tags, record_type, priority, metadata, parent_id, date range
- `memory_assemble` tool — token-budget-aware context assembly with task_type presets
- `memory_search` enhanced — `detail_level` (snippet/section/full/summary), `tags_include`, `tags_any`, `category`, `priority_min/max`, `created_before/after`, `parent_id` filters
- `memory_get` enhanced — `include_children`, `section` (fetch child by metadata.section_name)
- `memory_write` / `memory_update` — `metadata`, `parent_id`, `priority`, `record_type` fields

---

## v0.4.0 — ✅ COMPLETE (2026-03-03)

### Sprint 1: Baseline Test Infrastructure ✅ COMPLETE (2026-03-03, commit: 9a17eaf)

**What was built:**
- Fixed broken test runner (`index.test.mjs` now imports from `dist/`)
- Fixed `tsconfig.json` syntax error (missing comma)
- Extracted pure functions for testability: `mergeRRF` → `rrf.ts`, `buildFilterClauses` → `filters.ts`, `buildListConditions`+`buildSortClause` → `list-filters.ts`, `truncateCleanly` → exported from `store.ts`, `validateContent` → exported from `store.ts`, `formatSnippet`/`formatFullRecord`/`formatSection` → exposed on `MemoryStore`
- Added `resolveMaxCharsForModel` to `__test__` exports

**Test files (136 tests, all passing):**
| File | What it tests |
|------|--------------|
| `index.test.mjs` | normalizeEmbeddingProvider, resolveEmbeddingConfig, validateEmbeddingDimensions, resolvePrimerConfig |
| `store.test.mjs` | sanitizeString, sanitizeTags, formatRelativeAge, constants |
| `truncate.test.mjs` | truncateCleanly — all 5 break levels (section/para/sentence/word/hard) |
| `validate-content.test.mjs` | validateContent — empty, whitespace, non-string, oversize, exact limit |
| `format-snippet.test.mjs` | formatSnippet — header, bare content, truncation |
| `format-full-record.test.mjs` | formatFullRecord — metadata headers, null omission, no truncation |
| `format-section.test.mjs` | formatSection — query match, fallback, size cap, header |
| `filters.test.mjs` | buildFilterClauses — all filter fields, index sequencing |
| `list-filters.test.mjs` | buildListConditions, buildSortClause — incl. SQL injection guard |
| `rrf.test.mjs` | mergeRRF — score accumulation, weights, recency, dedup, threshold |
| `primer-context.test.mjs` | getPrimerContext — empty, unlimited budget, skip-over-budget, metadata |
| `write-validation.test.mjs` | write() — priority clamp, category default, parent_id, path format |
| `update-validation.test.mjs` | update() — not-found, deleted guard, empty patch, priority clamp |
| `assemble.test.mjs` | assemble() — task_type budgets, lesser-budget rule, category filters |
| `embedding-fingerprint.test.mjs` | computeEmbeddingFingerprint — format, determinism, variance |
| `resolve-maxchars.test.mjs` | resolveMaxCharsForModel — default, empty map, substring, case, first-match |
| `resolve-connection.test.mjs` | resolveConnectionString — explicit, SHADOWDB_URL, DATABASE_URL, fallback |
| `load-config.test.mjs` | loadShadowDbConfig — explicit path, missing, invalid JSON, fallback |

---

### Sprint 2: Metadata Filters ✅ COMPLETE (2026-02-12, implemented in v0.3.0)

All filter parameters (`tags_include`, `tags_any`, `category`, `record_type`, `priority_min/max`, `created_after/before`, `parent_id`, `metadata` JSONB containment) are implemented and tested.

GIN index on `metadata` is in `schema.sql`.

**No remaining work in this sprint.**

---

### Sprint 3: Graph Intelligence ✅ COMPLETE (2026-03-03, commit: 1957a43)

**Prerequisite:** Sprint 1 complete ✅

**Full design spec:** `GRAPH_SPEC.md` — read this before implementing anything.

**Context:** The graph layer uses the *existing* `memories` table. No new tables or migrations required. Relationship edges are stored as `record_type=atom`, `category=graph`. Entity documents are `record_type=document`, `category=graph`. The metadata JSONB field carries the structured edge data.

#### What needs to be built

**3a. Relationship edge write convention (no code change needed — just tool usage + documentation)**

Edges are written via `memory_write` with this shape:
```json
{
  "content": "James Wilson knows Reece DeWoody via Tyler civic network. Observed: shared TMM meeting. Confidence: 70.",
  "category": "graph",
  "record_type": "atom",
  "tags": ["entity:james-wilson", "entity:reece-dewoody", "domain:civic", "loc:tyler-tx"],
  "metadata": {
    "entity_a": "james-wilson",
    "entity_a_type": "person",
    "entity_b": "reece-dewoody",
    "entity_b_type": "person",
    "relationship_type": "knows",
    "evidence_type": "observed",
    "confidence": 70,
    "affinity_score": 65,
    "affinity_basis": "Shared civic focus, compatible communication styles",
    "signal_basis": "Co-attended TMM funding meeting 2026-03-03",
    "depth": 1,
    "last_verified": "2026-03-03"
  },
  "priority": 7
}
```

**3b. `memory_graph` tool — new tool in `index.ts`**

Traverses the graph from an entity slug. Returns N-hop neighborhood.

Tool parameters:
```
entity: string          // Entity slug, e.g. "james-wilson"
hops: number            // Default 1. Max 3.
min_confidence: number  // Default 0. Filter edges below threshold.
relationship_type: string  // Optional. Filter to specific type.
```

Implementation steps:
1. Query `memories` WHERE `tags @> ARRAY['entity:{slug}']` AND `category='graph'` AND `record_type='atom'`
2. Extract connected entity slugs from `metadata.entity_a` and `metadata.entity_b` (the one that isn't the queried entity)
3. For each connected entity, look up their document (`record_type='document'`, `category='graph'`, `tags @> ARRAY['entity:{slug}']`)
4. If `hops > 1`, recurse with found entities (up to max hops, track visited to avoid loops)
5. Return: edges array + entity summaries + citations

Add this to `postgres.ts` as a new method, expose via new tool in `index.ts`.

**3c. Unit tests for graph traversal**

Tests live in `extensions/memory-shadowdb/graph.test.mjs`.

Mock `listRecords` (or the underlying pool query) to return controlled edge atoms.
Test:
- `memory_graph` returns direct neighbors for 1 hop
- `memory_graph` returns 2-hop neighbors when hops=2
- Confidence filter excludes low-confidence edges
- Relationship_type filter works
- Avoids infinite loops (circular references)
- Returns empty result for unknown entity

**3d. Commit sequence**
- `feat: graph — buildGraphQuery() extracted to graph-queries.ts`
- `test: graph — X tests passing`
- `feat: graph — memory_graph tool exposed in index.ts`
- `roadmap: Sprint 3 complete`

---

### Sprint 4: Multi-Resolution Retrieval ✅ COMPLETE (2026-02-12, implemented in v0.3.0)

`detail_level` (snippet/section/full/summary) is implemented in `memory_search` and `memory_get`.
`memory_assemble` with token budget and task_type presets is implemented.

**No remaining work in this sprint.**

---

### Sprint 5: Advanced Query Types ✅ COMPLETE (2026-03-03, commit: d03bdcf)

**What was built:**
- `metadata-filters.ts` — `buildMetadataFilters()` — typed comparisons (>, >=, <, <=, =, !=) on metadata JSONB fields
- `filters.ts` — `buildFilterClauses()` now accepts `metadata_filters` param, delegates to `buildMetadataFilters`
- `list-filters.ts` — `buildListConditions()` now accepts `metadata_filters` param
- `types.ts` — `SearchFilters` type extended with `metadata_filters` field
- 13 tests for `buildMetadataFilters`, 4 tests for `buildFilterClauses` integration, 4 tests for `buildListConditions` integration
- All 177 tests passing

**Usage pattern:**
```
// In memory_search or memory_list tool call:
metadata_filters: [
  { field: 'confidence', op: '>', value: 70 },
  { field: 'tier', op: '=', value: 'vip' }
]
```

Generates: `(metadata->>'confidence')::numeric > $3 AND metadata->>'tier' = $4`

---

## v0.5.0 — ✅ COMPLETE (2026-03-03, commit: 569c0ec)

**What was built:**
- `tag-validator.ts` — `validateTags()` — validates tag namespace prefixes
- Valid namespaces: `entity:`, `domain:`, `loc:`, `sector:`, `status:`, `interest:`
- `StoreConfig.validateTags` option — when true, rejects invalid tags on write
- 12 tests for `validateTags()`, 5 tests for write() integration
- All 194 tests passing

**Usage pattern:**
```javascript
// In plugin config:
{ validateTags: true }

// On write, tags are validated:
write({ content: 'test', tags: ['entity:james-wilson', 'bad:value'] })
// → throws: "Invalid tags: Tag \"bad:value\" has unknown namespace \"bad\""
```

---

## v0.6.0 — ✅ COMPLETE (2026-03-03)

**What was built:**
- `conflict-detector.ts` — `detectConflicts()` — finds contradictory edges (knows+tension, allies+rivals)
- `confidence-decay.ts` — `computeDecayFactor()` + `decayConfidence()` — exponential decay based on `last_verified` age
- 17 tests across both modules
- All 212 tests passing

**Conflict detection usage:**
```javascript
const conflicts = detectConflicts(edges);
// [{ entity_a: 'alice', entity_b: 'bob', types: ['knows', 'tension'], edge_ids: [1, 2] }]
```

**Confidence decay usage:**
```javascript
const results = decayConfidence(edges, { halfLifeDays: 30, minConfidence: 10 });
// [{ id: 1, oldConfidence: 80, newConfidence: 40, decayFactor: 0.5 }]
```

---

## v0.7.0 — Tool Exposure + Intelligence Features (BACKLOG)

**Goal:** Wire existing logic to tools + add intelligence features from GRAPH_SPEC.md.

### 7a. Tool Exposure — `memory_conflicts` tool

Wire `detectConflicts()` to a tool that James can call to see contradictory edges.

**Tool parameters:**
```
filters:
  domain: string       // Optional — filter to domain
  min_confidence: number  // Optional — only check edges above threshold
```

**Returns:** Array of conflicts with entity pairs, conflicting types, edge IDs.

**Tests:**
- Tool returns conflicts for stored edges
- Tool respects domain filter
- Tool respects confidence threshold
- Tool returns empty array for no conflicts

**Commit:** `feat: memory_conflicts tool`

---

### 7b. Tool Exposure — `memory_decay_preview` tool

Wire `decayConfidence()` to a preview tool (does NOT auto-apply, just shows what would decay).

**Tool parameters:**
```
half_life_days: number   // Default 30
min_confidence: number   // Default 0
dry_run: boolean         // Default true — just preview
```

**Returns:** Array of edges that would decay, with old/new confidence values.

**Tests:**
- Tool returns decay preview for stale edges
- Tool respects half_life_days
- Tool respects min_confidence floor
- Tool returns empty for recent edges

**Commit:** `feat: memory_decay_preview tool`

---

### 7c. Authority Sensitivity Scoring

From GRAPH_SPEC.md: derive authority sensitivity from psych profile at query time.

**Function:** `computeAuthoritySensitivity(psychProfile)` → score 0-100

**Rules:**
- ISTJ/ESTJ/Analyst → high authority sensitivity (weight intro source heavily)
- ENFP/INFP/Accommodator → low authority sensitivity (deference less important)

**Tests:**
- Returns high score for ISTJ/Analyst
- Returns low score for ENFP/Accommodator
- Returns medium for undefined types
- Handles missing profile gracefully

**Commit:** `feat: authority sensitivity scoring`

---

### 7d. Intro Framing Suggestions

From GRAPH_SPEC.md: use affinity + friction data to suggest how to frame an introduction.

**Function:** `suggestIntroFraming(entity_a, entity_b, edges, psychProfiles)` → framing string

**Rules:**
- High affinity (80+): "Natural fit — lead with shared values"
- Medium affinity (50-79): "Workable — frame as complementary skills"
- Friction risk (20-49): "Caution — acknowledge tension, frame around common goal"
- Avoid (<20): "Not recommended — high friction risk"

**Tests:**
- Returns appropriate framing for each affinity tier
- Incorporates friction_risks from edge metadata
- Uses psych profiles to refine framing
- Handles missing data gracefully

**Commit:** `feat: intro framing suggestions`

---

### 7e. Event-to-Contact Mapping (stretch)

When an event record is written with `category=event`, automatically find and tag related contacts.

**Heuristic:**
- Extract entities from event content
- Query for contacts tagged with those entities
- Add event ID to contact's `related_events` metadata array

**Tests:**
- Event write triggers entity extraction
- Entities matched to contacts
- Contact metadata updated with event reference
- No action if no matching contacts

**Commit:** `feat: event-to-contact auto-mapping`

---

### v0.7.0 Commit Sequence

1. `roadmap: v0.7.0 defined — tool exposure + intelligence features`
2. `test(TDD vision): memory_conflicts tool — X failing tests`
3. `feat: memory_conflicts tool`
4. `test(TDD vision): memory_decay_preview tool — X failing tests`
5. `feat: memory_decay_preview tool`
6. `test(TDD vision): authority sensitivity — X failing tests`
7. `feat: authority sensitivity scoring`
8. `test(TDD vision): intro framing — X failing tests`
9. `feat: intro framing suggestions`
10. `test(TDD vision): event-to-contact — X failing tests`
11. `feat: event-to-contact auto-mapping`
12. `roadmap: v0.7.0 complete`

- **Tag namespace enforcement** — reject writes with tags that don't match a namespace prefix (`entity:`, `domain:`, `loc:`, `sector:`, `status:`, `interest:`)
- **Confidence decay** — scheduled job that lowers confidence on edges where `last_verified` is stale (configurable decay curve)
- **Conflict detection** — flag when two edges for the same entity pair have contradictory `relationship_type`
- **Relationship graph UI** — visual graph viewer (separate project, not in plugin)
- **Event-to-contact mapping automation** — when an event record is written, automatically tag related contacts

---

## Progress Tracking

| Sprint | Status | Commit | Date |
|--------|--------|--------|------|
| v0.3.0 complete | ✅ | 60c7674 | 2026-02-12 |
| Sprint 1: baseline tests | ✅ | 9a17eaf | 2026-03-03 |
| Sprint 1: extended test suite (136 tests) | ✅ | 9a17eaf→latest | 2026-03-03 |
| Sprint 2: metadata filters | ✅ | 60c7674 (part of v0.3.0) | 2026-02-12 |
| Sprint 3: graph intelligence | ✅ | 1957a43 | 2026-03-03 |
| Sprint 4: multi-resolution retrieval | ✅ | 60c7674 (part of v0.3.0) | 2026-02-12 |
| Sprint 5: advanced query types | ✅ | d03bdcf | 2026-03-03 |
| v0.5.0: tag namespace enforcement | ✅ | 569c0ec | 2026-03-03 |
| v0.6.0: conflict detection | ✅ | a2cf409 | 2026-03-03 |
| v0.6.0: confidence decay | ✅ | 99c8e32 | 2026-03-03 |

**Current latest commit:** `99c8e32` (as of 2026-03-03)

---

## Operating Rules (for any agent picking this up)

1. **Read this file first.** Do not infer state from git log alone — ROADMAP is truth.
2. **Run `npm test` before and after every change.** 194 tests must pass. Red = stop.
3. **Compile before committing.** Touched `.ts` files must be recompiled to `dist/` before test run.
4. **One thing per commit.** No "feat: lots of stuff". Split it.
5. **Update this file** when a sprint completes or a task is checked off.
6. **v0.4.0, v0.5.0, v0.6.0 are COMPLETE.** Next work is v0.7.0 (tool exposure + intelligence features).
7. **Do not guess on schema or tool interface decisions.** If anything is ambiguous, stop and flag James (+16783694522).
8. **TDD when possible.** Write failing tests first, then implement.
9. **GRAPH_SPEC.md is the design authority for graph features.** Read it before touching graph code.
