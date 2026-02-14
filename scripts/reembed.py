#!/usr/bin/env python3
"""Re-embed all memories with text-embedding-3-small at 768 dimensions."""

import os
import sys
import time
import psycopg2
from openai import OpenAI

# Force unbuffered output
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

BATCH_SIZE = 100
MODEL = "text-embedding-3-small"
DIMS = 768

def main():
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    conn = psycopg2.connect(dbname="shadow")
    conn.autocommit = False

    # Fetch all records with non-empty content
    cur = conn.cursor()
    cur.execute("SELECT id, content FROM memories WHERE content IS NOT NULL AND content != '' ORDER BY id")
    rows = cur.fetchall()
    total = len(rows)
    print(f"Fetched {total} records to re-embed")

    updated = 0
    errors = 0

    for i in range(0, total, BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        ids = [r[0] for r in batch]
        texts = [r[1] for r in batch]

        try:
            resp = client.embeddings.create(model=MODEL, input=texts, dimensions=DIMS)
            embeddings = [e.embedding for e in resp.data]

            update_cur = conn.cursor()
            for rid, emb in zip(ids, embeddings):
                vec_str = "[" + ",".join(str(v) for v in emb) + "]"
                update_cur.execute("UPDATE memories SET embedding = %s WHERE id = %s", (vec_str, rid))
            conn.commit()
            updated += len(batch)
        except Exception as e:
            conn.rollback()
            print(f"ERROR at batch starting index {i}: {e}", file=sys.stderr)
            errors += len(batch)

        if updated % 500 < BATCH_SIZE and updated > 0:
            print(f"  Progress: {updated}/{total} updated")

        # Small delay to respect rate limits
        time.sleep(0.2)

    cur.close()
    conn.close()
    print(f"\nDone. Updated: {updated}, Errors: {errors}, Total: {total}")

if __name__ == "__main__":
    main()
