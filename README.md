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

Gives your agent a Postgres-backed memory it can search, write, update, and delete — instead of flat markdown files that get shoved into every prompt.

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

### Quick start

```bash
git clone https://github.com/jamesdwilson/Sh4d0wDB.git ~/projects/ShadowDB
cd ~/projects/ShadowDB && ./setup.sh
```

The script walks you through everything — database, schema, importing your existing memory files, wiring the plugin. It backs up your files first and you can undo the whole thing with one command.

### Or tell your agent to do it

Paste this into your OpenClaw chat:

> Install the ShadowDB memory plugin. Clone https://github.com/jamesdwilson/Sh4d0wDB to ~/projects/ShadowDB, then run `./setup.sh` and follow the output. After that, wire it into my OpenClaw config: add the plugin path to `plugins.load.paths`, set `plugins.slots.memory` to `memory-shadowdb`, and add an entry under `plugins.entries.memory-shadowdb` with Ollama embeddings (nomic-embed-text, 768 dims), writes enabled, and recencyWeight 0.15. Use `config.patch` to apply it and restart the gateway.

### Verify

Ask your agent *"search memory for test"* — if the result says `provider: "shadowdb"`, you're set.

Or from the terminal:

```bash
openclaw doctor --non-interactive | grep shadowdb
```

---

## What about old records?

Records don't expire. A phone number from 3 months ago is still a phone number. A project status from 3 months ago probably isn't current — but that's a judgment call, not something the database should guess at.

ShadowDB gives the agent two pieces of information and lets it decide:

- **Age in snippets** — search results show `[project] | 5d ago` instead of a raw timestamp. The agent reads "5 days ago" the same way you would. This matters because models are bad at date math — ask one to compute "how many days between Feb 10 and Feb 15" and it'll confidently say 3 or 6. Pre-computing the age removes that failure mode.

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
<summary>Four signals, merged via Reciprocal Rank Fusion</summary>

| Signal | Default weight | What it measures |
|--------|---------------|-----------------|
| Vector similarity | `0.7` | Semantic meaning (embeddings) |
| Full-text search | `0.3` | Keyword/phrase matches |
| Trigram similarity | `0.2` (fixed) | Fuzzy/typo-tolerant matching |
| Recency | `0.15` | Newer records boosted slightly |

All weights are configurable. Recency is intentionally low — it's a tiebreaker, not a dominant signal.

</details>

---

## Startup injection

<details>
<summary>Replace your .md bootstrap files with DB-driven identity</summary>

ShadowDB can inject identity and rules from a `startup` table before each agent run. Records are prioritized (P0 = critical, P3 = reference) and concatenated until a character budget is hit.

Smaller models get less context via `maxCharsByModel` — substring matching against the model name, first match wins.

This replaces `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, etc. Keep empty stubs so OpenClaw doesn't complain, but the content comes from the database.

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

**`memories`** — the knowledge base:

```sql
CREATE TABLE memories (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT NOT NULL,
  title       TEXT,
  category    TEXT DEFAULT 'general',
  record_type TEXT DEFAULT 'fact',
  tags        TEXT[],
  embedding   VECTOR(768),
  fts         TSVECTOR GENERATED ALWAYS AS (...) STORED,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
```

**`startup`** — identity/rules injected before agent runs:

```sql
CREATE TABLE startup (
  key        TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  priority   INTEGER DEFAULT 50,
  reinforce  BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

Full schema with indexes: [`schema.sql`](schema.sql)

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

</details>

---

## License

MIT
