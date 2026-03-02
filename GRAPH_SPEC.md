# ShadowDB Graph Intelligence Spec
*Drafted: 2026-03-02 | Origin: James Wilson design session*

---

## The Vision

A living intelligence graph that:
- Tracks people, companies, projects, programs, and deals across all domains
- Stores observed facts and speculative inferences with explicit confidence levels
- Evolves as new signals come in — confirmation, denial, decay
- Surfaces automatically when relevant — no manual lookup required
- Works across domains (M&A, investment, civic, R&D, crypto) without forcing records into one box
- Understands that two people probably know each other, probably don't get along, and probably are aware of each other's projects — without any of that being explicitly disclosed

---

## Architecture

### Record Types

| Type | Purpose | Example |
|------|---------|---------|
| `document` | Full dossier for a person or org | Reece DeWoody full dossier |
| `section` | Named child of a document | psych_profile, linguistic_fingerprint |
| `atom` | Single relationship or fact edge | Bob ↔ Sally tension edge |
| `index` | Manifest of a document's sections | Reece dossier section list |
| `stub` | Unresolved entity placeholder | New ISP from news article, not yet enriched |

---

## Tag Namespace Convention

Four orthogonal namespaces. Records can have tags from all four simultaneously.

| Namespace | Purpose | Examples |
|-----------|---------|---------|
| `domain:` | Subject matter | `domain:ma`, `domain:investment`, `domain:rd`, `domain:civic`, `domain:crypto`, `domain:referral` |
| `loc:` | Geography | `loc:tyler-tx`, `loc:milwaukee-wi`, `loc:dallas-tx`, `loc:national` |
| `sector:` | Industry/topic | `sector:broadband`, `sector:wireless`, `sector:banking`, `sector:cybersecurity`, `sector:cryptocurrency` |
| `entity:` | Who/what is involved | `entity:reece-dewoody`, `entity:etcog`, `entity:tmm-program` |
| `status:` | Time-sensitive state | `status:fundraising`, `status:in-diligence`, `status:unresolved`, `status:closed` |
| `interest:` | Expressed interests | `interest:capital-formation`, `interest:blockchain` |

**Slug rule:** lowercase, hyphenated, no abbreviations except well-known ones.
`east-texas-cog` not `etcog` — unless `etcog` is the canonical public name.
One slug per entity. Defined once. Used everywhere. Non-negotiable.

---

## Person Dossier Structure

Every person gets a parent document + child sections linked via `parent_id`.

```
[document] Full Dossier                    id: XXXX
  ├── [section] psych_profile              parent_id: XXXX
  ├── [section] linguistic_fingerprint     parent_id: XXXX
  ├── [section] response_patterns          parent_id: XXXX
  ├── [section] community_graph            parent_id: XXXX
  └── [section] comms_log                  parent_id: XXXX
```

### psych_profile section

```
MBTI: [type] (confidence: 0-100)
DISC: [type] (confidence: 0-100)
Enneagram: [type] (confidence: 0-100)
Voss type: Analyst | Accommodator | Assertive
Big Five: O[n] C[n] E[n] A[n] N[n]  ← 1-10 scale

Core fear: [plain English]
Core want: [plain English]
Cialdini triggers: [list]

Psych confidence: low | medium | high | verified
  low      = role inference + public data only (<3 interactions)
  medium   = email/text patterns observed (3-10 interactions)
  high     = voice/in-person + extended history (>10 or meeting occurred)
  verified = self-disclosed or third-party confirmed

Last updated: YYYY-MM-DD
Next calibration trigger: [event that should prompt update]
```

### linguistic_fingerprint section

```
Observed phrases:
  - "[exact phrase]" → [what it signals] (observed: YYYY-MM-DD, context: [channel])

Vocabulary patterns:
  - [pattern] → [inference]

Communication style:
  - Formality level: [high/medium/low]
  - Elaboration tendency: [expands/minimal/context-dependent]
  - Deflection patterns: [if any]

Sample size: [n interactions]
Channels observed: [email, text, in-person, etc.]
```

### response_patterns section

```
By channel:
  Email:    avg [X] min (n=[Y], range: [Z-W] min)
  SMS:      avg [X] min (n=[Y])
  Phone:    [pickup rate, callback time]

By topic:
  [topic]: [faster/slower than baseline] — [interpretation]

Velocity signals:
  - [observation] → [DISC/MBTI interpretation]

Sample size: [n] interactions
Last updated: YYYY-MM-DD
```

