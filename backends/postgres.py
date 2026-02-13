#!/usr/bin/env python3
"""
ShadowDB PostgreSQL Backend — Hybrid Vector + FTS Search with RRF Fusion
=========================================================================

This is the most capable backend. It combines two independent search strategies
and merges results using Reciprocal Rank Fusion (RRF):

  1. Full-Text Search (FTS)
     - Uses PostgreSQL's built-in tsvector/tsquery with English stemming
     - Indexed with GIN (Generalized Inverted Index) for fast keyword lookup
     - Excels at: exact names, dates, identifiers, rare terms
     - Weakness: no semantic understanding ("doctor" won't find "physician")

  2. Vector Search (Semantic Similarity)
     - Uses pgvector extension with HNSW (Hierarchical Navigable Small World) index
     - Embedding vectors from Ollama's nomic-embed-text model (768 dimensions)
     - Cosine distance (<=>) measures angle between vectors
     - Excels at: semantic queries ("Watson's military service")
     - Weakness: poor at exact string matching, numbers, rare terms

  3. Reciprocal Rank Fusion (RRF)
     - Merges FTS and vector results into a single ranked list
     - Score-agnostic: only cares about rank position, not raw scores
     - This is critical because FTS scores and cosine distances are on
       incompatible scales and can't be directly compared
     - Formula: rrf_score += 1/(k + rank + 1), where k=60

NOTE ON DEPENDENCIES:
  This backend talks to PostgreSQL via the psql CLI (subprocess) rather than
  a Python driver. This keeps the install at zero pip dependencies — just
  Python stdlib and a running PostgreSQL instance. If you prefer psycopg2
  or asyncpg, swapping in a driver is straightforward — the interface is
  just .startup() and .search().

SCHEMA REQUIREMENTS:
  This backend expects two tables:

  CREATE TABLE startup (
      key TEXT PRIMARY KEY,          -- e.g., 'soul', 'user', 'rules'
      content TEXT NOT NULL,         -- identity/personality text
      priority INTEGER DEFAULT 0    -- for future budget-based trimming
  );

  CREATE TABLE memories (
      id SERIAL PRIMARY KEY,
      title TEXT,
      content TEXT,                  -- full raw text
      content_pyramid TEXT,          -- pre-summarized (max ~800 chars)
      category TEXT,                 -- e.g., 'contacts', 'cases', 'knowledge'
      summary TEXT,                  -- one-line summary
      source_file TEXT,              -- original filename (for provenance)
      tags TEXT[],                   -- PostgreSQL text array for filtering
      embedding vector(768),         -- pgvector column (nomic-embed-text)
      fts tsvector                   -- pre-computed full-text search vector
  );

  -- Required indexes:
  CREATE INDEX ON memories USING gin(fts);           -- FTS inverted index
  CREATE INDEX ON memories USING hnsw(embedding vector_cosine_ops);  -- ANN
"""

import json
import subprocess
import urllib.request


