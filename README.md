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

That's it. Your agent uses these like any other tool.

---

## Install

### Option A: Tell your agent to do it

Paste this into your OpenClaw chat:

> Install the ShadowDB memory plugin from https://github.com/jamesdwilson/Sh4d0wDB. It's an OpenClaw memory plugin at `extensions/memory-shadowdb/`. Clone the repo, add it to my config under `plugins.load.paths`, set `plugins.slots.memory` to `memory-shadowdb`, and configure it with Ollama embeddings (nomic-embed-text, 768 dimensions). I need a Postgres database called `shadow` with the pgvector and pg_trgm extensions. Run the schema from `schema.sql`. Enable writes.

### Option B: Do it yourself

```bash
# 1. Clone
git clone https://github.com/jamesdwilson/Sh4d0wDB.git ~/projects/ShadowDB

# 2. Set up Postgres
createdb shadow
psql shadow -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
psql shadow < ~/projects/ShadowDB/schema.sql

# 3. Install dependencies
cd ~/projects/ShadowDB/extensions/memory-shadowdb && npm install

# 4. Add to your OpenClaw config (~/.openclaw/openclaw.json)
```

Add this to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["~/projects/ShadowDB/extensions/memory-shadowdb"]
    },
    "slots": {
      "memory": "memory-shadowdb"
    },
    "entries": {
      "memory-shadowdb": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "ollama",
            "model": "nomic-embed-text",
            "dimensions": 768
          },
          "table": "memories",
          "search": {
            "maxResults": 6,
            "minScore": 0.15,
            "vectorWeight": 0.7,
            "textWeight": 0.3,
            "recencyWeight": 0.15
          },
          "writes": {
            "enabled": true,
            "autoEmbed": true,
            "retention": { "purgeAfterDays": 30 }
          }
        }
      }
    }
  }
}
```

```bash
# 5. Restart OpenClaw
openclaw gateway restart
```

### Verify

```bash
openclaw doctor --non-interactive | grep shadowdb
# Should show: memory-shadowdb: registered (...)
```

Or just ask your agent: *"search memory for test"* — if the result says `provider: "shadowdb"`, you're good.

---

## What about old records?

Records don't expire. A phone number from 3 months ago is still a phone number. A project status from 3 months ago probably isn't current — but that's a judgment call, not something the database should guess at.

ShadowDB gives the agent two pieces of information and lets it decide:

- **Age in snippets** — search results show `[project] | 5d ago` instead of a raw timestamp. The agent reads "5 days ago" the same way you would — no date math required. (Models are notoriously bad at computing "how many days between Feb 10 and Feb 15" — pre-computing the age removes that failure mode entirely.)
- **Recency as a tiebreaker** — newer records get a small ranking boost (default weight: `0.15`), but a highly relevant old record still beats a vaguely relevant new one.

Deletes are always reversible for 30 days. After that, automatic cleanup removes them permanently. There is no hard-delete tool — the agent can never permanently destroy data. Only time can.

<details>
<summary>Why not something more complex?</summary>

We considered and rejected a bunch of fancier approaches:

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

## Config reference

<details>
<summary>Full config with all options</summary>

```jsonc
// openclaw.json → plugins.entries.memory-shadowdb.config
{
  // Postgres table name (default: "memories")
  "table": "memories",

  // Direct connection string (optional — falls back to ~/.shadowdb.json)
  "connectionString": "postgresql://user:pass@localhost:5432/shadow",

  // Embedding provider
  "embedding": {
    "provider": "ollama",          // ollama | openai | openai-compatible | voyage | gemini | command
    "model": "nomic-embed-text",
    "dimensions": 768,
    "ollamaUrl": "http://localhost:11434"
  },

  // Search tuning
  "search": {
    "maxResults": 6,
    "minScore": 0.15,
    "vectorWeight": 0.7,           // semantic similarity weight
    "textWeight": 0.3,             // keyword match weight
    "recencyWeight": 0.15          // newer = slight boost (tiebreaker only)
  },

  // Write operations (disabled by default)
  "writes": {
    "enabled": true,
    "autoEmbed": true,             // auto-generate embeddings on write
    "retention": {
      "purgeAfterDays": 30         // permanently remove soft-deletes after N days (0 = never)
    }
  },

  // Startup identity injection (replaces SOUL.md, IDENTITY.md, etc.)
  "startup": {
    "enabled": true,
    "mode": "digest",              // always | first-run | digest
    "maxChars": 6000,
    "cacheTtlMs": 600000,
    "maxCharsByModel": {           // model substring → char budget (first match wins)
      "opus": 6000,
      "sonnet": 5000,
      "mistral-small": 2500,
      "ministral-8b": 1500
    }
  }
}
```

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

Smaller models get less context via `maxCharsByModel` — substring matching against the model name, first match wins, falls back to `maxChars`.

This replaces `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, etc. Keep empty stubs so OpenClaw doesn't complain, but the content comes from the database.

</details>

---

## Schema

<details>
<summary>Two tables</summary>

**`memories`** — the knowledge base (11 columns, 8 indexes):

```sql
CREATE TABLE memories (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT NOT NULL,
  title       TEXT,
  category    TEXT DEFAULT 'general',
  record_type TEXT DEFAULT 'fact',
  tags        TEXT[],
  embedding   VECTOR(768),
  fts         TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || content)) STORED,
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

## Embedding providers

<details>
<summary>6 supported providers</summary>

| Provider | Config key | Notes |
|----------|-----------|-------|
| Ollama | `ollama` | Local, no API key needed |
| OpenAI | `openai` | Requires API key |
| OpenAI-compatible | `openai-compatible` | Any compatible endpoint |
| Voyage | `voyage` | Requires API key |
| Gemini | `gemini` | Requires API key |
| External command | `command` | Any CLI that outputs vectors |

Dimension mismatches between provider and DB column are caught on startup.

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
- Check the plugin is wired to the memory slot

**Embedding errors?**
- Check provider is running (Ollama: `ollama list`)
- Verify dimensions match DB column (768 for nomic-embed-text)

**Postgres connection issues?**
- Confirm `vector` and `pg_trgm` extensions installed
- Check connection string or `~/.shadowdb.json`

</details>

---

## Roadmap

- [ ] Batch embedding backfill CLI
- [ ] Schema migration versioning
- [ ] Multi-agent startup scoping
- [ ] `clawhub` / `openclaw plugins install` support

---

## License

MIT
