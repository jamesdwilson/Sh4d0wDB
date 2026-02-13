#!/usr/bin/env python3
"""
ShadowDB SQLite Backend — Portable Single-File Memory Search
=============================================================

This backend stores everything in a single .db file with zero external
dependencies beyond Python's standard library. It's the easiest backend
to set up — no server process, no installation, no configuration.

SEARCH STRATEGIES:

  1. FTS5 (Full-Text Search)
     - SQLite's built-in full-text search engine
     - Uses a Porter stemmer for English (runs → run, running → run)
     - Creates an inverted index for fast keyword lookup
     - Always available — FTS5 is compiled into modern SQLite builds

  2. sqlite-vec (Vector Search, optional)
     - Third-party extension for vector similarity search
     - If installed, enables hybrid search (FTS + vector + RRF) like PostgreSQL
     - If NOT installed, gracefully falls back to FTS-only search
     - Install: pip install sqlite-vec (or build from source)

  3. RRF Fusion (when sqlite-vec is available)
     - Same Reciprocal Rank Fusion as the PostgreSQL backend
     - Merges FTS5 and vector results by rank position, not score

WHEN TO USE SQLITE vs POSTGRESQL:
  Use SQLite when:
    - You want zero-infrastructure setup (no PostgreSQL server)
    - You're running on a single machine
    - Your knowledge base is under ~100K records
    - You want a portable, single-file database you can copy/backup

  Use PostgreSQL when:
    - You want the best search quality (native hybrid FTS + vector + RRF)
    - You have more than ~100K records
    - You need concurrent access from multiple agents/processes
    - You're running in production

SCHEMA:
  The SQLite schema mirrors PostgreSQL's structure but uses SQLite-native types:

  CREATE TABLE startup (
      key TEXT PRIMARY KEY,     -- e.g., 'soul', 'user', 'rules'
      content TEXT              -- identity/personality text
  );

  CREATE TABLE memories (
      id INTEGER PRIMARY KEY,   -- auto-incrementing rowid
      content TEXT,              -- full raw text
      content_pyramid TEXT,      -- pre-summarized (max ~800 chars)
      category TEXT,             -- e.g., 'contacts', 'cases'
      title TEXT,
      summary TEXT,
      source_file TEXT,          -- original filename
      embedding BLOB,            -- raw float32 bytes (for sqlite-vec)
      fts_content TEXT           -- text indexed by FTS5
  );

  -- FTS5 virtual table — content-synced with memories table
  CREATE VIRTUAL TABLE memories_fts
      USING fts5(fts_content, content='memories', content_rowid='id');

  -- Optional: sqlite-vec virtual table (only if extension is available)
  CREATE VIRTUAL TABLE vec_memories
      USING vec0(embedding float[768]);
"""

import json
import sqlite3
import struct
import urllib.request