---

## Relationship Edge Schema

All edges stored as `record_type=atom`, `category=graph`.

```json
{
  "entity_a": "slug-a",
  "entity_a_type": "person | company | project | program | fund | deal",
  "entity_b": "slug-b",
  "entity_b_type": "person | company | project | program | fund | deal",
  "relationship_type": "[freeform slug — see conventions below]",
  "evidence_type": "observed | inferred | speculative",
  "confidence": 0-100,
  "signal_basis": "[human-readable derivation chain]",
  "via": "[slug of intermediary entity, if second-order edge]",
  "depth": 1,
  "affinity_score": 0-100,
  "affinity_basis": "[why these two would/wouldn't work together]",
  "compatibility_notes": "[tactical framing for introductions]",
  "friction_risks": "[specific risks]",
  "intro_framing": "[how to frame an introduction if needed]",
  "derived_by": "model-name | null if observed",
  "confirmed_by": "source | null if unconfirmed",
  "last_verified": "YYYY-MM-DD",
  "expires": "YYYY-MM-DD | null"
}
```

Tags: `["entity:slug-a", "entity:slug-b", "domain:X", "loc:Y", "sector:Z"]`

---

## Relationship Type Conventions

Freeform slugs but follow this vocabulary as default. Extend as needed.

### Person ↔ Person
`knows` | `colleagues` | `civic-peers` | `tension` | `rivals` | `mentor-mentee` | `probable-allies` | `co-investors` | `former-colleagues`

### Person ↔ Project/Program
`champion` | `skeptic` | `applicant` | `awardee` | `advisor` | `probable-aware` | `adjacent` | `domain-expert`

### Person ↔ Company
`employed-by` | `founded` | `advises` | `invested-in` | `board-member` | `former`

### Company ↔ Company
`competitors` | `partners` | `acquirer-target` | `co-invested` | `sector-overlap` | `geographic-overlap`

### Project ↔ Project
`dependent` | `adjacent` | `competing-for-same-funding` | `complementary` | `sub-project`

**Rule:** Use the most specific accurate verb. Describe the evidence, not the conclusion.
`tension` not `enemies`. `probable-aware` not `knows-about`. `sector-overlap` not `related`.

---

## Affinity Scoring

| Score | Label | Meaning |
|-------|-------|---------|
| 80-100 | Natural fit | Compatible psych, shared values, no competition |
| 50-79 | Workable | Different styles, mutual respect likely |
| 20-49 | Friction risk | Personality clash or value divergence likely |
| <20 | Avoid | High probability bad chemistry, competitive, or known tension |

