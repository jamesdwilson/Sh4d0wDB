"""
ShadowDB Connectors — one function, any database.

Usage:

    from connectors import connect

    # From a URL (scheme determines backend):
    db = connect("postgresql://user:pass@host/dbname")
    db = connect("sqlite:///path/to/file.db")
    db = connect("mysql://user:pass@host/dbname")

    # From ~/.shadowdb.json (auto-detect):
    db = connect()

    # Then use the universal interface:
    rows  = db.query("SELECT * FROM memories LIMIT 5")   # → list[dict]
    text  = db.execute("SELECT count(*) FROM memories")   # → "42"
    table = db.pretty("SELECT id, title FROM memories")   # → formatted
    ok    = db.ping()                                      # → True/False

Connectors are plumbing (connection + execution + dialect).
Backends are brains (FTS + vector + RRF).
"""

import json
import os

from .base import Connector
from .postgres import PostgresConnector
from .sqlite import SQLiteConnector
from .mysql import MySQLConnector

__all__ = [
    "connect",
    "Connector",
    "PostgresConnector",
    "SQLiteConnector",
    "MySQLConnector",
]

CFG_PATH = os.path.expanduser("~/.shadowdb.json")

# ── URL scheme → connector mapping ────────────────────────────

_SCHEMES = {
    "postgresql": "postgres",
    "postgres": "postgres",
    "pg": "postgres",
    "sqlite": "sqlite",
    "mysql": "mysql",
    "mariadb": "mysql",
}


def connect(url: str = None, **overrides) -> Connector:
    """
    Create a database connector.

    Args:
        url:       Database URL. Scheme determines backend:
                   postgresql://  sqlite:///  mysql://
                   If omitted, reads ~/.shadowdb.json.
        **overrides: Extra kwargs passed to the connector constructor.

    Returns:
        Connector subclass instance.

    Examples:
        connect("postgresql://user:pass@neon.tech:5432/shadow?sslmode=require")
        connect("sqlite:///Users/james/.shadowdb/shadow.db")
        connect("mysql://root:pass@localhost/shadow")
        connect()  # auto-detect from ~/.shadowdb.json
    """
    if url:
        return _from_url(url, **overrides)
    return _from_config(**overrides)


def _from_url(url: str, **overrides) -> Connector:
    """Parse a database URL and return the appropriate connector."""
    scheme = url.split("://")[0].lower() if "://" in url else ""
    backend = _SCHEMES.get(scheme)

    if not backend:
        raise ValueError(
            f"Unknown URL scheme '{scheme}'. "
            f"Supported: {', '.join(sorted(set(_SCHEMES.values())))}"
        )

    if backend == "postgres":
        return PostgresConnector(connection_string=url, **overrides)

    elif backend == "sqlite":
        # sqlite:///absolute/path or sqlite://relative/path
        path = url.split("://", 1)[1]
        # Handle sqlite:/// (triple slash = absolute) vs sqlite:// (relative)
        if path.startswith("/"):
            db_path = path  # absolute
        else:
            db_path = path  # relative, as-is
        return SQLiteConnector(db_path=db_path, **overrides)

    elif backend == "mysql":
        return MySQLConnector(connection_string=url, **overrides)

    raise ValueError(f"Unsupported backend: {backend}")


def _from_config(**overrides) -> Connector:
    """Read ~/.shadowdb.json and create the configured connector."""
    if not os.path.exists(CFG_PATH):
        raise FileNotFoundError(
            f"No URL provided and no config at {CFG_PATH}. "
            f"Pass a database URL or create ~/.shadowdb.json."
        )

    with open(CFG_PATH) as f:
        cfg = json.load(f)

    backend = (
        os.environ.get("SHADOWDB_BACKEND")
        or cfg.get("backend", "")
    ).lower().strip()

    if not backend:
        raise ValueError(
            "No 'backend' in ~/.shadowdb.json and SHADOWDB_BACKEND not set."
        )

    if backend in ("postgres", "pg"):
        pc = cfg.get("postgres", {})
        return PostgresConnector(
            psql_path=pc.get("psql_path", "psql"),
            database=pc.get("database"),
            host=pc.get("host"),
            port=pc.get("port"),
            user=pc.get("user"),
            password=pc.get("password"),
            connection_string=pc.get("connection_string"),
            **overrides,
        )

    elif backend == "sqlite":
        sc = cfg.get("sqlite", {})
        db_path = sc.get("db_path")
        if not db_path:
            raise ValueError("Missing sqlite.db_path in ~/.shadowdb.json")
        return SQLiteConnector(db_path=db_path, **overrides)

    elif backend in ("mysql", "mariadb"):
        mc = cfg.get("mysql", {})
        return MySQLConnector(
            host=mc.get("host", "localhost"),
            port=mc.get("port", 3306),
            user=mc.get("user"),
            password=mc.get("password"),
            database=mc.get("database"),
            connection_string=mc.get("connection_string"),
            **overrides,
        )

    raise ValueError(f"Unknown backend '{backend}' in ~/.shadowdb.json")
