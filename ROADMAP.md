# ShadowDB Roadmap

## v0.3.0 — Multi-Resolution Memory + Structured Metadata

### Problem Statement

ShadowDB currently stores records as monolithic text blobs. Retrieval is all-or-nothing: you either get a search snippet or the full record. This creates three interconnected problems:

1. **Granularity mismatch** — A 2000-token dossier gets pulled when you only need a 200-token psych profile section. Wastes context window.
2. **No structured queries** — Can't filter by typed fields (e.g. "all relationships with confidence > 70"). Tags exist but aren't queryable via the tool interface.
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

Sections link to their parent document via `parent_id`. Atoms link to the section they belong to.

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
include_children: boolean       // Return child records (sections of a document)
```

### New: `memory_list`

Browse records without semantic query. Pure structured filtering.

```
category: string
record_type: string | string[]
tags_include: string[]
tags_any: string[]
metadata: Record<string, any>
parent_id: number
sort: 'created_at' | 'updated_at' | 'priority' | 'title'
sort_order: 'asc' | 'desc'
limit: number                   // default 20, max 100
offset: number
```

Use cases:
- `memory_list(category="graph", tags_any=["person:sheridan"])` - all Sheridan relationships
- `memory_list(category="events", metadata={"relevance_type": "attend"})` - events worth attending
- `memory_list(category="contacts", sort="updated_at", limit=10)` - recently updated dossiers

### New: `memory_assemble`

Token-budget-aware context assembly. The killer feature.

```
query: string                   // What context is needed
token_budget: number            // Max tokens to return
include_categories: string[]    // Limit to specific categories
include_tags: string[]          // Require specific tags
exclude_categories: string[]    // Skip these
prioritize: 'relevance' | 'recency' | 'priority'
```

How it works:
1. Search across all matching records (semantic + filters)
2. Rank by composite score: `semantic * recency_weight * priority * staleness_decay`
3. Fill token budget highest-ranked first
4. For documents, prefer sections over full content (higher info density per token)
5. Return assembled context with source citations

Scoring formula:
```
final_score = (semantic_similarity * semantic_weight)
            + (recency_score * recency_weight)
            + (priority / 10 * priority_weight)
            - (staleness_days * staleness_decay)
```

Weights configurable in plugin config under `search.*Weight`.

---

## Migration Path

### Backward compatibility

- All existing records continue to work unchanged
- `metadata` defaults to `{}`
- `parent_id` defaults to `NULL`
- `priority` defaults to `5`
- `record_type` existing values preserved
- Existing `memory_search` calls work identically (new params optional)
- Existing `memory_get` calls work identically

### Migration script (Postgres)

```sql
-- v0.3.0 migration (idempotent)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES memories(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;

CREATE INDEX IF NOT EXISTS memories_metadata_idx ON memories USING GIN (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS memories_parent_id_idx ON memories(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_priority_idx ON memories(priority);
```

### SQLite equivalent

```sql
ALTER TABLE memories ADD COLUMN metadata TEXT DEFAULT '{}';
ALTER TABLE memories ADD COLUMN parent_id INTEGER REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;
```

### MySQL equivalent

```sql
ALTER TABLE memories ADD COLUMN metadata JSON DEFAULT ('{}');
ALTER TABLE memories ADD COLUMN parent_id BIGINT REFERENCES memories(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN priority INT NOT NULL DEFAULT 5;
```

---

## Use Cases Unlocked

### Relationship Graph
```
memory_write(category="graph", tags=["person:sheridan","person:bell"],
  metadata={"person_a":"sheridan","person_b":"bell","confidence":85,"affinity":78},
  content="Signal: Tyler Chamber, Rotary, community banking overlap.",
  record_type="atom", priority=6)

memory_list(category="graph", tags_any=["person:sheridan"])
-> All Sheridan relationships
```

### Event-Contact Mapping
```
memory_write(category="events",
  tags=["event:tyler-energy-summit","person:sheridan","person:bell"],
  metadata={"event":"Tyler Energy Summit","date":"2026-03-24","relevance_type":"mention"},
  content="Worth mentioning to banking contacts.",
  record_type="atom", priority=5)

memory_list(category="events", metadata={"relevance_type":"attend"})
-> Events to attend
```

### Multi-Resolution Dossier Retrieval
```
// Full dossier as document
memory_write(category="contacts", title="James Sheridan - Full Dossier",
  record_type="document", priority=7, ...)
-> id: 10371

// Psych profile section linked to parent
memory_write(category="contacts", title="Sheridan - Psych Profile",
  record_type="section", parent_id=10371,
  metadata={"section_name":"psych_profile","contact":"sheridan","token_estimate":280},
  content="ISTJ, community-first relationship lender...", priority=7)

// Quick lookup - just the psych profile
memory_get(path="shadowdb/contacts/10371", section="psych_profile")

// Full dossier with all sections
memory_get(path="shadowdb/contacts/10371", include_children=true)
```

### Token-Budget Assembly
```
memory_assemble(
  query="draft outreach email to Sheridan",
  token_budget=2000,
  include_categories=["contacts","graph","events","rules"])
-> Returns: psych profile (280 tok) + graph (150 tok) +
   sig rule (100 tok) + CTA rule (80 tok) + events (60 tok) = 670 tokens
```

---

## Implementation Order

1. Schema migration - add columns, indexes (non-breaking)
2. memory_write / memory_update - accept new fields
3. memory_list - new tool, pure filtering
4. memory_search enhancements - filters, detail_level
5. memory_get enhancements - section, include_children
6. memory_assemble - composite retrieval with token budgeting
7. Scoring formula - weighted composite with configurable weights

---

## Open Questions

- Should `memory_assemble` support a `task_type` parameter that maps to preset token budgets? Or keep it explicit?
- Should `metadata` be validated against a schema per category, or stay freeform JSONB?
- Should `parent_id` support multi-level nesting (document -> section -> atom) or just one level?
- Token estimation: real tokenizer or approximate at 4 chars/token?

---

*Spec drafted: March 2, 2026*
*Origin: Conversation about relationship graphs, event mapping, and context-window scaling*