**Affinity basis signals:**
- Same psych type → likely fit boost
- Complementary types (Analyst + Accommodator) → workable
- Two Assertives, same domain → friction risk (-20)
- Shared cause/community → natural fit boost (+15)
- Geographic competitors → friction risk (-15)
- Known ideological divergence → friction risk (-25)
- Authority mismatch (one defers, one doesn't respect deference) → friction (-10)

**Authority sensitivity** — derive from psych profile at query time, never store:
- ISTJ/ESTJ/Analyst → weight intro source heavily
- Accommodator → peer credibility > title
- Assertive → only care about WIIFM

---

## Confidence Scoring for Auto-Generated Edges

| Signal | Confidence floor |
|--------|-----------------|
| Geographic overlap only | 15-25 |
| Sector overlap only | 20-30 |
| Geographic + sector | 35-50 |
| Named in same article (no context) | 55-65 |
| Named together with relationship context | 65-75 |
| Disclosed relationship | 80-95 |
| Self-confirmed | 95-100 |

**Second-order edges** (Bob knows Sally, Sally is on Project X → Bob probably aware of Project X):
- Confidence = confidence(A knows B) × confidence(B on Project) × 0.6
- Minimum threshold to create: 20
- Always flagged `depth: 2`, `via: [intermediary slug]`
- Always `evidence_type: speculative`

**Speculative edge expiry:** 90 days without confirmation → auto-flag for review
**Tension edge expiry:** 180 days — relationships thaw, check before acting

---

## News/Signal Ingestion Pipeline (v0.5.0)

### Step 1 — Trigger
Cron monitors configured sources per domain:
- Civic/Tyler: Tyler Morning Telegraph, Tyler Paper, ETCOG announcements, TX Legislature updates
- Investment: deal flow sources, SEC filings, press releases
- R&D/tech: relevant sector publications
- People: LinkedIn digest emails, Apollo meeting summaries, Gmail

### Step 2 — Entity Extraction
Subagent reads article/email, extracts:
- Named entities: people, companies, programs, projects, amounts, locations, dates
- Resolves against existing slugs
- Creates `stub` records for unresolved entities, tagged `status:unresolved`

### Step 3 — Direct Edge Creation
For each extracted relationship that is explicitly stated:
- Write relationship edge with `evidence_type: observed`, appropriate confidence (65-80)
- Tag with all relevant namespaces

### Step 4 — Speculative Edge Pass
For each new entity, cross-reference existing graph:
- Find all entities with overlapping `loc:`, `sector:`, `domain:` tags
- For each overlap, compute confidence from scoring table above
- Write speculative edges above threshold (minimum: 20)
- Flag `evidence_type: speculative`, `derived_by: [model]`

### Step 5 — Second-Order Pass
For each new edge written:
- Check if either entity has existing edges to other entities
- Compute second-order awareness edges
- Write if confidence ≥ 20, flag `depth: 2`

### Step 6 — Alert
If any new entity or edge touches a `priority: 8+` existing entity → surface to James

---

## Implementation Checklist

### Phase 1 — Schema & Rules (no code changes needed)
- [ ] Update rule #10406 with this full schema (replace current)
- [ ] Write slug registry rule — canonical slug per entity, append-only
- [ ] Write tag namespace convention rule
- [ ] Write relationship_type vocabulary rule
- [ ] Write affinity scoring rule
- [ ] Write confidence scoring rule
- [ ] Write psych_profile section template as a standing rule

### Phase 2 — Dossier Restructure (apply to new dossiers, backfill existing)
- [ ] Split Reece DeWoody dossier into parent + child sections
- [ ] Add linguistic_fingerprint section post Mar 3 meeting
- [ ] Add response_patterns section (email data already exists)
- [ ] Template: every new dossier built with section structure from day one

### Phase 3 — First Graph Records (Tyler network as pilot)
- [ ] Write person↔person edges for known Tyler relationships
- [ ] Write person↔project edges for TMM/broadband players
- [ ] Write speculative edges for probable Tyler relationships
- [ ] Write compatibility records for key intro candidates

### Phase 4 — ShadowDB Plugin (v0.5.0 code changes)
- [ ] `memory_list` — metadata comparison operators (`{"confidence": {">": 70}}`)
- [ ] `memory_graph` — new tool: traverse edges from a given entity, return subgraph
- [ ] `memory_ingest` — new tool: takes raw text, runs entity extraction + edge creation pipeline
- [ ] Second-order inference pass built into `memory_ingest`
- [ ] Confidence decay: `memory_list` can filter by `last_verified` age

### Phase 5 — Ingestion Cron (v0.5.0 infrastructure)
- [ ] Configure source list per domain
- [ ] Cron job: Gmail scan (Apollo summaries, LinkedIn digests, news alerts)
- [ ] Cron job: LinkedIn message auto-intake (messaging-digest-noreply trigger)
- [ ] Alert rule: new edge touching priority 8+ entity → notify James
- [ ] Weekly graph review prompt: surface unconfirmed edges for James to confirm/deny

### Phase 6 — Psych Evolution Loop
- [ ] Post-meeting calibration trigger: after any in-person meeting, update psych_profile + linguistic_fingerprint
- [ ] Response pattern auto-update: every new email/text reply updates response_patterns section
- [ ] Compatibility re-score: when psych_profile updates, re-derive compatibility edges involving that person

---

## Open Questions

1. Should `memory_graph` traversal be depth-limited (e.g., max depth 3) or follow all edges?
2. Stub records for unresolved entities — auto-enrich immediately or queue for batch enrichment?
3. Psych profile sections — one section per person or allow versioned history sections?
4. Source priority weighting — Apollo summary vs. news article vs. direct email for confidence scoring?
5. Should compatibility scores be stored on the relationship edge or as separate records?

---

*This spec governs ShadowDB v0.5.0 and the graph intelligence layer.*
*All schema decisions above supersede rule #10406.*
*Do not write graph records until Phase 1 rules are written and committed.*
