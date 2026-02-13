#!/usr/bin/env python3
"""
m — ShadowDB Memory Search & Operations CLI
=============================================

This is the LITERATE version — every function, every line is documented.
The production version (`m`) is identical in behavior but minified for speed.


WHAT THIS SCRIPT DOES:

    Your AI agent's entire configuration is 11 bytes:

        DB: m query

    The agent reads that, runs `m`, and gets its identity + knowledge from
    a database. Zero static files. Zero per-turn waste.

    This script is the `m` command. It does two things:

        1. SEARCH:  Find knowledge by keyword + meaning (hybrid search)
        2. OPERATE: Save records, check loops, manage session state


SUBCOMMANDS:

    m "query"                          Search the knowledge base
    m save "title" "content"           Save a new record
    m loops                            Show open loops / nags / deadlines
    m state [key] [value]              Read or write session state
    m people [name]                    Lookup contacts
    m handoff "focus" ["drafts"]       Write session handoff state
    m d                                Daily dashboard (state + loops + recent)


BACKEND RESOLUTION:

    The script figures out which database to use automatically:

        1. --backend flag              (explicit override)
        2. SHADOWDB_BACKEND env var    (per-session config)
        3. ~/.shadowdb.json config     (persistent preference)
        4. Auto-detect                 (try postgres, then sqlite)

    Works best with PostgreSQL (hybrid keyword + semantic search).
    SQLite and MySQL work great too — just keyword search by default.


SEARCH PIPELINE:

    query
      ↓
    ┌─────────────────────────────────────────────────┐
    │  Keyword search         Semantic search          │
    │  (FTS / FULLTEXT)       (vector embeddings)      │
    │  top 50 matches         top 50 matches           │
    └─────────────────────────────────────────────────┘
      ↓                            ↓
    Reciprocal Rank Fusion (k=60)
      ↓
    top N results (default 5)

    Semantic search requires an embedding model (Ollama suggested).
    If unavailable, keyword search still runs — graceful degradation.


ZERO DEPENDENCIES:

    This script uses only Python stdlib + your database's CLI tool.
    No pip install, no virtualenv, no setup.py. Just Python and a database.


CONFIG FILE (~/.shadowdb.json):

    {
        "backend": "postgres",
        "postgres": {
            "psql_path": "/opt/homebrew/opt/postgresql@17/bin/psql",
            "database": "shadow",
            "embedding_url": "http://localhost:11434/api/embeddings",
            "embedding_model": "nomic-embed-text"
        }
    }


SEE ALSO:

    m                   — Production version (minified, same behavior)
    backends/           — Database adapters (postgres, sqlite, mysql)
    quickstart.sh       — One-command setup
    README.md           — Full documentation + architecture
"""

import argparse
import json
import os
import sys
import subprocess


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                           CONFIGURATION                                    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

CONFIG_PATH = os.path.expanduser("~/.shadowdb.json")

# Default embedding service — Ollama with nomic-embed-text.
# Override in ~/.shadowdb.json per-backend if you use a different provider.
DEFAULT_EMBEDDING_URL = "http://localhost:11434/api/embeddings"
DEFAULT_EMBEDDING_MODEL = "nomic-embed-text"


def load_config():
    """
    Load settings from ~/.shadowdb.json.

    Returns an empty dict if the file doesn't exist. This is intentional —
    missing config means "use defaults and auto-detect." A new user who
    just ran quickstart.sh should be able to type `m "test"` immediately.
    """
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                         BACKEND RESOLUTION                                 ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
#   Four-step chain to determine which database to use:
#
#     1. --backend flag          (highest priority — explicit user choice)
#     2. SHADOWDB_BACKEND env    (useful for per-agent config)
#     3. ~/.shadowdb.json        (persistent preference)
#     4. Auto-detect             (try available databases in order)


def get_backend_name():
    """
    Determine which backend to use (returns a string like "postgres" or "sqlite").

    Checks: env var → config file → auto-detect.
    """
    config = load_config()

    # Env var or config
    name = os.environ.get("SHADOWDB_BACKEND") or config.get("backend")

    # Auto-detect: try postgres first, then check for sqlite file
    if not name:
        name = _auto_detect(config)

    return (name or "sqlite").lower().strip()


