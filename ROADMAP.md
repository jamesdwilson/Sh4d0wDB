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

## v0.4.0 — IN PROGRESS (started 2026-03-03)

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

### Sprint 3: Graph Intelligence 🔴 NOT STARTED — NEXT SPRINT

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

### Sprint 5: Advanced Query Types 🔴 NOT STARTED — AFTER SPRINT 3

**Prerequisite:** Sprint 3 complete

**What this means (best current understanding):**

A structured query interface that lets agents filter records using typed comparisons against metadata fields — not just JSONB containment.

Current state: `metadata @> '{"confidence": 70}'` only does exact match.
Goal: `metadata.confidence > 70`, `metadata.last_verified < '2026-01-01'`, `metadata.tier = 'vip'`.

**Implementation plan (draft — refine before starting):**

5a. Extend `buildFilterClauses` and `buildListConditions` to accept typed comparisons:
```
metadata_filters: Array<{
  field: string,          // e.g. "confidence"
  op: "=" | ">" | "<" | ">=" | "<=" | "!=",
  value: string | number | boolean
}>
```

5b. Generate safe parameterized SQL: `(metadata->>'confidence')::numeric > $N`

5c. Expose via `memory_search` and `memory_list` tool parameters.

5d. Unit tests: each operator, numeric cast, string comparison, injection guard on field names.

5e. Commit sequence: one operator at a time, one commit per operator.

---

## v0.5.0 — BACKLOG (do not start until v0.4.0 is complete)

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
| Sprint 3: graph intelligence | 🔴 not started | — | — |
| Sprint 4: multi-resolution retrieval | ✅ | 60c7674 (part of v0.3.0) | 2026-02-12 |
| Sprint 5: advanced query types | 🔴 not started | — | — |

**Current latest commit:** `9a17eaf` (as of 2026-03-03 morning)

---

## Operating Rules (for any agent picking this up)

1. **Read this file first.** Do not infer state from git log alone — ROADMAP is truth.
2. **Run `npm test` before and after every change.** 136 tests must pass. Red = stop.
3. **Compile before committing.** Touched `.ts` files must be recompiled to `dist/` before test run.
4. **One thing per commit.** No "feat: lots of stuff". Split it.
5. **Update this file** when a sprint completes or a task is checked off.
6. **Sprint 3 is next.** Start with `3b` (graph query extraction), not `3a` (that's just a usage convention).
7. **Do not start Sprint 5 until Sprint 3 is complete and marked here.**
8. **Do not touch v0.5.0 backlog items** until v0.4.0 is fully done.
9. **GRAPH_SPEC.md is the design authority for Sprint 3.** Read it fully before writing any graph code.
10. **If anything is ambiguous, stop and flag James** (+16783694522). Do not guess on schema or tool interface decisions.
