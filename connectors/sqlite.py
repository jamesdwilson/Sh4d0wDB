"""
SQLite connector — talks to SQLite via the sqlite3 CLI.

Zero dependencies. Python stdlib + sqlite3 binary (ships with macOS/Linux).

The database is a file path. Can be anywhere reachable by the OS:
local disk, NFS mount, cloud drive, USB stick.
"""

import json
import os
import subprocess

from .base import Connector


class SQLiteConnector(Connector):
    """SQLite via sqlite3 subprocess."""

    def __init__(self, *, db_path):
        if not db_path:
            raise ValueError("SQLiteConnector requires 'db_path'")
        self.db_path = os.path.expanduser(db_path)

    # ── Helpers ───────────────────────────────────────────────

    def _run(self, args, timeout=10) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["sqlite3"] + args,
            capture_output=True, text=True, timeout=timeout
        )

    # ── Interface ─────────────────────────────────────────────

    def query(self, sql, timeout=15):
        """
        Execute SQL → list[dict].

        Uses sqlite3 JSON mode to return structured results.
        Falls back to manual header+row parsing if json mode unavailable.
        """
        r = self._run([self.db_path, "-json", sql], timeout)
        raw = r.stdout.strip()
        if not raw:
            return []
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            # Older sqlite3 without -json: fall back to header+csv parse
            return self._parse_csv(sql, timeout)

    def _parse_csv(self, sql, timeout):
        """Fallback parser for sqlite3 without -json flag."""
        r = self._run(["-header", "-csv", self.db_path, sql], timeout)
        lines = r.stdout.strip().split("\n")
        if len(lines) < 2:
            return []
        headers = [h.strip('"') for h in lines[0].split(",")]
        rows = []
        for line in lines[1:]:
            vals = [v.strip('"') for v in line.split(",")]
            rows.append(dict(zip(headers, vals)))
        return rows

    def execute(self, sql, timeout=10):
        """Execute SQL → raw text."""
        r = self._run([self.db_path, sql], timeout)
        return r.stdout.strip()

    def pretty(self, sql, timeout=10):
        """Execute SQL → formatted table with headers and columns."""
        r = self._run(["-header", "-column", self.db_path, sql], timeout)
        return r.stdout.strip()

    def ping(self):
        try:
            if not os.path.exists(self.db_path):
                return False
            r = self._run([self.db_path, "SELECT 1;"], timeout=3)
            return r.returncode == 0 and r.stdout.strip() == "1"
        except Exception:
            return False

    # ── Dialect overrides ─────────────────────────────────────

    # ilike: SQLite has no ILIKE — base class LOWER() fallback is correct.
    # left: SQLite has no LEFT() — base class SUBSTR() fallback is correct.

    def upsert(self, table, key_col, cols):
        """SQLite ON CONFLICT upsert (requires SQLite 3.24+)."""
        col_list = ", ".join(cols)
        val_placeholders = ", ".join(f"{{{c}}}" for c in cols)
        update_set = ", ".join(f"{c}={{{c}}}" for c in cols if c != key_col)
        return (
            f"INSERT INTO {table} ({col_list}) VALUES ({val_placeholders}) "
            f"ON CONFLICT ({key_col}) DO UPDATE SET {update_set};"
        )

    def __repr__(self):
        return f"<SQLiteConnector {self.db_path}>"
