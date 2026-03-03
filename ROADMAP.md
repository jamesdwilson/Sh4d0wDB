# ShadowDB Roadmap

## v0.3.0 — Multi-Resolution Memory + Structured Metadata

### Problem Statement

ShadowDB currently stores records as monolithic text blobs. Retrieval is all-or-nothing: you either get a search snippet or a full record. This creates three interconnected problems:

1. **Granularity mismatch** — A 2000-token dossier gets pulled when you only need a 200-token psych profile section. Wastes context window.
2. **No structured queries** — Can't filter by typed fields (e.g. "all relationships with confidence > 70"). Tags exist but aren't queryable via tool interface.
3. **No relational linking** — Records can't reference each other. A relationship between Person A and Person B has no first-class representation.

These block practical use cases like relationship graphs, event-contact mapping, token-budget-aware retrieval, and cross-record assembly.

### Design Principles

- **Stay within the plugin abstraction** — no raw SQL tools. Everything goes through memory_* tools.
- **Store raw signals, derive inferences at query time** — don't denormalize what an LLM can derive from a psych profile.
- **Multi-resolution by default** — same data, right-sized for the current task.
- **Backward compatible** — existing records continue to work. New fields are optional.

---

## Schema Changes

### New columns on `memories` table

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES memories(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;

CREATE INDEX IF NOT EXISTS memories_metadata_idx ON memories USING GIN (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS memories_parent_id_idx ON memories(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_priority_idx ON memories(priority);
```

### Record types

| Type | Purpose | Token budget | Example |
|------|---------|-------------|---------|
| `atom` | Single durable fact | 10-30 tokens | "Sheridan graduated Lee High School" |
| `section` | Named coherent chunk | 100-500 tokens | "Sheridan psych profile: ISTJ, community-first..." |
| `document` | Full narrative record | 500-5000 tokens | Complete dossier |
| `index` | Manifest of child sections | ~50 tokens | "Sheridan dossier sections: psych_profile, community_graph, comms_history..." |
| `fact` | Simple factual statement | 5-20 tokens | "Meeting happened on 2026-03-03" |

Sections link to their parent document via `parent_id`. Atoms link to section they belong to.

### Metadata field (JSONB)

Typed, queryable key-value pairs. Not free text. Examples:

```json
// Relationship record
{
  "person_a": "sheridan",
  "person_b": "bell",
  "confidence": 85,
  "affinity": 78,
  "tier": "probable"
}

// Event-contact mapping
{
  "event": "Tyler Energy Summit",
  "date": "2026-03-24",
  "relevance_type": "mention",
  "signal_value": "community banking presence"
}

// Dossier section
{
  "section_name": "psych_profile",
  "contact": "sheridan",
  "token_estimate": 280
}
```

### Priority field

Integer 1-10. Used in retrieval ranking alongside semantic score and recency.

- 10 = critical rules, identity, active deal context
- 7-9 = standing rules, active contact dossiers
- 5 = default (general knowledge)
- 1-4 = low-priority reference, archived context

---

## Tool Changes

### Enhanced: `memory_write`

New optional parameters:

```
metadata: Record<string, any>  // JSONB - structured, queryable
parent_id: number              // Links to parent record
priority: number               // 1-10, default 5
record_type: string            // 'atom' | 'section' | 'document' | 'index' | 'fact'
```

### Enhanced: `memory_update`

Same new fields available for partial update.

### Enhanced: `memory_search`

New optional parameters:

```
filters:
  category: string
  record_type: string | string[]
  tags_include: string[]        // Record must have ALL of these tags
  tags_any: string[]            // Record must have ANY of these tags
  metadata: Record<string, any> // JSON path filters (exact match, comparison)
  priority_min: number
  priority_max: number
  created_after: string         // ISO date
  created_before: string
  parent_id: number

detail_level: 'summary' | 'snippet' | 'section' | 'full'
max_tokens: number              // Token budget hint
```

Detail levels:
- `summary` - title + category + tags + metadata only (~10 tokens per result)
- `snippet` - current behavior, relevant excerpt (~50-100 tokens per result)
- `section` - full content of matching sections only (~200-500 tokens per result)
- `full` - complete record content (current behavior)

### Enhanced: `memory_get`

New optional parameters:

```
section: string                 // Retrieve named section by metadata.section_name
detail_level: 'summary' | 'full'

[... rest of file unchanged ...]

---

## ⚠️ UPDATED MARCH 3, 2026 — NEW DEVELOPMENT APPROACH

### Root Cause Analysis

The Phase 2 execution gap (Feb 12 - Mar 3) occurred because:
1. **Ambiguous task handoff** — "continue upgrades" could mean many things
2. **Passive response pattern** — "I'm ready for your direction" instead of proposing concrete next steps
3. **No scope boundaries** — ROADMAP had large design docs but no clear bite-sized implementation slices
4. **No progress tracking** — No way to see what was actually done vs. what remained

### New Approach — Imperfect Baseline + Incremental Unit Tests

**Core Principle**: Make progress visible through frequent commits. Ship imperfect work quickly, improve iteratively.

**Priority Order**:
1. ✅ **Impeccable baseline tests** — Before anything else
2. ✅ **Most important unit tests first** — Before edge cases
3. ✅ **One implementation at a time** — No batching
4. ✅ **Frequent git commits** — Track state in ROADMAP
5. ✅ **Pause all other dev work** — Until baseline tests pass

**Definition of "Done"**:
- Baseline tests: All core CRUD operations work end-to-end
- Commit posted: New hash visible on reminder check

**Blocking Rule**: Do not proceed with schema changes, metadata filters, or new features until baseline tests are impeccable (all CRUD operations passing end-to-end with unit test coverage).

---

## v0.4.0 — Execution Plan (Active Sprint)

### Sprint 1: Baseline Tests (NOW STARTING)

**Status**: 🔴 IN PROGRESS
**Started**: 2026-03-03

**Tasks**:
- [ ] Write `test/unit/memory-baseline.ts` — core CRUD smoke test
- [ ] Write `test/unit/test-helpers.ts` — fixture setup, assertion helpers
- [ ] Run baseline tests locally
- [ ] Fix any failing tests
- [ ] Commit: "feat: add unit test infrastructure (baseline tests passing)"
- [ ] Update ROADMAP: mark baseline tests ✅

**Next**: Unit tests for metadata filters (tags_include, tags_any)

### Sprint 2: Metadata Filters (BLOCKED until Sprint 1 complete)

**Tasks**:
- [ ] Implement memory_search filter parameters
- [ ] Implement GIN index usage
- [ ] Add unit tests for filter logic
- [ ] Commit each filter as separate PR
- [ ] Update ROADMAP: mark metadata filters ✅

### Sprint 3: Graph Intelligence (BLOCKED until Sprint 2 complete)

**Tasks**:
- [ ] Implement relationship edge schema
- [ ] Write graph traversal queries
- [ ] Add unit tests for graph operations
- [ ] Commit as separate PR
- [ ] Update ROADMAP: mark graph layer ✅

### Sprint 4: Multi-Resolution Retrieval (BLOCKED until Sprint 3 complete)

**Tasks**:
- [ ] Implement detail_level parameter
- [ ] Add token budget awareness
- [ ] Add unit tests for resolution logic
- [ ] Commit as separate PR
- [ ] Update ROADMAP: mark multi-resolution ✅

### Sprint 5: Advanced Query Types (BLOCKED until Sprint 4 complete)

**Tasks**:
- [ ] Implement typed query interface
- [ ] Add unit tests for query system
- [ ] Commit as separate PR
- [ ] Update ROADMAP: mark advanced queries ✅

---

## v0.5.0 — Future Features (BACKLOG)

- Tag namespace enforcement (prevent slug collisions)
- Relationship graph UI
- Event-to-contact mapping automation
- Conflict detection and decay
- Confidence calibration based on verification history

---

## Progress Tracking

| Version | Date | Status | Commit |
|---------|------|--------|--------|
| v0.3.0 | Feb 12, 2026 | 60c7674 feat: v0.3.0 complete — task_type presets, metadata sort, detail_level section |
| v0.4.0 | Mar 3, 2026 | **IN PROGRESS** — Sprint 1: Baseline Tests |

---

## Notes

**Key Learning**:
- Ambiguous handoffs + passive responses = stalled work
- Frequent commits > perfect design documents
- Baseline tests first = confidence before building new features
- One feature/test per commit = clear progress signal

**Open Questions**:
- [RESOLVED] Should we build GraphQL layer? — No, SQL + GIN is sufficient for current needs
- [RESOLVED] Should we migrate to another DB? — No, PostgreSQL is target
- What test priority order? — Core CRUD first, then filters, then graph

---

*Last updated: March 3, 2026 — New development approach: Imperfect Baseline + Incremental Unit Tests*
