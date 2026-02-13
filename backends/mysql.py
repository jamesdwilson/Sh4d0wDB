#!/usr/bin/env python3
"""ShadowDB MySQL/MariaDB backend — FULLTEXT search with optional external vector.

Uses MySQL's built-in FULLTEXT indexes (InnoDB, available since MySQL 5.6+).
No native vector search — falls back to FTS-only by default.
Optional: pair with an external vector store or use MariaDB 11.6+ vector type.

Schema:
  CREATE TABLE startup (
    `key` VARCHAR(64) PRIMARY KEY,
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

Requirements:
  pip install mysql-connector-python
  (or: pip install PyMySQL)
"""
import json, urllib.request

class MySQLBackend:
    def __init__(self, host="localhost", port=3306, user="root",
                 password="", database="shadow",
                 embedding_url="http://localhost:11434/api/embeddings",
                 embedding_model="nomic-embed-text"):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.database = database
        self.embed_url = embedding_url
        self.embed_model = embedding_model
        self._connector = None

    def _connect(self):
        """Connect using mysql-connector-python or PyMySQL."""
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
                        "Install mysql-connector-python or PyMySQL: "
                        "pip install mysql-connector-python"
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
                cursorclass=pymysql.cursors.DictCursor
            )

    def _query(self, sql, params=None):
        """Execute query and return list of dicts."""
        conn = self._connect()
        try:
            cur = conn.cursor(dictionary=True) if self._connector == "mysql-connector" else conn.cursor()
            cur.execute(sql, params or ())
            rows = cur.fetchall()
            cur.close()
            return rows
        finally:
            conn.close()

    def _embed(self, text):
        """Get embedding vector from Ollama."""
        try:
            req = urllib.request.Request(
                self.embed_url,
                json.dumps({"model": self.embed_model, "prompt": text}).encode(),
                {"Content-Type": "application/json"}
            )
            resp = urllib.request.urlopen(req, timeout=8)
            return json.loads(resp.read())["embedding"]
        except:
            return None

    def startup(self):
        """Return startup/identity rows."""
        try:
            rows = self._query(
                "SELECT content FROM startup ORDER BY `key`"
            )
            return "\n".join(r["content"] for r in rows if r.get("content"))
        except:
            return ""

    def search(self, query, n=5, category=None, full=False):
        """FULLTEXT search with MATCH...AGAINST in natural language mode."""
        cfull = "content" if full else "COALESCE(content_pyramid, content)"
        cat_clause = "AND category = %s" if category else ""
        params = [query] + ([category] if category else [])

        # MySQL FULLTEXT — natural language mode returns relevance score
        sql = f"""
            SELECT id,
                   LEFT({cfull}, 800) as c,
                   category as cat,
                   title,
                   summary,
                   source_file as src,
                   MATCH(title, summary, content, content_pyramid)
                     AGAINST(%s IN NATURAL LANGUAGE MODE) as score
            FROM memories
            WHERE MATCH(title, summary, content, content_pyramid)
                    AGAINST(%s IN NATURAL LANGUAGE MODE)
            {cat_clause}
            ORDER BY score DESC
            LIMIT %s
        """
        params_full = [query, query] + ([category] if category else []) + [n]

        try:
            rows = self._query(sql, params_full)
        except Exception as e:
            # Fallback: LIKE-based search if FULLTEXT not available
            rows = self._like_fallback(query, n, category, cfull)

        results = []
        for r in rows:
            results.append({
                "id": r.get("id", 0),
                "score": round(float(r.get("score", 0)), 6),
                "title": r.get("title", ""),
                "summary": r.get("summary", ""),
                "cat": r.get("cat", ""),
                "src": r.get("src", ""),
                "content": r.get("c", "")
            })
        return results

    def _like_fallback(self, query, n, category, cfull):
        """Fallback LIKE search when FULLTEXT index isn't available."""
        cat_clause = "AND category = %s" if category else ""
        params = [f"%{query}%", f"%{query}%", f"%{query}%"] + ([category] if category else []) + [n]
        sql = f"""
            SELECT id,
                   LEFT({cfull}, 800) as c,
                   category as cat,
                   title,
                   summary,
                   source_file as src,
                   1.0 as score
            FROM memories
            WHERE (title LIKE %s OR content LIKE %s OR summary LIKE %s)
            {cat_clause}
            LIMIT %s
        """
        return self._query(sql, params)