class SQLiteBackend:
    """
    SQLite backend with FTS5 and optional vector search via sqlite-vec.

    Usage:
        backend = SQLiteBackend(db_path="~/.shadowdb/shadow.db")
        print(backend.startup())
        results = backend.search("Watson")
    """

    def __init__(self, db_path="shadow.db",
                 embedding_url="http://localhost:11434/api/embeddings",
                 embedding_model="nomic-embed-text"):
        """
        Initialize the SQLite backend.

        Args:
            db_path:         Path to the SQLite database file.
                             Will be created if it doesn't exist.
            embedding_url:   Ollama API endpoint for embeddings.
            embedding_model: Ollama model name (nomic-embed-text = 768 dims).
        """
        self.db_path = db_path
        self.embed_url = embedding_url
        self.embed_model = embedding_model

        # Lazy-initialized: we check for sqlite-vec on first connection.
        # None means "haven't checked yet", True/False means "checked and available/not".
        self._vec_available = None

    def _connect(self):
        """
        Open a connection to the SQLite database.

        Key settings:
          - row_factory = sqlite3.Row — makes rows behave like dicts
            (access columns by name instead of index)

        We also attempt to load the sqlite-vec extension on the first
        connection. If it's not installed, we set _vec_available = False
        and skip vector search in all subsequent queries. This check
        happens once per backend instance.

        Returns:
            sqlite3.Connection: An open database connection.
        """
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row

        # Try loading sqlite-vec extension (once per instance)
        if self._vec_available is None:
            try:
                conn.enable_load_extension(True)
                conn.load_extension("vec0")
                self._vec_available = True
            except Exception:
                # Extension not found or can't be loaded — that's fine,
                # we'll use FTS-only mode.
                self._vec_available = False

        return conn

    def _embed(self, text):
        """
        Get an embedding vector from Ollama.

        Same implementation as the PostgreSQL backend — sends text to
        Ollama's /api/embeddings endpoint and returns a 768-dim float vector.

        Returns None on failure for graceful degradation to FTS-only search.

        Returns:
            list[float] | None: 768-element vector, or None on failure.
        """
        try:
            req = urllib.request.Request(
                self.embed_url,
                json.dumps({"model": self.embed_model, "prompt": text}).encode(),
                {"Content-Type": "application/json"}
            )
            resp = urllib.request.urlopen(req, timeout=8)
            return json.loads(resp.read())["embedding"]
        except Exception:
            return None

    def _vec_to_bytes(self, vec):
        """
        Convert a float vector to raw bytes for sqlite-vec.

        sqlite-vec stores vectors as raw binary blobs of float32 values.
        This is different from pgvector (which uses a text format '[0.1,0.2,...]').

        For a 768-dim vector, this produces 768 * 4 = 3,072 bytes.

        Args:
            vec: List of floats (the embedding vector).

        Returns:
            bytes: Packed float32 binary representation.
        """
        return struct.pack(f'{len(vec)}f', *vec)

    def startup(self):
        """
        Return the agent's identity text from the startup table.

        Queries all rows ordered by key and joins them with newlines.
        See PostgresBackend.startup() for the design rationale.

        Returns:
            str: Concatenated identity text, or empty string if none found.
        """
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT content FROM startup ORDER BY key"
            ).fetchall()
            return "\n".join(r["content"] for r in rows if r["content"])
        except Exception:
            return ""
        finally:
            conn.close()

    def search(self, query, n=5, category=None, full=False):
        """
        Search using FTS5 with optional vector reranking via sqlite-vec.

        The pipeline depends on whether sqlite-vec is available:

        WITH sqlite-vec:
          1. FTS5 keyword search → top 50 matches
          2. Ollama embedding → sqlite-vec distance search → top 50 matches
          3. RRF fusion of both lists → final ranked results

        WITHOUT sqlite-vec:
          1. FTS5 keyword search only → top N matches
          (Still useful — FTS5 is surprisingly good for most queries)

        Args:
            query:    Search string (plain text)
            n:        Number of results to return
            category: Optional category filter
            full:     If True, return raw content instead of pyramid summary

        Returns:
            list[dict]: Ranked results in standard format.
        """
        conn = self._connect()
        try:
            # Content field selection (same logic as PostgreSQL backend)
            content_field = "content" if full else "COALESCE(content_pyramid, content)"

            # Category filter (using parameterized query — safe from injection)
            where_category = f"AND m.category = ?" if category else ""
            params = [query] + ([category] if category else [])

            # --- FTS5 search ---
            # FTS5's MATCH operator does the keyword search.
            # The `rank` column is a built-in FTS5 function that returns
            # a negative BM25 score (more negative = better match).
            # We sort by rank ascending because of the negative convention.
            fts_results = conn.execute(
                f"SELECT m.id, substr({content_field}, 1, 800) as c, "
                f"m.category as cat, m.title, m.summary, m.source_file as src, "
                f"rank as score "
                f"FROM memories_fts f "
                f"JOIN memories m ON m.id = f.rowid "
                f"WHERE memories_fts MATCH ? {where_category} "
                f"ORDER BY rank LIMIT 50",
                params
            ).fetchall()

            # Convert sqlite3.Row objects to dicts for uniform handling
            fts_results = [dict(r) for r in fts_results]

            # --- Vector search (only if sqlite-vec is available) ---
            vector_results = []
            if self._vec_available:
                embedding = self._embed(query)
                if embedding:
                    # Convert the float vector to raw bytes for sqlite-vec
                    vec_bytes = self._vec_to_bytes(embedding)

                    # sqlite-vec uses MATCH on the embedding column with
                    # the raw bytes as the query. Results are ordered by
                    # distance (lower = more similar).
                    vector_results = conn.execute(
                        f"SELECT m.id, substr({content_field}, 1, 800) as c, "
                        f"m.category as cat, m.title, m.summary, m.source_file as src, "
                        f"v.distance as score "
                        f"FROM vec_memories v "
                        f"JOIN memories m ON m.id = v.rowid "
                        f"WHERE v.embedding MATCH ? "
                        f"ORDER BY v.distance LIMIT 50",
                        [vec_bytes]
                    ).fetchall()
                    vector_results = [dict(r) for r in vector_results]

            # --- RRF fusion ---
            return self._rrf(fts_results, vector_results, n)
        finally:
            conn.close()

    def _rrf(self, fts_results, vector_results, n, k=60):
        """
        Reciprocal Rank Fusion — identical algorithm to PostgreSQL backend.

        See PostgresBackend._rrf() for the detailed explanation of the
        algorithm, the choice of k=60, and why RRF is the right fusion
        strategy for heterogeneous score scales.

        Args:
            fts_results:    Ranked list from FTS5 search
            vector_results: Ranked list from sqlite-vec search (may be empty)
            n:              Number of results to return
            k:              Smoothing constant (default 60)

        Returns:
            list[dict]: Top N results sorted by RRF score.
        """
        scores = {}
        cache = {}

        for rank, result in enumerate(fts_results):
            doc_id = str(result["id"])
            scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (k + rank + 1)
            cache[doc_id] = result

        for rank, result in enumerate(vector_results):
            doc_id = str(result["id"])
            scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (k + rank + 1)
            cache.setdefault(doc_id, result)

        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

        results = []
        for doc_id, score in ranked:
            result = cache[doc_id]
            results.append({
                "id": result["id"],
                "score": round(score, 6),
                "title": result.get("title", ""),
                "summary": result.get("summary", ""),
                "cat": result.get("cat", ""),
                "src": result.get("src", ""),
                "content": result["c"]
            })
        return results
