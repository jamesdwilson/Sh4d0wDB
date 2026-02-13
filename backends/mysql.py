#!/usr/bin/env python3
"""
ShadowDB MySQL/MariaDB Backend — FULLTEXT Search
==================================================

This backend uses MySQL's built-in FULLTEXT indexes for keyword search.
It's the simplest backend in terms of search capability — no vector search,
no RRF fusion, just keyword matching with MySQL's natural language mode.

WHEN TO USE MYSQL:
  - You already have a MySQL/MariaDB server running
  - You want SQL-based memory storage without installing PostgreSQL
  - Your queries are primarily keyword-based (names, dates, terms)
  - You don't need semantic/conceptual search

LIMITATIONS:
  - No native vector search (MySQL has no equivalent of pgvector)
  - FULLTEXT natural language mode has a 50% threshold: words appearing
    in more than 50% of rows are considered too common and ignored.
    This can be surprising with small datasets.
  - No RRF fusion (only one search strategy available)
  - Boolean mode is available but has quirky syntax (+ - * operators)

TO ADD VECTOR SEARCH:
  Pair MySQL with an external vector store (Milvus, Pinecone, Weaviate)
  or wait for MariaDB 11.6+ which adds a native VECTOR column type.
  The embedding infrastructure (_embed method) is already here — you'd
  just need to add the vector storage and search queries.

CONNECTOR SUPPORT:
  This backend supports two MySQL Python drivers:
    1. mysql-connector-python (Oracle's official driver)
    2. PyMySQL (pure Python, lighter weight)
  It auto-detects which is installed and uses it. If neither is found,
  it raises a helpful ImportError with install instructions.

SCHEMA:
  CREATE TABLE startup (
      `key` VARCHAR(64) PRIMARY KEY,   -- backtick because KEY is reserved
      content TEXT
  ) ENGINE=InnoDB;

  CREATE TABLE memories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      content TEXT,
      content_pyramid TEXT,
      category VARCHAR(64),
      title VARCHAR(255),
      summary TEXT,
      source_file VARCHAR(512),
      FULLTEXT idx_fts (title, summary, content, content_pyramid)
  ) ENGINE=InnoDB;

  NOTE: The FULLTEXT index spans ALL four text columns. This means a
  search for "Watson" matches against titles, summaries, content, and
  pyramid summaries simultaneously. MySQL handles the relevance scoring
  across all columns in MATCH...AGAINST.

REQUIREMENTS:
  pip install mysql-connector-python   # Option A (Oracle driver)
  pip install PyMySQL                  # Option B (pure Python)
"""

import json
import urllib.request


