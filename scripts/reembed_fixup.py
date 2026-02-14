#!/usr/bin/env python3
"""Fix up the ~200 records that failed due to token limits by truncating long content."""

import os
import sys
import psycopg2
from openai import OpenAI

sys.stdout.reconfigure(line_buffering=True)

MAX_CHARS = 28000  # ~7000 tokens, safely under 8192 limit
MODEL = "text-embedding-3-small"
DIMS = 768

def main():
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    conn = psycopg2.connect(dbname="shadow")
    conn.autocommit = False

    cur = conn.cursor()
    # Get records from the two failed batches (index 4000-4099 and 6800-6899 in the ordered list)
    # Easier: just find all records with NULL embedding
    cur.execute("SELECT id, content FROM memories WHERE content IS NOT NULL AND content != '' AND embedding IS NULL ORDER BY id")
    rows = cur.fetchall()
    
    if not rows:
        # Embeddings might not be NULL but stale — get records by offset
        # Re-fetch ordered IDs and pick the failed ranges
        cur.execute("SELECT id, content FROM memories WHERE content IS NOT NULL AND content != '' ORDER BY id")
        all_rows = cur.fetchall()
        rows = all_rows[4000:4100] + all_rows[6800:6900]
    
    total = len(rows)
    print(f"Fixing {total} records with truncation")

    updated = 0
    errors = 0

    # Process one at a time to isolate any remaining issues
    for rid, content in rows:
        truncated = content[:MAX_CHARS]
        try:
            resp = client.embeddings.create(model=MODEL, input=[truncated], dimensions=DIMS)
            emb = resp.data[0].embedding
            vec_str = "[" + ",".join(str(v) for v in emb) + "]"
            cur.execute("UPDATE memories SET embedding = %s WHERE id = %s", (vec_str, rid))
            conn.commit()
            updated += 1
        except Exception as e:
            conn.rollback()
            print(f"ERROR id={rid} len={len(content)}: {e}", file=sys.stderr)
            errors += 1

    conn.close()
    print(f"Done. Updated: {updated}, Errors: {errors}, Total: {total}")

if __name__ == "__main__":
    main()
