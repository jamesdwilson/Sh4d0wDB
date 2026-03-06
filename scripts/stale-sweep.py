#!/usr/bin/env python3
"""stale-sweep — find and flag stale state/event records in Shadow DB.
Zero LLM. Pure heuristics. Run via cron every 6h.

Rules:
- state records not accessed in 14 days → flag stale
- event records with date-relative language older than 7 days → flag stale  
- records with superseded_by already set → skip
- records with valid_to already set → skip
"""
import subprocess, json, re, sys
from datetime import datetime, timedelta, timezone

P = "/opt/homebrew/opt/postgresql@17/bin/psql"
D = "shadow"

def sql(q):
    r = subprocess.run([P, D, "-t", "-A", "-c", q], capture_output=True, text=True, timeout=15)
    return r.stdout.strip()

def sql_json(q):
    r = sql(f"SELECT json_agg(row_to_json(sub)) FROM ({q}) sub;")
    return json.loads(r) if r and r != "null" else []

now = datetime.now(timezone.utc)

# 1. Find state-like records not accessed in 14+ days
stale_states = sql_json("""
    SELECT id, LEFT(content, 200) as preview, category, last_accessed, created_at
    FROM memories 
    WHERE superseded_by IS NULL 
      AND valid_to IS NULL
      AND (record_type = 'state' OR content ~* '(on order|pending|waiting|scheduled for|arriving|due|need to|should|todo|to.do)')
      AND last_accessed < now() - interval '14 days'
      AND created_at < now() - interval '14 days'
    ORDER BY last_accessed ASC
    LIMIT 50
""")

# 2. Find event records with rotted date-relative language
stale_events = sql_json("""
    SELECT id, LEFT(content, 200) as preview, category, created_at
    FROM memories
    WHERE superseded_by IS NULL
      AND valid_to IS NULL  
      AND content ~* '(tomorrow|today|tonight|this morning|this afternoon|this evening|this week|next monday|next tuesday|next wednesday|next thursday|next friday)'
      AND created_at < now() - interval '7 days'
    ORDER BY created_at ASC
    LIMIT 50
""")

flagged = 0

# Flag stale states
for r in stale_states:
    rid = r['id']
    # Set valid_to to now, mark confidence low
    sql(f"UPDATE memories SET valid_to = now(), confidence = 0.3, record_type = 'state' WHERE id = {rid}")
    flagged += 1

# Flag stale events  
for r in stale_events:
    rid = r['id']
    sql(f"UPDATE memories SET valid_to = now(), confidence = 0.3, record_type = 'event' WHERE id = {rid}")
    flagged += 1

if flagged > 0:
    print(f"Flagged {flagged} stale records ({len(stale_states)} states, {len(stale_events)} events)")
    # Log to PG
    sql(f"""INSERT INTO memories (content, category, tags, source_file, title) 
        VALUES ('Stale sweep: flagged {flagged} records ({len(stale_states)} states, {len(stale_events)} events) at {now.isoformat()}', 
        'audit', ARRAY['stale-sweep','cron','auto'], 'cron:stale-sweep', 
        'Stale Sweep — ' || to_char(now() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD'))""")
else:
    print("No stale records found")
