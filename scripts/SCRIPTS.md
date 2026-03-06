# ShadowDB Operational Scripts

Helper scripts for monitoring, maintaining, and verifying a ShadowDB PostgreSQL deployment.

---

## Configuration

All scripts use environment variables — no hardcoded paths, users, or credentials.

| Variable | Default | Description |
|---|---|---|
| `SHADOWDB_NAME` | `shadow` | PostgreSQL database name |
| `SHADOWDB_HOST` | `localhost` | Database host |
| `SHADOWDB_PORT` | `5432` | Database port |
| `SHADOWDB_USER` | `$USER` | Database user |
| `SHADOWDB_WORKSPACE` | `~/.openclaw/workspace` | Directory for baseline, report, and graph files |
| `SHADOWDB_BACKUP_DIR` | `~/backups/postgres` | Backup directory (integrity suite) |

---

## db-health-check.py

Daily health check comparing current DB state against a known-good baseline.

**Usage:**
```bash
python3 scripts/db-health-check.py --baseline   # Snapshot current state as baseline
python3 scripts/db-health-check.py --check      # Verbose comparison (exits 1 on issues)
python3 scripts/db-health-check.py --cron       # Silent mode for cron (exits 1 on critical failure)
```

**What it checks:**
- Database connectivity
- Total records vs baseline (data loss detection)
- Contacts count vs baseline
- Contact graph size vs baseline
- Recent activity (24h warning if zero)

**Baseline file:** `$SHADOWDB_WORKSPACE/db-baseline.json`

**Cron (daily at noon):**
```
0 12 * * * SHADOWDB_USER=myuser python3 /path/to/scripts/db-health-check.py --cron
```

---

## db-integrity-suite.py

Weekly industry-standard PostgreSQL integrity test suite.

**Usage:**
```bash
python3 scripts/db-integrity-suite.py --all         # Full suite (recommended)
python3 scripts/db-integrity-suite.py --checksums   # Data checksum status
python3 scripts/db-integrity-suite.py --amcheck     # Index/table consistency
python3 scripts/db-integrity-suite.py --baseline    # Baseline comparison only
python3 scripts/db-integrity-suite.py --report      # Print last report JSON
```

**Tests:**
1. **Data checksums** — verifies `data_checksums = on` in PostgreSQL (detects silent corruption)
2. **pg_amcheck** — index and table consistency (requires PostgreSQL 14+ and `CREATE EXTENSION amcheck`)
3. **Baseline comparison** — data loss detection vs baseline file

**On failure:** emits an OpenClaw system event via `openclaw system event` (no direct channel dependency).

**Report file:** `$SHADOWDB_WORKSPACE/db-integrity-report.json`

**Cron (weekly Sunday 6 AM):**
```
0 6 * * 0 SHADOWDB_USER=myuser python3 /path/to/scripts/db-integrity-suite.py --all
```

**Recommended setup:**
```sql
-- Enable checksums (requires DB restart, run once)
-- pg_checksums --enable -D /path/to/pgdata

-- Install amcheck extension
CREATE EXTENSION amcheck;
```

---

## Other Scripts

| Script | Purpose |
|---|---|
| `contact-import.py` | Import contacts from contact-graph.json into ShadowDB |
| `hybrid-search.py` | Direct hybrid vector + FTS search against the DB |
| `memory_decay.py` | Decay confidence scores on stale relationship edges |
| `stale-sweep.py` | Sweep and flag stale/outdated records |
| `detect-dupe-text.py` | Detect near-duplicate content in the memories table |
| `export-contacts.py` | Export contact records from DB |
| `sync-network-to-db.py` | Sync external network data into DB |

---

## Running Tests

All unit tests are hermetic — no live DB or real filesystem access required.

```bash
# From repo root
python3 -m unittest scripts.test_db_health_check -v
python3 -m unittest scripts.test_db_integrity_suite -v

# Both at once
python3 -m unittest scripts.test_db_health_check scripts.test_db_integrity_suite -v
```

**Coverage:**
- `test_db_health_check.py` — 18 tests covering `get_db_stats`, `create_baseline`, `check_health`, `main` (all branches)
- `test_db_integrity_suite.py` — 26 tests covering `run_sql`, `test_checksums_enabled`, `test_pg_amcheck`, `test_baseline_comparison`, `_send_alert`, `run_all`, `main`

All subprocess calls and filesystem operations are mocked via `unittest.mock`.
