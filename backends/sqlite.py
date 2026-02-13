#!/usr/bin/env python3
"""ShadowDB SQLite backend — portable single-file memory search.

Uses sqlite-vec for vector search (or falls back to FTS-only).
Zero external dependencies beyond Python stdlib + optional sqlite-vec.

Schema:
  CREATE TABLE startup (key TEXT PRIMARY KEY, content TEXT);
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    content TEXT,
    content_pyramid TEXT,
    category TEXT,
    title TEXT,
    summary TEXT,
    source_file TEXT,
    embedding BLOB,       -- raw float32 bytes for sqlite-vec
    fts_content TEXT       -- indexed by FTS5
  );
  CREATE VIRTUAL TABLE memories_fts USING fts5(fts_content, content='memories', content_rowid='id');
"""
import json, sqlite3, struct, urllib.request

class SQLiteBackend:
    def __init__(self, db_path="shadow.db",
                 embedding_url="http://localhost:11434/api/embeddings",
                 embedding_model="nomic-embed-text"):
        self.db_path = db_path
        self.embed_url = embedding_url
        self.embed_model = embedding_model
        self._vec_available = None

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        # Try loading sqlite-vec extension
        if self._vec_available is None:
            try:
                conn.enable_load_extension(True)
                conn.load_extension("vec0")
                self._vec_available = True
            except:
                self._vec_available = False
        return conn

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

    def _vec_to_bytes(self, vec):
        """Convert float list to raw bytes for sqlite-vec."""
        return struct.pack(f'{len(vec)}f', *vec)

    def startup(self):
        """Return startup/identity rows."""
        conn = self._connect()
        try:
            rows = conn.execute("SELECT content FROM startup ORDER BY key").fetchall()
            return "\n".join(r["content"] for r in rows if r["content"])
        except:
            return ""
        finally:
            conn.close()

    def search(self, query, n=5, category=None, full=False):
        """FTS5 search with optional vector reranking."""
        conn = self._connect()
        try:
            cfull = "content" if full else "COALESCE(content_pyramid, content)"
            w = f"AND m.category = ?" if category else ""
            params = [query] + ([category] if category else [])

            # FTS5 search
            fts = conn.execute(
                f"SELECT m.id, substr({cfull}, 1, 800) as c, m.category as cat, "
                f"m.title, m.summary, m.source_file as src, "
                f"rank as score "
                f"FROM memories_fts f "
                f"JOIN memories m ON m.id = f.rowid "
                f"WHERE memories_fts MATCH ? {w} "
                f"ORDER BY rank LIMIT 50",
                params
            ).fetchall()

            fts = [dict(r) for r in fts]

            # Vector search (if sqlite-vec available)
            vec = []
            if self._vec_available:
                e = self._embed(query)
                if e:
                    vec_bytes = self._vec_to_bytes(e)
                    vec = conn.execute(
                        f"SELECT m.id, substr({cfull}, 1, 800) as c, m.category as cat, "
                        f"m.title, m.summary, m.source_file as src, "
                        f"v.distance as score "
                        f"FROM vec_memories v "
                        f"JOIN memories m ON m.id = v.rowid "
                        f"WHERE v.embedding MATCH ? "
                        f"ORDER BY v.distance LIMIT 50",
                        [vec_bytes]
                    ).fetchall()
                    vec = [dict(r) for r in vec]

            return self._rrf(fts, vec, n)
        finally:
            conn.close()

    def _rrf(self, fts, vec, n, k=60):
        """Reciprocal Rank Fusion."""
        scores = {}
        cache = {}
        for i, r in enumerate(fts):
            rid = str(r["id"])
            scores[rid] = scores.get(rid, 0) + 1.0 / (k + i + 1)
            cache[rid] = r
        for i, r in enumerate(vec):
            rid = str(r["id"])
            scores[rid] = scores.get(rid, 0) + 1.0 / (k + i + 1)
            cache.setdefault(rid, r)

        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]
        results = []
        for rid, sc in ranked:
            r = cache[rid]
            results.append({
                "id": r["id"], "score": round(sc, 6),
                "title": r.get("title", ""), "summary": r.get("summary", ""),
                "cat": r.get("cat", ""), "src": r.get("src", ""),
                "content": r["c"]
            })
        return results
