"""
ShadowDB Backends — Pluggable Database Adapters
================================================

Each backend implements the same two-method interface:

    class SomeBackend:
        def startup(self) -> str:
            '''Return identity/soul text to prepend to search results.'''
            ...

        def search(self, query: str, n: int = 5,
                   category: str = None, full: bool = False) -> list[dict]:
            '''Return ranked search results.
            Each result: {id, score, title, summary, cat, src, content}'''
            ...

Available backends:
    - postgres.py  — PostgreSQL + pgvector (hybrid FTS + vector + RRF fusion)
    - sqlite.py    — SQLite + FTS5 + optional sqlite-vec (RRF with vec enabled)
    - mysql.py     — MySQL/MariaDB FULLTEXT search (keyword-only, no native vector)

The interface is intentionally minimal. All search-strategy complexity
(FTS dialect, vector operations, score normalization, RRF fusion) lives
INSIDE each backend. The caller just calls .search() and gets back a
uniformly-formatted list of results.

WHY NOT AN ABSTRACT BASE CLASS?
    We considered using abc.ABC + @abstractmethod but decided against it:
    1. It adds import overhead for no runtime benefit
    2. The interface is two methods — hard to get wrong
    3. Duck typing is more Pythonic for this scale
    4. The test suite validates interface compliance anyway

HOW TO ADD A NEW BACKEND:
    1. Create backends/mydb.py
    2. Implement a class with startup() and search() methods
    3. Add the import + instantiation to m-universal's _create_backend()
    4. Add connection config to shadowdb.example.json
    5. Add tests to tests/test_backends.sh
"""
