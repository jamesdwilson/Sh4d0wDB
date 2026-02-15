<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img alt="Sh4d0wDB" src="assets/banner-dark.svg" width="100%">
</picture>

<br/>

<h2 align="center">Replace static markdown bloat with a memory plugin for OpenClaw and on-demand retrieval.</h2>
<h3 align="center">Your DB choice. Your embedding provider choice. Your path to effectively unbounded memory.</h3>
<h3 align="center">Easy to install. Zero-risk rollout with automatic backup. Fully reversible.</h3>

[![Install](https://img.shields.io/badge/install-one--command-0ea5e9?style=for-the-badge)](https://raw.githubusercontent.com/openclaw/shadowdb/main/setup.sh)
[![Status](https://img.shields.io/badge/status-production--ready-22c55e?style=for-the-badge)](#-current-status)
[![Memory plugin for OpenClaw](https://img.shields.io/badge/memory%20plugin-for%20OpenClaw-a855f7?style=for-the-badge)](#-what-shadowdb-is)

</div>

---

# ✨ What ShadowDB Is

## ShadowDB is a database-backed memory system for OpenClaw.

### It runs through the **memory plugin slot for OpenClaw** (`memory-shadowdb`) so your agent uses native tools:

- `memory_search`
- `memory_get`

---

# 🚀 Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/shadowdb/main/setup.sh | bash
```

## That setup script:

1. checks prerequisites,
2. backs up your current workspace/config,
3. creates schema,
4. imports memory,
5. verifies retrieval.

---

# 📈 Current Status

## ✅ Production-ready now

- Fast, grounded retrieval from SQL via the memory plugin for OpenClaw (`memory_search` / `memory_get`)
- Deterministic startup hydration from DB via `before_agent_start` hook
- **Model-aware startup injection** — `maxCharsByModel` config maps model name patterns to per-model char budgets so small-context models (ministral-8b, qwen3) get compact P0/P1 essentials while large-context models (Opus, Sonnet) get the full priority stack
- Startup mapping path for legacy identity files (`SOUL.md`, `IDENTITY.md`) through import scripts
- Flexible embedding providers with strict dimension mismatch enforcement

## 🔧 Remaining hardening work (non-blocking)

- Golden parity harness (automated before/after behavior checks)
- Schema migration/versioning scripts

---

# 💡 Why This Exists

## Static markdown injected every turn wastes context and attention.

### ShadowDB moves memory into a real retrieval system so the model gets:
- less repetitive prompt noise,
- better recall,
- better precision,
- and easier scaling.

---

# 🧭 Architecture at a Glance

<details>
<summary><b>Diagram: high-level flow</b></summary>

```mermaid
flowchart LR
    U[User Prompt] --> A[OpenClaw Agent]
    A --> T[memory_search / memory_get]
    T --> P[memory-shadowdb plugin]
    P --> D[(ShadowDB / PostgreSQL)]
    P --> E[Embedding Provider]
    D --> R[Ranked memory results]
    R --> A
```

</details>

<details>
<summary><b>Diagram: query lifecycle</b></summary>

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as OpenClaw Agent
    participant P as memory-shadowdb
    participant E as Embedding Provider
    participant D as PostgreSQL

    U->>A: Ask question
    A->>P: memory_search(query)
    P->>E: embed(query)
    E-->>P: vector
    P->>D: hybrid query (vector + FTS + trigram)
    D-->>P: ranked snippets + citations
    P-->>A: tool result JSON
    A-->>U: grounded reply

    opt Deep read follow-up
      A->>P: memory_get(path)
      P->>D: fetch record
      D-->>P: full content
      P-->>A: text
      A-->>U: detailed answer
    end
```

</details>

<details>
<summary><b>Diagram: core data model</b></summary>

```mermaid
erDiagram
    OPENCLAW_AGENT ||--|| MEMORY_PLUGIN : uses
    MEMORY_PLUGIN ||--o{ STARTUP_RECORD : reads
    MEMORY_PLUGIN ||--o{ MEMORY_RECORD : reads

    STARTUP_RECORD {
      text key PK
      int priority
      bool reinforce
      text content
    }

    MEMORY_RECORD {
      bigint id PK
      text title
      text category
      text content
      vector embedding
      tsvector fts
      bool contradicted
      bigint superseded_by FK
    }
```

</details>

---

# ❓ FAQ

<details>
<summary><b>Wait — what happens when markdown files are empty? Can I delete them?</b></summary>

Short version:
- Empty expected bootstrap files are usually okay.
- Deleting expected files is usually worse (many frameworks emit missing-file markers).

OpenClaw behavior:
- Missing file can inject `[MISSING] Expected at: ...`
- Empty file is typically skipped

Practical recommendation:
- Keep expected files present
- Keep them minimal/empty when not needed
- Let DB retrieval handle memory

</details>

<details>
<summary><b>How will it find <code>SOUL.md</code> / <code>IDENTITY.md</code> if they are not on disk?</b></summary>

By design, runtime memory is read from the DB via plugin tools.

Flow:
1. setup/import ingests bootstrap content into DB records,
2. runtime uses `memory_search` / `memory_get`,
3. plugin reads SQL records (not markdown files on disk).

Important nuance:
- Retrieval works.
- Startup identity/rules front-load now works from DB via plugin hook.
- You can tune hydration behavior with startup mode (`always`, `first-run`, `digest`).

</details>

<details>
<summary><b>Do I need to hand-edit JSON config?</b></summary>

No for most users.

Treat this as a plugin abstraction: install + verify, done.

If you need exact config wiring, use doctor/status tooling or inspect generated config after setup.

</details>

---

# 🧠 Embedding Providers

`memory-shadowdb` supports:

- `ollama`
- `openai`
- `openai-compatible`
- `voyage`
- `gemini`
- `command` (external embedding command)

Dimension checks are enforced so mismatches fail loudly instead of silently degrading.

---

# 🗂️ Included Schemas

- `schema.sql` (PostgreSQL + pgvector + FTS + trigram indexes)
- `schema-sqlite.sql` (SQLite + FTS5 + sync triggers)
- `schema-mysql.sql` (MySQL/MariaDB + FULLTEXT)

---

# 🛡️ Drop-in Contract (Implemented)

## ShadowDB now supports practical drop-in identity + memory behavior using:

1. legacy file ingest mapping (`SOUL.md`/`IDENTITY.md` → startup records),
2. structural startup hydration before runs,
3. native memory tool retrieval from DB,
4. rollback to stock bootstrap behavior when needed.

What remains is **verification depth**, not architectural capability.

---

# 🛠️ Suggested Migration Pattern (Today)

1. Install plugin path and verify `memory_search` returns `provider: "shadowdb"`.
2. Keep minimal bootstrap stubs for identity safety.
3. Move factual memory load to DB.
4. Choose startup hydration mode (`always` for strict parity, `digest` for lower overhead).
5. Optionally configure `maxCharsByModel` for model-aware injection budgets.

### Startup Config Reference

```jsonc
// in openclaw.json → plugins.entries.memory-shadowdb.config
"startup": {
  "enabled": true,
  "mode": "digest",           // "always" | "first-run" | "digest"
  "maxChars": 6000,           // default budget (fallback)
  "cacheTtlMs": 600000,       // digest re-check interval (10min)
  "maxCharsByModel": {        // model substring → char budget
    "opus": 6000,             // large context → full stack
    "sonnet": 5000,
    "mistral-large": 4000,
    "llama-3.3": 3000,
    "ministral-8b": 1500,     // small context → P0 essentials only
    "qwen3": 2000
  }
}
```

Rows are fetched `ORDER BY priority ASC` and concatenated until the budget is hit. Use priority tiers (P0=critical identity, P1=operational rules, P2=behavioral, P3=reference) to control what smaller models see.

---

# ✅ Validation Checklist

- [ ] `memory_search` returns `provider: "shadowdb"`
- [ ] core memories retrieve correctly
- [ ] identity behavior remains stable across restarts/compactions
- [ ] rollback path tested

---

# 🧯 Troubleshooting

## `memory_search` not returning ShadowDB

- run:

```bash
openclaw doctor --non-interactive
```

- verify plugin is loaded and memory slot is wired
- restart gateway after config changes

## Embedding errors

- check provider keys / endpoint
- check embedding dimensions vs DB vector dimensions

## Postgres issues

- confirm connection string/config
- confirm extensions (`vector`, `pg_trgm`) where needed

---

# 🧪 Testing

Plugin tests:

```bash
cd extensions/memory-shadowdb
npm test
```

Current tests cover:
- provider alias normalization,
- provider config resolution,
- startup hydration config defaults/normalization,
- dimension mismatch enforcement.

---

# 🤝 Contributing

If you contribute, please keep docs explicit and state current runtime truth (not aspirational claims).

Priority contribution areas:
- startup hydration test coverage + policy tuning,
- migration/parity harness,
- schema versioning/migrations,
- multi-agent scoped startup records.

---

# 📄 License

MIT
