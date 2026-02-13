"""
PostgreSQL connector — talks to PG via the psql CLI.

Zero pip dependencies. Just Python stdlib + a reachable PostgreSQL instance.

Connection modes (in priority order):
  1. connection_string — full URI passed to psql
     "postgresql://user:pass@host:5432/db?sslmode=require"
  2. host/port/user/password/database — individual fields → psql flags
  3. database only — local Unix socket (peer auth)

Password is passed via PGPASSWORD env var, never on the command line.
"""

import json
import os
import subprocess

from .base import Connector


class PostgresConnector(Connector):
    """PostgreSQL via psql subprocess."""

    def __init__(self, *, database=None, host=None, port=None,
                 user=None, password=None, connection_string=None,
                 psql_path="psql"):
        if not connection_string and not database:
            raise ValueError(
                "PostgresConnector requires 'database' or 'connection_string'"
            )
        self.connection_string = connection_string
        self.database = database
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.psql = psql_path

    # ── psql command builder ──────────────────────────────────

    def _cmd(self, *extra) -> list[str]:
        """Build psql command list with connection args."""
        cmd = [self.psql]
        if self.connection_string:
            cmd.append(self.connection_string)
        else:
            if self.host:
                cmd.extend(["-h", self.host])
            if self.port:
                cmd.extend(["-p", str(self.port)])
            if self.user:
                cmd.extend(["-U", self.user])
            cmd.append(self.database)
        cmd.extend(extra)
        return cmd

    def _env(self) -> dict | None:
        """Env dict with PGPASSWORD if set."""
        if self.password:
            return {**os.environ, "PGPASSWORD": self.password}
        return None

    def _run(self, cmd, timeout=15) -> subprocess.CompletedProcess:
        return subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout, env=self._env()
        )

    # ── Interface ─────────────────────────────────────────────

    def query(self, sql, timeout=15):
        """
        Execute SQL → list[dict].

        Wraps the query in json_agg(row_to_json(...)) so psql returns
        a single JSON array string. Parsed into Python dicts.
        """
        wrapped = f"SELECT json_agg(row_to_json(sub)) FROM ({sql}) sub;"
        r = self._run(self._cmd("-t", "-A", "-c", wrapped), timeout)
        raw = r.stdout.strip()
        return json.loads(raw) if raw and raw != "null" else []

    def execute(self, sql, timeout=10):
        """Execute SQL → raw text (no headers, no alignment)."""
        r = self._run(self._cmd("-t", "-A", "-c", sql), timeout)
        return r.stdout.strip()

    def pretty(self, sql, timeout=10):
        """Execute SQL → formatted table with headers."""
        r = self._run(self._cmd("-c", sql), timeout)
        return r.stdout.strip()

    def ping(self):
        try:
            r = self._run(self._cmd("-t", "-A", "-c", "SELECT 1;"), timeout=3)
            return r.returncode == 0 and r.stdout.strip() == "1"
        except Exception:
            return False

    # ── Dialect overrides ─────────────────────────────────────

    def ilike(self, col, pattern):
        """PostgreSQL has native ILIKE."""
        return f"{col} ILIKE '{self.quote(pattern)}'"

    def left(self, col, n):
        """PostgreSQL has native LEFT()."""
        return f"LEFT({col}, {n})"

    def array_contains(self, col, value):
        """PostgreSQL text[] array contains."""
        return f"'{self.quote(value)}' = ANY({col})"

    def upsert(self, table, key_col, cols):
        """PostgreSQL ON CONFLICT upsert template."""
        col_list = ", ".join(cols)
        val_placeholders = ", ".join(f"{{{c}}}" for c in cols)
        update_set = ", ".join(f"{c}={{{c}}}" for c in cols if c != key_col)
        return (
            f"INSERT INTO {table} ({col_list}) VALUES ({val_placeholders}) "
            f"ON CONFLICT ({key_col}) DO UPDATE SET {update_set};"
        )

    def __repr__(self):
        target = self.connection_string or self.database
        if self.host:
            target = f"{self.user or ''}@{self.host}:{self.port or 5432}/{self.database}"
        return f"<PostgresConnector {target}>"