class MySQLBackend:
    """
    MySQL/MariaDB backend using FULLTEXT search.

    Usage:
        backend = MySQLBackend(
            host="localhost", database="myagent",
            user="myuser", password="mypass"
        )
        print(backend.startup())
        results = backend.search("Watson")
    """

    def __init__(self, host="localhost", port=3306, user=None,
                 password="", database=None,
                 embedding_url="http://localhost:11434/api/embeddings",
                 embedding_model="nomic-embed-text"):
        """
        Initialize the MySQL backend.

        Args:
            host:            MySQL server hostname (default localhost)
            port:            MySQL server port (default 3306)
            user:            MySQL username (required — no default)
            password:        MySQL password (default empty)
            database:        Database name (required — no default)
            embedding_url:   Ollama API endpoint (for future vector support)
            embedding_model: Ollama model name (for future vector support)
        """
        if not database:
            raise ValueError("MySQLBackend requires 'database' — set mysql.database in ~/.shadowdb.json")
        if not user:
            raise ValueError("MySQLBackend requires 'user' — set mysql.user in ~/.shadowdb.json")
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.database = database
        self.embed_url = embedding_url
        self.embed_model = embedding_model

        # Which MySQL driver is available — detected on first connection.
        # None means "haven't checked yet".
        self._connector = None

    def _connect(self):
        """
        Open a MySQL connection using whichever driver is available.

        We support two drivers to maximize compatibility:
          1. mysql-connector-python — Oracle's official driver, more features
          2. PyMySQL — pure Python, lighter weight, easier to install

        The driver is auto-detected on the first call. Subsequent calls
        reuse the detection result (stored in self._connector).

        WHY NOT CONNECTION POOLING?
          Same rationale as the PostgreSQL backend: each search is one query,
          calls are seconds apart, and the overhead of opening a connection
          (~5ms for local MySQL) is negligible for our use case.

        Returns:
            A MySQL connection object (from whichever driver is available).

        Raises:
            ImportError: If neither mysql-connector-python nor PyMySQL is installed.
        """
        if self._connector is None:
            try:
                import mysql.connector
                self._connector = "mysql-connector"
            except ImportError:
                try:
                    import pymysql
                    self._connector = "pymysql"
                except ImportError:
                    raise ImportError(
                        "No MySQL driver found. Install one:\n"
                        "  pip install mysql-connector-python\n"
                        "  pip install PyMySQL"
                    )

        if self._connector == "mysql-connector":
            import mysql.connector
            return mysql.connector.connect(
                host=self.host, port=self.port,
                user=self.user, password=self.password,
                database=self.database
            )
        else:
            import pymysql
            return pymysql.connect(
                host=self.host, port=self.port,
                user=self.user, password=self.password,
                database=self.database,
                # DictCursor makes rows behave like dicts (access by column name)
                cursorclass=pymysql.cursors.DictCursor
            )

    def _query(self, sql, params=None):
        """
        Execute a SQL query and return results as a list of dictionaries.

        Uses parameterized queries (%s placeholders) for safety against SQL
        injection. This is different from the PostgreSQL backend (which uses
        string interpolation with psql subprocess) because we have a proper
        database driver with parameter binding.

        Args:
            sql:    SQL query string with %s placeholders
            params: Tuple of parameter values to bind

        Returns:
            list[dict]: Query results as dictionaries.
        """
        conn = self._connect()
        try:
            # mysql-connector uses dictionary=True for dict rows
            # PyMySQL already uses DictCursor from the connection config
            if self._connector == "mysql-connector":
                cursor = conn.cursor(dictionary=True)
            else:
                cursor = conn.cursor()

            cursor.execute(sql, params or ())
            rows = cursor.fetchall()
            cursor.close()
            return rows
        finally:
            conn.close()

    def _embed(self, text):
        """
        Get an embedding vector from Ollama.

        Currently unused by the search pipeline (MySQL has no native vector
        search), but included for forward compatibility. When MySQL adds
        vector support or when paired with an external vector store, this
        method is ready to use.

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

    def startup(self):
        """
        Return the agent's identity text from the startup table.

        Note: The `key` column name requires backticks in MySQL because
        KEY is a reserved word. The schema uses VARCHAR(64) for the key
        and TEXT for content.

        Returns:
            str: Concatenated identity text, or empty string if none found.
        """
        try:
            rows = self._query(
                "SELECT content FROM startup ORDER BY `key`"
            )
            return "\n".join(r["content"] for r in rows if r.get("content"))
        except Exception:
            return ""

    def search(self, query, n=5, category=None, full=False):
        """
        FULLTEXT search using MATCH...AGAINST in natural language mode.

        MySQL's FULLTEXT natural language mode:
          - Automatically handles stemming (basic, less sophisticated than PG)
          - Returns a relevance score (float, higher = more relevant)
          - Has a 50% threshold: words in >50% of rows are ignored
          - Searches across all columns in the FULLTEXT index simultaneously

        The query appears TWICE in the SQL:
          - Once in the SELECT clause (to get the relevance score)
          - Once in the WHERE clause (to filter matching rows)
        This is MySQL's FULLTEXT syntax requirement — MATCH must appear in
        both places.

        Falls back to LIKE-based search if FULLTEXT index is missing or the
        query triggers a MySQL error (e.g., all words below minimum length).

        Args:
            query:    Search string
            n:        Number of results
            category: Optional category filter
            full:     If True, return raw content instead of pyramid

        Returns:
            list[dict]: Ranked results in standard format.
        """
        content_field = "content" if full else "COALESCE(content_pyramid, content)"

        # Build the category filter clause (parameterized)
        category_clause = "AND category = %s" if category else ""

        # Parameters: query appears twice (SELECT and WHERE) + optional category + limit
        params = [query, query] + ([category] if category else []) + [n]

        # MySQL FULLTEXT query — natural language mode
        sql = f"""
            SELECT id,
                   LEFT({content_field}, 800) as c,
                   category as cat,
                   title,
                   summary,
                   source_file as src,
                   MATCH(title, summary, content, content_pyramid)
                     AGAINST(%s IN NATURAL LANGUAGE MODE) as score
            FROM memories
            WHERE MATCH(title, summary, content, content_pyramid)
                    AGAINST(%s IN NATURAL LANGUAGE MODE)
            {category_clause}
            ORDER BY score DESC
            LIMIT %s
        """

        try:
            rows = self._query(sql, params)
        except Exception:
            # FULLTEXT might not be available (missing index, MySQL version,
            # or all query words are too short/common). Fall back to LIKE.
            rows = self._like_fallback(query, n, category, content_field)

        # Convert to standard result format
        results = []
        for row in rows:
            results.append({
                "id": row.get("id", 0),
                "score": round(float(row.get("score", 0)), 6),
                "title": row.get("title", ""),
                "summary": row.get("summary", ""),
                "cat": row.get("cat", ""),
                "src": row.get("src", ""),
                "content": row.get("c", "")
            })
        return results

    def _like_fallback(self, query, n, category, content_field):
        """
        Fallback LIKE-based search when FULLTEXT is unavailable.

        LIKE %query% is a sequential scan — it's slow on large tables but
        always works regardless of index availability. This is the last-resort
        search strategy.

        All matches get a score of 1.0 (we can't rank by relevance with LIKE).
        Results are in insertion order, not relevance order.

        Args:
            query:         Search string
            n:             Max results
            category:      Optional category filter
            content_field: SQL expression for the content column

        Returns:
            list[dict]: Unranked matching rows.
        """
        category_clause = "AND category = %s" if category else ""
        params = (
            [f"%{query}%", f"%{query}%", f"%{query}%"] +
            ([category] if category else []) +
            [n]
        )
        sql = f"""
            SELECT id,
                   LEFT({content_field}, 800) as c,
                   category as cat,
                   title,
                   summary,
                   source_file as src,
                   1.0 as score
            FROM memories
            WHERE (title LIKE %s OR content LIKE %s OR summary LIKE %s)
            {category_clause}
            LIMIT %s
        """
        return self._query(sql, params)
