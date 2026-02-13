#!/usr/bin/env python3
"""ShadowDB PostgreSQL backend — hybrid vector + FTS search with RRF fusion."""
import json, subprocess, urllib.request

class PostgresBackend:
    def __init__(self, psql_path="/usr/bin/psql", database="shadow",
                 embedding_url="http://localhost:11434/api/embeddings",
                 embedding_model="nomic-embed-text"):
        self.psql = psql_path
        self.db = database
        self.embed_url = embedding_url
        self.embed_model = embedding_model

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

    def _sql(self, query):
        """Execute SQL and return parsed JSON rows."""
        wrapped = f"SELECT json_agg(row_to_json(sub)) FROM ({query}) sub;"
        r = subprocess.run(
            [self.psql, self.db, "-t", "-A", "-c", wrapped],
            capture_output=True, text=True, timeout=15
        )
        x = r.stdout.strip()
        return json.loads(x) if x and x != "null" else []

    def startup(self):
        """Return startup/identity rows."""
        r = subprocess.run(
            [self.psql, self.db, "-t", "-A", "-c",
             "SELECT content FROM startup ORDER BY key;"],
            capture_output=True, text=True, timeout=3
        )
        return r.stdout.strip() if r.stdout.strip() else ""

    def search(self, query, n=5, category=None, full=False):
        """Hybrid FTS + vector search with RRF fusion."""
        eq = query.replace("'", "''")
        w = f"AND category='{category}'" if category else ""
        cfull = "content" if full else "COALESCE(content_pyramid,content)"

        # Full-text search
        fts = self._sql(
            f"SELECT id, left({cfull},800) as c, category as cat, title, "
            f"summary, source_file as src "
            f"FROM memories WHERE fts@@plainto_tsquery('english','{eq}') {w} "
            f"ORDER BY ts_rank(fts,plainto_tsquery('english','{eq}')) DESC LIMIT 50"
        )

        # Vector search
        vec = []
        e = self._embed(query)
        if e:
            es = "[" + ",".join(str(x) for x in e) + "]"
            vec = self._sql(
                f"SELECT id, left({cfull},800) as c, category as cat, title, "
                f"summary, source_file as src "
                f"FROM memories WHERE embedding IS NOT NULL {w} "
                f"ORDER BY embedding<=>'{es}'::vector LIMIT 50"
            )

        # RRF fusion (k=60)
        return self._rrf(fts, vec, n)

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