class PostgresBackend:
    """
    PostgreSQL backend with hybrid FTS + vector search and RRF fusion.

    This class is instantiated by m-universal's _create_backend() function
    with config values from ~/.shadowdb.json. It can also be used directly:

        backend = PostgresBackend(
            psql_path="/opt/homebrew/opt/postgresql@17/bin/psql",
            database="myagent"
        )
        print(backend.startup())
        results = backend.search("Watson")
    """

    def __init__(self, psql_path="psql", database=None,
                 embedding_url="http://localhost:11434/api/embeddings",
                 embedding_model="nomic-embed-text"):
        """
        Initialize the PostgreSQL backend.

        Args:
            psql_path:       Path to the psql CLI binary (default: "psql" from PATH).
                             macOS Homebrew example: /opt/homebrew/opt/postgresql@17/bin/psql
                             Linux default:  /usr/bin/psql
            database:        PostgreSQL database name (required — no default)
            embedding_url:   Ollama embedding API endpoint (must be running locally)
            embedding_model: Which Ollama model to use for embeddings.
                             nomic-embed-text produces 768-dim vectors.
        """
        if not database:
            raise ValueError("PostgresBackend requires 'database' — set postgres.database in ~/.shadowdb.json")
        self.psql = psql_path
        self.db = database
        self.embed_url = embedding_url
        self.embed_model = embedding_model

    def _embed(self, text):
        """
        Convert text into an embedding vector using Ollama.

        Sends a POST request to Ollama's /api/embeddings endpoint with the
        text to embed. Returns a 768-dimensional float vector.

        Returns None on any failure (Ollama down, model not loaded, network
        error, timeout). This is intentional — the caller checks for None
        and skips vector search, falling back to FTS-only. This graceful
        degradation means a search always returns results even if the
        embedding service is unavailable.

        The 8-second timeout handles the cold-start case: if Ollama has
        unloaded the model from memory, the first embedding request triggers
        a model reload (~2-5 seconds). Subsequent requests are fast (~85ms).

        Returns:
            list[float] | None: 768-element embedding vector, or None on failure.
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

    def _sql(self, query):
        """
        Execute a SQL query and return results as a list of dictionaries.

        Uses the json_agg(row_to_json()) trick to get structured JSON output
        from psql. The query is wrapped as:

            SELECT json_agg(row_to_json(sub)) FROM (<your query>) sub;

        This tells PostgreSQL to:
          1. Run the inner query
          2. Convert each row to a JSON object (row_to_json)
          3. Collect all objects into a JSON array (json_agg)
          4. Return as a single text value

        The -t flag strips headers, -A strips alignment — together they give
        us just the raw JSON string to parse.

        Returns:
            list[dict]: Parsed result rows, or [] if no results or on error.
        """
        wrapped = f"SELECT json_agg(row_to_json(sub)) FROM ({query}) sub;"
        result = subprocess.run(
            [self.psql, self.db, "-t", "-A", "-c", wrapped],
            capture_output=True, text=True, timeout=15
        )
        raw = result.stdout.strip()
        # json_agg returns SQL null for zero rows — handle both empty and null
        return json.loads(raw) if raw and raw != "null" else []

    def startup(self):
        """
        Return the agent's identity text from the startup table.

        Queries all rows from the startup table, ordered by key (alphabetical).
        Typical keys: 'rules', 'soul', 'user' — which means the output order
        is: rules first, then soul, then user context.

        This text is prepended to search results on the first query of each
        session, giving the model its identity before any knowledge.

        Returns:
            str: Concatenated identity text, or empty string if none found.
        """
        result = subprocess.run(
            [self.psql, self.db, "-t", "-A", "-c",
             "SELECT content FROM startup ORDER BY priority, key;"],
            capture_output=True, text=True, timeout=3
        )
        return result.stdout.strip() if result.stdout.strip() else ""

    def search(self, query, n=5, category=None, full=False):
        """
        Perform hybrid FTS + vector search with RRF fusion.

        The search pipeline:
          1. Run FTS (tsvector/tsquery) → top 50 keyword matches
          2. Get embedding from Ollama → run pgvector cosine search → top 50 semantic matches
          3. Merge both lists using RRF (k=60)
          4. Return top N results

        We fetch 50 candidates from each leg (not just N) because RRF needs
        enough overlap between lists to produce meaningful fusion. If we only
        fetched 5 from each, a document at FTS #6 and vector #3 would be
        missed entirely — despite being highly relevant (appears in both).

        Args:
            query:    Search string (plain text, not SQL)
            n:        Number of results to return (default 5)
            category: Optional category filter (e.g., "contacts")
            full:     If True, return raw content; if False, return pyramid summary

        Returns:
            list[dict]: Ranked results, each with:
                {id, score, title, summary, cat, src, content}
        """
        # Escape single quotes for SQL string interpolation
        escaped_query = query.replace("'", "''")

        # Optional category filter
        where_category = f"AND category='{category}'" if category else ""

        # Exclude superseded and temporally expired records
        # superseded_by: record was replaced by a newer version (e.g., corrected data)
        # valid_to: record has a temporal expiry (e.g., event passed, state changed)
        where_active = "AND superseded_by IS NULL AND (valid_to IS NULL OR valid_to > now())"

        # Content field: pyramid (default, concise) or full raw content
        content_field = "content" if full else "COALESCE(content_pyramid,content)"

        # --- FTS leg ---
        # plainto_tsquery converts plain text to a tsquery (ANDs all terms, stems them)
        # ts_rank scores matches by term frequency and positional information
        # The fts column is a pre-computed tsvector with a GIN index
        fts_results = self._sql(
            f"SELECT id, left({content_field},800) as c, category as cat, title, "
            f"summary, source_file as src "
            f"FROM memories WHERE fts@@plainto_tsquery('english','{escaped_query}') {where_active} {where_category} "
            f"ORDER BY ts_rank(fts,plainto_tsquery('english','{escaped_query}')) DESC LIMIT 50"
        )

        # --- Vector leg ---
        # Skip entirely if embedding fails (graceful degradation to FTS-only)
        vector_results = []
        embedding = self._embed(query)
        if embedding:
            # Format as PostgreSQL vector literal: '[0.1,0.2,...,0.768]'
            embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"
            vector_results = self._sql(
                f"SELECT id, left({content_field},800) as c, category as cat, title, "
                f"summary, source_file as src "
                f"FROM memories WHERE embedding IS NOT NULL {where_active} {where_category} "
                f"ORDER BY embedding<=>'{embedding_str}'::vector LIMIT 50"
            )

        # --- RRF fusion ---
        return self._rrf(fts_results, vector_results, n)

    def _rrf(self, fts_results, vector_results, n, k=60):
        """
        Reciprocal Rank Fusion — merge two ranked lists into one.

        RRF is a score-agnostic fusion method. It doesn't care about the
        actual scores from FTS or vector search — only the rank positions.
        This is essential because:
          - FTS ts_rank returns floats (0.0-1.0 range, varies by query)
          - pgvector cosine distance returns floats (0.0-2.0 range)
          - These scales are incompatible — you can't average or weight them

        Instead, RRF assigns a contribution based on rank position:
          contribution = 1 / (k + rank + 1)

        Where k=60 is a smoothing constant from the original RRF paper
        (Cormack, Clarke, Buettcher, 2009). It prevents the top-ranked
        document from dominating — rank 0 gets 1/61 ≈ 0.0164, rank 1 gets
        1/62 ≈ 0.0161. The difference is smooth, not steep.

        A document appearing in BOTH lists gets contributions from both,
        naturally boosting it. This is the key insight: agreement between
        independent retrieval strategies is a strong relevance signal.

        Args:
            fts_results:    Ranked list from full-text search
            vector_results: Ranked list from vector search
            n:              Number of final results to return
            k:              Smoothing constant (default 60, standard in literature)

        Returns:
            list[dict]: Top N results sorted by RRF score (highest first)
        """
        scores = {}   # doc_id → cumulative RRF score
        cache = {}    # doc_id → result dict (for building output)

        # Score FTS results by rank position
        for rank, result in enumerate(fts_results):
            doc_id = str(result["id"])
            scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (k + rank + 1)
            cache[doc_id] = result

        # Score vector results by rank position
        # setdefault keeps the FTS version if we already have it
        for rank, result in enumerate(vector_results):
            doc_id = str(result["id"])
            scores[doc_id] = scores.get(doc_id, 0) + 1.0 / (k + rank + 1)
            cache.setdefault(doc_id, result)

        # Sort by cumulative score (highest = most relevant) and take top N
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

        # Build output in the standard result format
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
