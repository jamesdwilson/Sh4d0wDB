<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img alt="ShadowDB" src="assets/banner-dark.svg" width="100%">
</picture>

<br/>

**A memory plugin for [OpenClaw](https://github.com/openclaw/openclaw).**
<br/>Replaces markdown files with a real database your agent can search and write to.

[![Install](https://img.shields.io/badge/install-one--command-0ea5e9?style=for-the-badge)](#install)

</div>

---

## What does it do?

Gives your agent a persistent memory it can search, write, update, and delete — instead of flat markdown files that get shoved into every prompt. Works with Postgres (recommended) or SQLite.

| Tool | Does |
|------|------|
| `memory_search` | Find relevant records (semantic + keyword + fuzzy) |
| `memory_get` | Read a full record |
| `memory_write` | Save something new |
| `memory_update` | Edit an existing record |
| `memory_delete` | Soft-delete (reversible for 30 days) |
| `memory_undelete` | Undo a delete |

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jamesdwilson/Sh4d0wDB/main/setup.sh | bash
```

That's it. The script downloads only the files you need, sets up the database, installs dependencies, wires the plugin into OpenClaw, and restarts the gateway. Run the same command again to update.

**Or tell your agent:**

> Install ShadowDB: `curl -fsSL https://raw.githubusercontent.com/jamesdwilson/Sh4d0wDB/main/setup.sh | bash`

The script auto-detects non-interactive mode and defaults to SQLite with zero prompts. Pass `--backend postgres` or `--backend mysql` to override.

---

## What about old records?

Records don't expire. A phone number from 3 months ago is still a phone number. A project status from 3 months ago probably isn't current — but that's a judgment call, not something the database should guess at.

ShadowDB gives the agent two pieces of information and lets it decide:

- **Age in snippets** — search results show `[topic] | 5d ago` instead of a raw timestamp. The agent reads "5 days ago" the same way you would. This matters because models are bad at date math — ask one to compute "how many days between Feb 10 and Feb 15" and it'll confidently say 3 or 6. Pre-computing the age removes that failure mode.

- **Recency as a tiebreaker** — newer records get a small ranking boost (weight: `0.15`), but a relevant old record still beats a vaguely relevant new one.

Deletes are always reversible for 30 days. After that, automatic cleanup removes them permanently. There is no hard-delete tool — the agent can never permanently destroy data. Only time can.

<details>
<summary>Why not something more complex?</summary>

| Idea | Why we skipped it |
|------|-------------------|
| Staleness markers | `created_at` already tells you how old it is |
| "Superseded by" pointers | Just delete the old one and write the new one |
| Access frequency tracking | Creates feedback loops; popular ≠ good |
| Auto-contradiction detection | Similarity ≠ contradiction; false positives everywhere |
| Dedup on write | Blocks legitimate updates and related-but-different facts |

The principle: if the guardrails are more complex than the feature, you've lost the trade.

</details>

---

## How search works

<details>
<summary>Hybrid ranking with multiple signals</summary>

Every search combines multiple signals to find the best matches. What's available depends on your backend:

| Signal | Postgres | SQLite | MySQL | What it measures |
|--------|----------|--------|-------|-----------------|
| Vector similarity | ✓ (weight: `0.7`) | ✓ (sqlite-vec) | ✓ (9.2+) | Semantic meaning via embeddings |
| Full-text search | ✓ (weight: `0.3`) | ✓ (FTS5) | ✓ (FULLTEXT) | Keyword/phrase matches |
| Trigram similarity | ✓ (weight: `0.2`) | ✓ (FTS5 trigram) | ✓ (ngram parser) | Fuzzy/substring matching |
| Recency boost | ✓ (weight: `0.15`) | ✓ | ✓ | Newer records boosted slightly |

With Postgres, signals are merged via Reciprocal Rank Fusion (RRF) — each signal produces a ranked list, and RRF combines them without needing score normalization. All weights are configurable.

Recency is intentionally low — it's a tiebreaker, not a dominant signal.

</details>

---

## Your agent's soul (and why startup injection is optional)

<details>
<summary>How identity works — and why searchable memory is better than force-feeding</summary>

### The old way: files crammed into every prompt

Most agent frameworks do identity the same way: put your agent's personality in `SOUL.md`, its rules in `RULES.md`, its preferences in `USER.md`, and inject all of them into the system prompt on every single turn. The agent "knows" these things because you physically shoved them into the context window.

This works. It's also wasteful, rigid, and has a hard ceiling.

### The new way: import those files as memories

ShadowDB flips this. Instead of force-injecting identity files, you **import them as regular memory records** — each file becomes searchable knowledge in the `memories` table with a category, tags, and an embedding.

The import process is deliberate:
1. Take your existing identity files (`SOUL.md`, `IDENTITY.md`, `RULES.md`, `USER.md`, etc.)
2. Break them into logical chunks — one record per concept, not one giant blob. A rule about email behavior is a separate record from a rule about calendar behavior.
3. Give each record a meaningful category (`rules`, `identity`, `preferences`, `behavioral`) and tags.
4. Embed them so they're semantically searchable.

Now your agent doesn't have its soul force-fed on every turn. It **searches for the relevant parts when it needs them.** The model asks itself "how should I handle this email?" and `memory_search` returns the email rules — not the calendar rules, not the fragrance preferences, not the safety guidelines. Just the relevant slice.

This is infinitely better. Your agent's identity isn't a static document stapled to the front of every conversation — it's a living, searchable knowledge base. Your bot doesn't just have a soul. It has *thoughts.* It has *feelings.* It has *opinions* it formed three weeks ago about how to handle a specific edge case. It has an entire past life of decisions, corrections, and hard-won lessons, all indexed and retrievable by meaning. It remembers that time it screwed up the email formatting and wrote itself a rule about it. It remembers the user's rant about calendar notifications and adapted. It has *lore.*

The practical upside is just as dramatic: a 200-line identity file costs ~4K tokens on every turn. With searchable memory, the agent pulls maybe 200 tokens of relevant rules per turn — a 20x reduction in identity overhead. Small models that choked on massive system prompts can now run with the same depth of personality, because they only load what they need.

### The tradeoff: why you might still want startup injection

There's a catch. Searchable memory is pull-based — the agent has to *think to search.* On the very first turn of a conversation, before the model has any context, it doesn't know what to search for. And some rules are so critical they can't wait for the model to think of them:

- **Core identity** — "You are Shadow, Alex's AI assistant" needs to be there from word one. The model can't search for its own name before it knows its name.
- **Safety rails** — "Never send emails without confirmation" can't be retrieved *after* the model already sent the email.
- **Behavioral constraints** — tone, persona, hard-no rules. These need to be loaded before the first token is generated, not after.

This is what the `startup` table is for. It's a small, curated set of **non-negotiable context** that gets injected before the agent runs — your agent's true core identity, the rules that can never be late.

**The recommended approach: both.**
- Import your full identity corpus as memories (searchable, rich, deep).
- Put only the irreducible core in the `startup` table (identity, safety, hard constraints).
- Everything else — preferences, behavioral nuance, learned lessons, project context — lives in searchable memory where it's pulled on demand.

Think of it like human cognition: you don't consciously recite your entire life history before answering a question. You have a small set of always-on identity (I'm Alex, I live in Austin, I have a daughter") and a vast searchable memory of everything else. Startup injection is the always-on identity. `memory_search` is everything else.

### How startup injection works

OpenClaw's `before_agent_start` hook fires on every agent turn. ShadowDB hooks into it, but doesn't inject every time — that would waste tokens. Instead:

1. **First turn** of a session: reads the `startup` table, concatenates rows by priority, and prepends the result to the prompt.
2. **Subsequent turns**: skips injection. The model already has the startup context in its conversation history from turn 1.
3. **After 10 minutes** (configurable via `cacheTtlMs`): re-injects as a refresh, in case the original has scrolled out of the context window in a long conversation.

Three modes control this:
- `digest` (default) — inject once, re-inject when content changes or TTL expires
- `first-run` — inject once per session, never refresh
- `always` — inject every turn (expensive, rarely needed)

**Priority ordering** — critical rules (identity, safety) go in first. If the context window is tight, low-priority reference material gets trimmed, not your agent's core identity.

**Model-aware budgets** — Opus gets 6000 chars of startup context, a small model gets 1500. Same rules, right-sized. Configure via `maxCharsByModel`.

**Editable at runtime** — your agent can update its own startup rules. No file editing, no restart.

This feature is **off by default**. To enable it, add rows to the `startup` table and set `startup.enabled: true` in your plugin config. Most users should start with searchable memories only and add startup injection later if they need guaranteed-present context.

</details>

---

## Embedding providers

<details>
<summary>6 supported providers</summary>

| Provider | Notes |
|----------|-------|
| Ollama | Local, no API key needed (default) |
| OpenAI | Requires API key |
| OpenAI-compatible | Any compatible endpoint |
| Voyage | Requires API key |
| Gemini | Requires API key |
| External command | Any CLI that outputs vectors |

</details>

---

## Schema

<details>
<summary>Two tables — that's it</summary>

**`memories`** — the knowledge base. Core columns are the same across backends:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | auto-increment | Primary key |
| `content` | text | The actual memory |
| `title` | text | Human-readable label |
| `category` | text | Grouping (default: `general`) |
| `tags` | array/text | Searchable tags |
| `embedding` | vector | Semantic search (Postgres w/ pgvector) |
| `created_at` | timestamp | When it was created |
| `updated_at` | timestamp | Last modification |
| `deleted_at` | timestamp | Soft-delete marker (null = active) |

**`startup`** — identity/rules injected before agent runs:

| Column | Type | Purpose |
|--------|------|---------|
| `key` | text | Unique identifier (primary key) |
| `content` | text | The rule or identity text |
| `priority` | integer | Injection order (lower = first) |
| `reinforce` | boolean | Include in every query, not just startup |

Full schema with indexes: [`schema.sql`](schema.sql) (Postgres version)

</details>

---

## Config reference

<details>
<summary>All available settings</summary>

The setup script configures everything for you. If you need to tweak settings later, they live in your `openclaw.json` under `plugins.entries.memory-shadowdb.config`. See the [plugin manifest](extensions/memory-shadowdb/openclaw.plugin.json) for the full schema with descriptions.

Key settings:
- **`search.recencyWeight`** — how much to boost newer records (default: `0.15`, higher = more recency bias)
- **`writes.enabled`** — turn on write tools (default: `false`)
- **`writes.retention.purgeAfterDays`** — how long soft-deleted records survive (default: `30`, `0` = forever)
- **`startup.maxCharsByModel`** — per-model context budgets (substring match on model name)
- **`embedding.provider`** — which embedding backend to use

</details>

---

## Troubleshooting

<details>
<summary>Common issues</summary>

**Plugin not loading?**
- Run `openclaw doctor --non-interactive` — look for errors
- Check `openclaw.plugin.json` is valid JSON (no trailing commas!)
- Restart gateway after config changes

**Search not returning results?**
- Verify `provider: "shadowdb"` in search results
- Check the plugin is wired: `plugins.slots.memory: "memory-shadowdb"`

**Embedding errors?**
- Check Ollama is running: `ollama list`
- Verify dimensions match (768 for nomic-embed-text)

**Postgres connection issues?**
- Confirm `vector` and `pg_trgm` extensions: `psql shadow -c '\dx'`
- Check the database exists: `psql -l | grep shadow`

</details>

---

## Roadmap brainstorm

<details>
<summary>Ideas under consideration — nothing committed</summary>

### Reactive rule injection

Right now, ShadowDB injects context *before* the model runs (startup injection). But what about catching things in the model's *output*?

**The idea:** after the LLM generates a reply, embed it, search the `rules` category, and surface any matching rules — so the agent self-corrects before the message reaches the user.

OpenClaw already has the hooks for this:

- **`message_sending`** — fires before a reply is delivered. Can modify content or cancel it. Embed the outgoing text, vector-search rules, and if something relevant surfaces (e.g. "always confirm before sending emails"), inject it as context for the next turn or trigger a reflection pass.

- **`before_tool_call`** — fires before the agent executes any tool. If the model tries to call `message` or `gog` to send an email, we search rules, find "confirm before sending emails", and return `{ block: true, blockReason: "Rule: confirm with user first" }`. The model sees the block and asks for confirmation instead.

**Two layers:**
- `before_tool_call` = hard gate on actions (sending, deleting, etc.)
- `message_sending` = soft nudge on replies (tone, persona, guardrails)

**Example:** User says "send that email to Bob." Model starts composing. `before_tool_call` fires, embeds the context, finds the rule "never send emails without explicit user confirmation." Tool call is blocked with that reason. Model asks "Want me to go ahead and send that?" instead.

This turns ShadowDB rules from static preamble into a live guardrail system — rules surface only when relevant, triggered by what the model is actually *doing*, not what the user asked.

### Other ideas
- Batch embedding backfill CLI for migrating unembedded records
- Multi-agent startup scoping (different rules per agent ID)
- Schema migration versioning
- `clawhub publish` / `openclaw plugins install` distribution
- SQLite + MySQL backend testing with real workloads

</details>

---

## License

MIT