def _auto_detect(config):
    """
    Auto-detect which database is available.

    Tries PostgreSQL first (if psql is on PATH and can connect),
    then checks for an existing SQLite file, then defaults to SQLite.
    """
    # Try PostgreSQL
    psql_path = config.get("postgres", {}).get("psql_path", "psql")
    database = config.get("postgres", {}).get("database", "shadow")
    try:
        result = subprocess.run(
            [psql_path, database, "-t", "-A", "-c", "SELECT 1;"],
            capture_output=True, text=True, timeout=3,
        )
        if result.returncode == 0:
            return "postgres"
    except Exception:
        pass

    # Check for SQLite file
    sqlite_path = config.get("sqlite", {}).get("db_path", "~/.shadowdb/shadow.db")
    if os.path.exists(os.path.expanduser(sqlite_path)):
        return "sqlite"

    return "sqlite"


def resolve_backend(override=None):
    """
    Instantiate the right backend adapter for search.

    Each backend implements two methods:
        .startup() → str           (identity text)
        .search(query, ...) → list (ranked results)
    """
    config = load_config()
    name = override or get_backend_name()

    if name in ("postgres", "pg"):
        from backends.postgres import PostgresBackend
        pg = config.get("postgres", {})
        return PostgresBackend(
            psql_path=pg.get("psql_path", "/opt/homebrew/opt/postgresql@17/bin/psql"),
            database=pg.get("database", "shadow"),
            embedding_url=pg.get("embedding_url", DEFAULT_EMBEDDING_URL),
            embedding_model=pg.get("embedding_model", DEFAULT_EMBEDDING_MODEL),
        )

    elif name == "sqlite":
        from backends.sqlite import SQLiteBackend
        sq = config.get("sqlite", {})
        return SQLiteBackend(
            db_path=sq.get("db_path", "shadow.db"),
            embedding_url=sq.get("embedding_url", DEFAULT_EMBEDDING_URL),
            embedding_model=sq.get("embedding_model", DEFAULT_EMBEDDING_MODEL),
        )

    elif name in ("mysql", "mariadb"):
        from backends.mysql import MySQLBackend
        my = config.get("mysql", {})
        return MySQLBackend(
            host=my.get("host", "localhost"),
            port=my.get("port", 3306),
            user=my.get("user", "root"),
            password=my.get("password", ""),
            database=my.get("database", "shadow"),
            embedding_url=my.get("embedding_url", DEFAULT_EMBEDDING_URL),
            embedding_model=my.get("embedding_model", DEFAULT_EMBEDDING_MODEL),
        )

    else:
        print(f"Unknown backend: {name}", file=sys.stderr)
        print("Supported: postgres, sqlite, mysql", file=sys.stderr)
        sys.exit(1)


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                     DATABASE HELPERS (BACKEND-AWARE)                       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
#   Subcommands (save, loops, state, people, handoff, d) need to run SQL
#   directly. These helpers route to whichever database CLI is configured:
#
#     PostgreSQL  →  psql
#     SQLite      →  sqlite3
#     MySQL       →  mysql
#
#   Two helpers:
#     db_cmd()    — Raw output (for parsing single values)
#     db_pretty() — Formatted table output (for display)


