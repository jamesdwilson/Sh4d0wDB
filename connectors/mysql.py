"""
MySQL / MariaDB connector — talks to MySQL via the mysql CLI.

Zero pip dependencies. Python stdlib + mysql client binary.

Connection modes:
  1. connection_string — URI parsed into host/port/user/password/database
     "mysql://user:pass@host:3306/db"
  2. Individual fields (host, port, user, password, database)
"""

import json
import subprocess

from .base import Connector

try:
    from urllib.parse import urlparse
except ImportError:
    urlparse = None  # Python 2 — not supported but won't crash on import


class MySQLConnector(Connector):
    """MySQL/MariaDB via mysql subprocess."""

    def __init__(self, *, database=None, host="localhost", port=3306,
                 user=None, password=None, connection_string=None):
        if connection_string:
            self._parse_url(connection_string)
        else:
            if not database:
                raise ValueError("MySQLConnector requires 'database' or 'connection_string'")
            if not user:
                raise ValueError("MySQLConnector requires 'user'")
            self.database = database
            self.host = host
            self.port = port
            self.user = user
            self.password = password
        self.connection_string = connection_string

    def _parse_url(self, url):
        """Parse mysql://user:pass@host:port/database into fields."""
        p = urlparse(url)
        self.host = p.hostname or "localhost"
        self.port = p.port or 3306
        self.user = p.username
        self.password = p.password
        self.database = p.path.lstrip("/")
        if not self.database:
            raise ValueError(f"No database in connection string: {url}")
        if not self.user:
            raise ValueError(f"No user in connection string: {url}")

    # ── mysql command builder ─────────────────────────────────

    def _cmd(self, *extra) -> list[str]:
        """Build mysql command list."""
        cmd = ["mysql", "-u", self.user, "-h", self.host,
               "-P", str(self.port), self.database]
        if self.password:
            cmd.insert(3, f"-p{self.password}")
        cmd.extend(extra)
        return cmd

    def _run(self, cmd, timeout=10) -> subprocess.CompletedProcess:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )

    # ── Interface ─────────────────────────────────────────────

    def query(self, sql, timeout=15):
        """
        Execute SQL → list[dict].

        Uses MySQL's JSON_ARRAYAGG(JSON_OBJECT(...)) when possible.
        Falls back to tab-separated header+row parsing.
        """
        # Tab-separated with headers → parse into dicts
        r = self._run(self._cmd("-N", "-B", "--column-names", "-e", sql), timeout)
        lines = r.stdout.strip().split("\n")
        if len(lines) < 2:
            return []
        headers = lines[0].split("\t")
        rows = []
        for line in lines[1:]:
            vals = line.split("\t")
            rows.append(dict(zip(headers, vals)))
        return rows

    def execute(self, sql, timeout=10):
        """Execute SQL → raw text (no headers, tab-separated values)."""
        r = self._run(self._cmd("-N", "-B", "-e", sql), timeout)
        return r.stdout.strip()

    def pretty(self, sql, timeout=10):
        """Execute SQL → formatted table with headers."""
        r = self._run(self._cmd("-e", sql), timeout)
        return r.stdout.strip()

    def ping(self):
        try:
            r = self._run(self._cmd("-N", "-B", "-e", "SELECT 1;"), timeout=3)
            return r.returncode == 0 and r.stdout.strip() == "1"
        except Exception:
            return False

    # ── Dialect overrides ─────────────────────────────────────

    # ilike: MySQL is case-insensitive by default with utf8 collation.
    # Override to skip the LOWER() wrapper.
    def ilike(self, col, pattern):
        """MySQL is case-insensitive by default (utf8_general_ci)."""
        return f"{col} LIKE '{self.quote(pattern)}'"

    def left(self, col, n):
        """MySQL has native LEFT()."""
        return f"LEFT({col}, {n})"

    def array_contains(self, col, value):
        """MySQL has no native arrays. Use JSON_CONTAINS or FIND_IN_SET."""
        return f"JSON_CONTAINS({col}, '\"{self.quote(value)}\"')"

    def upsert(self, table, key_col, cols):
        """MySQL ON DUPLICATE KEY upsert template."""
        col_list = ", ".join(cols)
        val_placeholders = ", ".join(f"{{{c}}}" for c in cols)
        update_set = ", ".join(f"{c}=VALUES({c})" for c in cols if c != key_col)
        return (
            f"INSERT INTO {table} ({col_list}) VALUES ({val_placeholders}) "
            f"ON DUPLICATE KEY UPDATE {update_set};"
        )

    def __repr__(self):
        return f"<MySQLConnector {self.user}@{self.host}:{self.port}/{self.database}>"
