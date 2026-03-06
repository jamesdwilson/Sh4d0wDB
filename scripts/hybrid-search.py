#!/usr/bin/env python3
"""
hybrid-search.py — Hybrid search over Shadow PG memories.
Combines: SQL metadata filters + PostgreSQL FTS + pgvector semantic search + RRF fusion.

Usage:
    python3 scripts/hybrid-search.py "query" [-n 5] [--category cat] [--tags tag1,tag2] [--json]
"""

import argparse
import json
import subprocess
import sys

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
DB = "shadow"

def get_embedding(text: str) -> list[float]:
    """Get embedding from Ollama nomic-embed-text."""
    import urllib.request
    req = urllib.request.Request(
        "http://localhost:11434/api/embeddings",
        data=json.dumps({"model": "nomic-embed-text", "prompt": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())["embedding"]
    except Exception:
        return None


def hybrid_search(query: str, n: int = 5, category: str = None, tags: list = None, as_json: bool = False):
    """
    Three-stage hybrid search:
    1. FTS (BM25-like via ts_rank) — keyword precision
    2. Vector similarity (pgvector cosine) — semantic recall
    3. RRF fusion of both ranked lists
    """
    embedding = get_embedding(query)

    # Build WHERE clause for metadata filters
    where_parts = []
    if category:
        where_parts.append(f"category = '{category}'")
    if tags:
        tag_array = ",".join(f"'{t}'" for t in tags)
        where_parts.append(f"tags && ARRAY[{tag_array}]")
    where_clause = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # FTS query
    escaped_q = query.replace("'", "''")
    fts_sql = f"""
    SELECT id, left(content, 1000) as content, category, tags::text, source_file,
           ts_rank(fts, plainto_tsquery('english', '{escaped_q}')) as fts_score
    FROM memories
    {where_clause}
    {"AND" if where_parts else "WHERE"} fts @@ plainto_tsquery('english', '{escaped_q}')
    ORDER BY fts_score DESC
    LIMIT 50;
    """

    # Vector query (only if embedding succeeded)
    vec_sql = None
    if embedding:
        emb_str = "[" + ",".join(str(x) for x in embedding) + "]"
        vec_sql = f"""
        SELECT id, left(content, 1000) as content, category, tags::text, source_file,
               1 - (embedding <=> '{emb_str}'::vector) as vec_score
        FROM memories
        {where_clause}
        {"AND" if where_parts else "WHERE"} embedding IS NOT NULL
        ORDER BY embedding <=> '{emb_str}'::vector
        LIMIT 50;
        """

    # Execute queries
    fts_results = run_sql(fts_sql)
    vec_results = run_sql(vec_sql) if vec_sql else []

    # RRF fusion (k=60 is standard)
    k = 60
    scores = {}
    content_map = {}

    for rank, row in enumerate(fts_results):
        rid = str(row["id"])
        scores[rid] = scores.get(rid, 0) + 1.0 / (k + rank + 1)
        content_map[rid] = row

    for rank, row in enumerate(vec_results):
        rid = str(row["id"])
        scores[rid] = scores.get(rid, 0) + 1.0 / (k + rank + 1)
        if rid not in content_map:
            content_map[rid] = row

    # Sort by fused score
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

    results = []
    for rid, score in ranked:
        row = content_map[rid]
        results.append({
            "id": rid,
            "score": round(score, 6),
            "category": row.get("category", ""),
            "tags": row.get("tags", ""),
            "source_file": row.get("source_file", ""),
            "content": row["content"][:500],
            "fts_hit": rid in {str(r["id"]) for r in fts_results},
            "vec_hit": rid in {str(r["id"]) for r in vec_results},
        })

    if as_json:
        print(json.dumps(results, indent=2))
    else:
        for i, r in enumerate(results):
            methods = []
            if r["fts_hit"]: methods.append("FTS")
            if r["vec_hit"]: methods.append("VEC")
            print(f"\n{'─'*60}")
            print(f"  #{i+1}  {r['source_file']}  score: {r['score']}  [{'+'.join(methods)}]")
            print(f"  category: {r['category']}  tags: {r['tags']}")
            print(f"{'─'*60}")
            print(r["content"])

    return results


def run_sql(sql: str) -> list[dict]:
    """Execute SQL via psql JSON output for reliable parsing."""
    if not sql:
        return []
    # Wrap query to return JSON
    json_sql = f"SELECT json_agg(t) FROM ({sql.strip().rstrip(';')}) t;"
    cmd = [PSQL, DB, "-t", "-A", "-c", json_sql]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            print(f"SQL error: {result.stderr[:200]}", file=sys.stderr)
            return []
        raw = result.stdout.strip()
        if not raw or raw == "null" or raw == "":
            return []
        rows = json.loads(raw)
        # Normalize key names (score fields vary)
        for row in rows:
            for key in ["fts_score", "vec_score"]:
                if key in row:
                    row["score"] = row[key]
        return rows
    except Exception:
        return []


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hybrid search over Shadow PG memories")
    parser.add_argument("query", help="Search query")
    parser.add_argument("-n", type=int, default=5, help="Number of results")
    parser.add_argument("--category", help="Filter by category")
    parser.add_argument("--tags", help="Filter by tags (comma-separated)")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    tags = args.tags.split(",") if args.tags else None
    hybrid_search(args.query, n=args.n, category=args.category, tags=tags, as_json=args.json)
