"""
Abstract database connector interface.

Every connector implements the same surface:

    query(sql)    → list[dict]     structured results
    execute(sql)  → str            raw text output
    pretty(sql)   → str            formatted table
    ping()        → bool           connectivity check

Connectors handle connection, execution, and dialect.
They know nothing about search, FTS, vectors, or RRF —
that stays in backends/.
"""

from abc import ABC, abstractmethod


class Connector(ABC):
    """
    Minimal database connector.

    Subclasses must implement four methods:
      query   — structured results (list of dicts)
      execute — raw single-column text
      pretty  — human-readable table
      ping    — connectivity test

    Everything else (FTS, vector search, RRF) belongs in backends/.
    Connectors are plumbing. Backends are brains.
    """

    # ── Required ──────────────────────────────────────────────

    @abstractmethod
    def query(self, sql: str, timeout: int = 15) -> list[dict]:
        """
        Execute SQL and return rows as a list of dicts.

        Returns [] on no results or error — never raises for empty.
        Raises on hard failures (connection refused, timeout).
        """
        ...

    @abstractmethod
    def execute(self, sql: str, timeout: int = 10) -> str:
        """
        Execute SQL and return raw text output.

        Strips headers and alignment — just the values.
        Suitable for single-column queries or counts.
        """
        ...

    @abstractmethod
    def pretty(self, sql: str, timeout: int = 10) -> str:
        """
        Execute SQL and return formatted table output.

        Includes headers and column alignment.
        For display to humans, not parsing.
        """
        ...

    @abstractmethod
    def ping(self) -> bool:
        """
        Test connectivity. Returns True if the database is reachable.

        Must not raise — returns False on any failure.
        """
        ...

    # ── Optional (override if the dialect needs it) ───────────

    def quote(self, value: str) -> str:
        """Escape a string value for safe SQL interpolation."""
        return value.replace("'", "''")

    # ── Dialect helpers ───────────────────────────────────────
    # Override in subclasses where SQL syntax diverges.

    def now(self) -> str:
        """SQL expression for current timestamp."""
        return "CURRENT_TIMESTAMP"

    def ilike(self, col: str, pattern: str) -> str:
        """Case-insensitive LIKE. PG has ILIKE; others use LOWER()."""
        return f"LOWER({col}) LIKE LOWER('{self.quote(pattern)}')"

    def left(self, col: str, n: int) -> str:
        """First N characters of a column."""
        return f"SUBSTR({col}, 1, {n})"

    def array_contains(self, col: str, value: str) -> str:
        """Test if an array column contains a value. Backend-specific."""
        raise NotImplementedError("array_contains not supported by this connector")

    def upsert(self, table: str, key_col: str, cols: list[str]) -> str:
        """
        Generate an UPSERT statement template.

        Returns SQL with {placeholders} for values.
        Override per dialect (ON CONFLICT, ON DUPLICATE KEY, etc.).
        """
        raise NotImplementedError("upsert not supported by this connector")

    # ── Repr ──────────────────────────────────────────────────

    def __repr__(self):
        return f"<{self.__class__.__name__}>"