def db_cmd(sql):
    """
    Run a SQL query and return raw output as a string.

    Routes to the configured backend's CLI tool automatically.
    Returns clean, parseable output — one value per line, no headers.
    """
    config = load_config()
    backend = get_backend_name()

    if backend in ("postgres", "pg"):
        psql = config.get("postgres", {}).get("psql_path",
            "/opt/homebrew/opt/postgresql@17/bin/psql")
        db = config.get("postgres", {}).get("database", "shadow")
        result = subprocess.run(
            [psql, db, "-t", "-A", "-c", sql],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()

    elif backend == "sqlite":
        db_path = os.path.expanduser(
            config.get("sqlite", {}).get("db_path", "~/.shadowdb/shadow.db"))
        result = subprocess.run(
            ["sqlite3", db_path, sql],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()

    elif backend in ("mysql", "mariadb"):
        mc = config.get("mysql", {})
        result = subprocess.run(
            ["mysql", "-u", mc.get("user", "root"),
             f"-p{mc.get('password', '')}",
             "-h", mc.get("host", "localhost"),
             mc.get("database", "shadow"),
             "-N", "-B", "-e", sql],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()

    return ""


def db_pretty(sql):
    """
    Run a SQL query and return formatted table output (with headers).

    Same routing as db_cmd(), but keeps headers and alignment for
    human-readable display.
    """
    config = load_config()
    backend = get_backend_name()

    if backend in ("postgres", "pg"):
        psql = config.get("postgres", {}).get("psql_path",
            "/opt/homebrew/opt/postgresql@17/bin/psql")
        db = config.get("postgres", {}).get("database", "shadow")
        result = subprocess.run(
            [psql, db, "-c", sql],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()

    elif backend == "sqlite":
        db_path = os.path.expanduser(
            config.get("sqlite", {}).get("db_path", "~/.shadowdb/shadow.db"))
        result = subprocess.run(
            ["sqlite3", "-header", "-column", db_path, sql],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()

    elif backend in ("mysql", "mariadb"):
        mc = config.get("mysql", {})
        result = subprocess.run(
            ["mysql", "-u", mc.get("user", "root"),
             f"-p{mc.get('password', '')}",
             "-h", mc.get("host", "localhost"),
             mc.get("database", "shadow"),
             "-e", sql],
            capture_output=True, text=True, timeout=10,
        )
        return result.stdout.strip()

    return ""


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                        SQL DIALECT HELPERS                                 ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
#   Different databases have slightly different SQL syntax for common ops.
#   These helpers emit the right SQL for whichever backend is active.
#
#   This keeps the subcommand code clean — it reads like plain SQL,
#   and the dialect differences are handled in one place.


def sql_now():
    """Current timestamp: now() for postgres/mysql, datetime('now') for sqlite."""
    if get_backend_name() == "sqlite":
        return "datetime('now')"
    return "now()"


def sql_ilike(column, pattern):
    """Case-insensitive LIKE: ILIKE for postgres, LIKE COLLATE NOCASE for sqlite."""
    if get_backend_name() == "sqlite":
        return f"{column} LIKE '{pattern}' COLLATE NOCASE"
    return f"{column} ILIKE '{pattern}'"


def sql_left(column, length):
    """Left substring: left() for postgres/mysql, substr() for sqlite."""
    if get_backend_name() == "sqlite":
        return f"substr({column}, 1, {length})"
    return f"left({column}, {length})"


def sql_array(tags):
    """
    Array literal for tags.

    PostgreSQL uses ARRAY['a','b']. SQLite and MySQL store tags as a
    comma-separated string (no native array type).
    """
    backend = get_backend_name()
    if backend in ("postgres", "pg"):
        if tags:
            return "ARRAY[" + ",".join(f"'{t.strip()}'" for t in tags) + "]"
        return "ARRAY[]::text[]"
    # SQLite / MySQL: comma-separated string
    return "'" + ",".join(t.strip() for t in tags) + "'"


def sql_timestamp(column):
    """Format a timestamp column for display."""
    if get_backend_name() == "sqlite":
        return column
    return f"{column}::timestamp(0)"


def sql_interval(column, interval):
    """
    Filter rows newer than an interval.

    PostgreSQL: column > now() - interval '24 hours'
    SQLite:     column > datetime('now', '-24 hours')
    """
    if get_backend_name() == "sqlite":
        return f"{column} > datetime('now', '-{interval}')"
    return f"{column} > now() - interval '{interval}'"


def sql_coalesce_date(column):
    """Coalesce a date column to '—' if null."""
    if get_backend_name() == "sqlite":
        return f"COALESCE({column}, '—')"
    return f"COALESCE({column}::text, '—')"


def sql_upsert(table, key_col, key_val, val_col, val):
    """
    Insert-or-update (upsert) a key-value pair.

    Both PostgreSQL and SQLite support ON CONFLICT ... DO UPDATE.
    The syntax is the same; only the timestamp function differs.
    """
    escaped = val.replace("'", "''")
    now = sql_now()
    return (
        f"INSERT INTO {table} ({key_col}, {val_col}, updated_at) "
        f"VALUES ('{key_val}', '{escaped}', {now}) "
        f"ON CONFLICT ({key_col}) DO UPDATE "
        f"SET {val_col} = '{escaped}', updated_at = {now};"
    )


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                         RESULT FORMATTING                                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝


def format_results(results, as_json=False):
    """
    Format search results for output.

    JSON mode (--json):  Clean array for programmatic consumption.
    Human mode (default): Dividers, rank numbers, category tags.
    """
    if as_json:
        print(json.dumps(results, indent=2))
        return

    for i, result in enumerate(results):
        title = result["title"] or result["src"] or f"id:{result['id']}"

        print(f"\n{'─' * 50}")
        print(f" #{i + 1} {title} [{result['cat']}] score:{result['score']}")

        if result["summary"]:
            print(f" {result['summary'][:120]}")

        print(f"{'─' * 50}")
        print(result["content"])


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                                                                            ║
# ║                            SUBCOMMANDS                                     ║
# ║                                                                            ║
# ║   Shortcuts for common database operations. These bypass the search        ║
# ║   pipeline — no embeddings, no ranking, just direct SQL.                   ║
# ║                                                                            ║
# ║   All subcommands work with any configured backend (postgres, sqlite,      ║
# ║   mysql). SQL dialect differences are handled by the helpers above.        ║
# ║                                                                            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝


def cmd_save(args):
    """
    Save a new record to the memories table.

    Usage:
        m save "title" "content"
        m save "title" "content" -c category
        m save "title" "content" -c category -t tag1,tag2,tag3
    """
    if len(args) < 2:
        print('Usage: m save "title" "content" [-c category] [-t tag1,tag2]')
        sys.exit(1)

    title = args[0]
    content = args[1]
    category = "general"
    tags = []

    # Parse optional flags
    i = 2
    while i < len(args):
        if args[i] == "-c" and i + 1 < len(args):
            category = args[i + 1]
            i += 2
        elif args[i] == "-t" and i + 1 < len(args):
            tags = args[i + 1].split(",")
            i += 2
        else:
            i += 1

    escaped_title = title.replace("'", "''")
    escaped_content = content.replace("'", "''")
    tags_sql = sql_array(tags)
    now = sql_now()

    backend = get_backend_name()
    if backend in ("postgres", "pg"):
        # RETURNING id gives us the new row's ID in the output
        result = db_cmd(
            f"INSERT INTO memories (title, content, category, tags, created_at) "
            f"VALUES ('{escaped_title}', '{escaped_content}', '{category}', "
            f"{tags_sql}, {now}) RETURNING id;"
        )
        record_id = result.split("\n")[0].strip()  # first line only (skip command tag)

    elif backend == "sqlite":
        db_cmd(
            f"INSERT INTO memories (title, content, category, tags, created_at) "
            f"VALUES ('{escaped_title}', '{escaped_content}', '{category}', "
            f"{tags_sql}, {now});"
        )
        record_id = db_cmd("SELECT last_insert_rowid();")

    else:
        db_cmd(
            f"INSERT INTO memories (title, content, category, tags, created_at) "
            f"VALUES ('{escaped_title}', '{escaped_content}', '{category}', "
            f"{tags_sql}, {now});"
        )
        record_id = "?"

    print(f'Saved: id={record_id} title="{title}" category={category}')


def cmd_loops(args):
    """
    Show open loops, nags, and deadlines.

    Usage:
        m loops
    """
    left = sql_left("description", 100)
    coalesce = sql_coalesce_date("due_date")

    print(db_pretty(
        f"SELECT id, "
        f"  CASE WHEN nag THEN '🔴' ELSE '⚪' END AS nag, "
        f"  {coalesce} AS due, "
        f"  {left} AS description "
        f"FROM open_loops "
        f"WHERE status = 'open' "
        f"ORDER BY nag DESC, due_date ASC NULLS LAST;"
    ))


def cmd_state(args):
    """
    Read or write session state.

    Usage:
        m state                              Show all state
        m state current_focus                Read one key
        m state current_focus "Working on X" Write a key
    """
    left = sql_left("value", 120)
    ts = sql_timestamp("updated_at")

    if len(args) == 0:
        print(db_pretty(
            f"SELECT key, {left} AS value, {ts} "
            f"FROM session_state ORDER BY key;"
        ))

    elif len(args) == 1:
        result = db_cmd(
            f"SELECT value FROM session_state WHERE key = '{args[0]}';"
        )
        print(result if result else f"No key '{args[0]}'")

    else:
        db_cmd(sql_upsert("session_state", "key", args[0], "value", args[1]))
        print(f"Updated: {args[0]}")


def cmd_people(args):
    """
    Look up contacts.

    Usage:
        m people              List first 20 contacts
        m people "Watson"     Search by name, company, or notes
    """
    if not args:
        print(db_pretty(
            "SELECT name, company, role, phone, email "
            "FROM people ORDER BY name LIMIT 20;"
        ))
    else:
        query = args[0].replace("'", "''")
        name_match = sql_ilike("name", f"%{query}%")
        company_match = sql_ilike("company", f"%{query}%")
        notes_match = sql_ilike("notes", f"%{query}%")

        print(db_pretty(
            f"SELECT name, company, role, phone, email, notes "
            f"FROM people "
            f"WHERE {name_match} OR {company_match} OR {notes_match};"
        ))


def cmd_handoff(args):
    """
    Write session handoff state in one call.

    Usage:
        m handoff "current focus"
        m handoff "current focus" "pending drafts"
        m handoff "current focus" "pending drafts" "recent decisions"
    """
    if len(args) < 1:
        print('Usage: m handoff "focus" ["drafts"] ["decisions"]')
        sys.exit(1)

    db_cmd(sql_upsert("session_state", "key", "current_focus", "value", args[0]))

    if len(args) > 1:
        db_cmd(sql_upsert("session_state", "key", "pending_drafts", "value", args[1]))

    if len(args) > 2:
        db_cmd(sql_upsert("session_state", "key", "recent_decisions", "value", args[2]))

    left = sql_left("value", 100)
    print("Session handoff written.")
    print(db_pretty(f"SELECT key, {left} AS value FROM session_state ORDER BY key;"))


def cmd_d(args):
    """
    Daily dashboard — session state + open loops + recent records.

    Usage:
        m d
    """
    left_val = sql_left("value", 120)
    left_desc = sql_left("description", 100)
    left_title = sql_left("title", 60)
    coalesce = sql_coalesce_date("due_date")
    ts = sql_timestamp("created_at")
    interval = sql_interval("created_at", "24 hours")

    print("═══ SESSION STATE ═══")
    print(db_pretty(
        f"SELECT key, {left_val} AS value FROM session_state ORDER BY key;"
    ))

    print("\n═══ OPEN LOOPS ═══")
    print(db_pretty(
        f"SELECT id, "
        f"  CASE WHEN nag THEN '🔴' ELSE '⚪' END AS nag, "
        f"  {coalesce} AS due, "
        f"  {left_desc} AS description "
        f"FROM open_loops "
        f"WHERE status = 'open' "
        f"ORDER BY nag DESC, due_date ASC NULLS LAST;"
    ))

    print("\n═══ RECENT (24h) ═══")
    print(db_pretty(
        f"SELECT id, category, {left_title} AS title, {ts} "
        f"FROM memories "
        f"WHERE {interval} "
        f"ORDER BY created_at DESC LIMIT 10;"
    ))


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                         SUBCOMMAND REGISTRY                                ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
#   When the user types `m save ...`, we look up "save" here and call the
#   handler directly — bypassing search entirely. Fast, no embedding overhead.

SUBCOMMANDS = {
    "save":    cmd_save,
    "loops":   cmd_loops,
    "state":   cmd_state,
    "people":  cmd_people,
    "handoff": cmd_handoff,
    "d":       cmd_d,
}


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                              MAIN                                          ║
# ╚══════════════════════════════════════════════════════════════════════════════╝


def main():
    """
    Entry point.

        1. No args or --help  →  print usage
        2. First arg is a subcommand  →  dispatch to handler
        3. Otherwise  →  treat as search query
    """

    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print("""m — ShadowDB memory search + operations

  SEARCH:   m "query" [-n 5] [-c category] [--full] [--json]
  SAVE:     m save "title" "content" [-c category] [-t tag1,tag2]
  LOOPS:    m loops                     — open nags/deadlines
  STATE:    m state [key] [value]       — read/write session state
  PEOPLE:   m people [name]             — contact lookup
  HANDOFF:  m handoff "focus" ["drafts"] ["decisions"]
  DASH:     m d                         — daily dashboard""")
        sys.exit(0)

    # Subcommand dispatch — no search, no startup, no embeddings
    if sys.argv[1] in SUBCOMMANDS:
        SUBCOMMANDS[sys.argv[1]](sys.argv[2:])
        sys.exit(0)

    # Search mode
    parser = argparse.ArgumentParser()
    parser.add_argument("query", nargs="+")
    parser.add_argument("-n", type=int, default=5)
    parser.add_argument("-c", "--cat", default=None)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--backend", default=None)

    args = parser.parse_args()
    query = " ".join(args.query)

    backend = resolve_backend(args.backend)

    try:
        startup_text = backend.startup()
        if startup_text:
            print(startup_text + "\n")
    except Exception:
        pass

    results = backend.search(query, args.n, args.cat, args.full)
    format_results(results, args.json)


if __name__ == "__main__":
    main()
