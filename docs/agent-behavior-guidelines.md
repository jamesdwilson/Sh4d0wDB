# ShadowDB Agent Behavior Guidelines

Rules for ShadowDB agents (including OpenClaw plugins) regarding how to interact with the knowledge base.

## Memory Update Efficiency

**Rule:** For minor, single-fact updates (e.g., health status, brief status changes), do NOT create new memory records. Instead, either:
- Update the main existing record with a relevant section (e.g., "Personal Context")
- Append inline to the existing record's content

**Rationale:** Creating separate records for each minor update bloats the database with low-value facts. Most minor updates can reasonably be incorporated into an existing record (contact notes, project status, etc.) without losing granularity.

**Enforcement:** Before creating any new record, ask whether it could reasonably be incorporated into an existing record (contact notes, project status, etc.) or whether the new record is genuinely standalone with new dimension/value.

**Threshold:** A new record is justified when:
- The update represents a discrete fact that doesn't fit cleanly into existing sections
- Multiple related updates need to be tracked together
- The update establishes a new relationship or entity
- The update is significant enough that future search queries would specifically target it

## Record Granularity

- Prefer focused, one-dimensional records (one clear topic per record)
- Avoid composite records that mix multiple unrelated facts
- When a topic naturally spans multiple dimensions, use sections or subrecords rather than a monolithic entry

## Search vs. Read

- Use `memory_search` for discovery (what's relevant?)
- Use `memory_get` to pull full content after you know what you need
- Don't pull entire records when only snippets are relevant — search results are enough for most queries

## Query Strategies

- Be specific in search queries — phrase "health update" vs. "Beth Womack flu recovery"
- Use category filters when you know the domain (e.g., `category: rules`, `category: contacts`)
- Leverage tags for multi-dimensional search

## Privacy and Sensitivity

- When writing records about people, be explicit about what's shared
- Mark sensitive information with appropriate tags (e.g., `["private", "health"]`)
- Respect opt-outs and disclosure preferences

## Evidence and Verification

- When writing relationship records or sensitive claims, include evidence/source metadata
- Tag with confidence level where applicable (e.g., `["high-confidence", "confirmed"]`)
- Update records when new evidence surfaces (verification flow)
