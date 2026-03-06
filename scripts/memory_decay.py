#!/usr/bin/env python3
"""memory_decay.py — Apply relevance decay, auto-summarize old files, generate curated fact list.

Usage:
    python3 scripts/memory_decay.py [--update] [--archive] [--curate] [--verbose]
"""

import argparse
import json
import math
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

WORKSPACE = Path(os.environ.get('OPENCLAW_WORKSPACE', os.path.expanduser('~/.openclaw/workspace')))
MEMORY_DIR = WORKSPACE / "memory"
DB_PATH = MEMORY_DIR / ".search" / "memory.db"
OVERFLOW_DIR = MEMORY_DIR / "overflow"

# Decay rates by category (per day)
DECAY_RATES = {
    "identity": 0.995,
    "preference": 0.99,
    "relationship": 0.99,
    "contact": 0.99,
    "project": 0.97,
    "technical": 0.97,
    "general": 0.96,
    "event": 0.95,
}

def get_db():
    if not DB_PATH.exists():
        print("Error: memory.db not found. Run memory_index.py first.", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def init_access_log(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS access_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fact_id INTEGER NOT NULL,
            accessed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_access_log_fact ON access_log(fact_id);
    """)
    conn.commit()

def update_decay_scores(conn, verbose=False):
    """Recalculate decay scores for all facts."""
    now = datetime.now()
    facts = conn.execute("SELECT id, date_learned, date_last_confirmed, category, confidence FROM facts WHERE deleted=0").fetchall()

    updated = 0
    for fact in facts:
        # Days since learned
        try:
            learned = datetime.strptime(fact['date_learned'], '%Y-%m-%d')
        except:
            learned = now
        days_old = max((now - learned).days, 0)

        # Days since last confirmed
        try:
            confirmed = datetime.strptime(fact['date_last_confirmed'], '%Y-%m-%d')
        except:
            confirmed = learned
        days_since_confirmed = max((now - confirmed).days, 0)

        # Base decay
        rate = DECAY_RATES.get(fact['category'], 0.96)
        base_decay = rate ** days_old

        # Confirmation boost — reset decay partially
        if days_since_confirmed < days_old:
            confirmation_boost = rate ** days_since_confirmed
            base_decay = max(base_decay, confirmation_boost * 0.8)

        # Access frequency boost
        access_count = conn.execute(
            "SELECT COUNT(*) as c FROM access_log WHERE fact_id=? AND accessed_at > ?",
            (fact['id'], (now - timedelta(days=7)).isoformat())
        ).fetchone()['c']
        access_boost = min(1.0, 0.1 * access_count)

        decay_score = min(1.0, base_decay + access_boost)
        decay_score = round(decay_score, 6)

        conn.execute("UPDATE facts SET decay_score=? WHERE id=?", (decay_score, fact['id']))
        updated += 1

    conn.commit()
    if verbose:
        print(f"Updated decay scores for {updated} facts")
    return updated

def archive_old_daily_files(conn, days_threshold=7, verbose=False):
    """Archive daily files older than threshold."""
    OVERFLOW_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    cutoff = (now - timedelta(days=days_threshold)).strftime('%Y-%m-%d')

    archived = 0
    for f in sorted(MEMORY_DIR.glob("*.md")):
        m = re.match(r'(\d{4}-\d{2}-\d{2})\.md', f.name)
        if not m:
            continue
        date = m.group(1)
        if date >= cutoff:
            continue

        # Check if facts were extracted
        rel_path = str(f.relative_to(WORKSPACE))
        fact_count = conn.execute(
            "SELECT COUNT(*) as c FROM facts WHERE source_file=? AND deleted=0", (rel_path,)
        ).fetchone()['c']

        if fact_count == 0:
            if verbose:
                print(f"  Warning: {f.name} has no extracted facts yet, skipping archive")
            continue

        # Move to overflow
        dest = OVERFLOW_DIR / f.name
        if not dest.exists():
            shutil.move(str(f), str(dest))
            archived += 1
            if verbose:
                print(f"  Archived: {f.name} ({fact_count} facts extracted)")

    if verbose or archived > 0:
        print(f"Archived {archived} daily files to overflow/")
    return archived

def generate_curated_facts(conn, limit=50, verbose=False):
    """Generate ranked list of top facts for MEMORY.md replacement."""
    facts = conn.execute("""
        SELECT id, subject, predicate, object, category, decay_score, confidence, date_learned
        FROM facts
        WHERE deleted=0
        ORDER BY decay_score * confidence DESC
        LIMIT ?
    """, (limit,)).fetchall()

    output = "# Auto-Curated Top Facts\n\n"
    output += f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*\n\n"

    categories = {}
    for f in facts:
        cat = f['category']
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(f)

    for cat in sorted(categories.keys()):
        output += f"## {cat.title()}\n\n"
        for f in categories[cat]:
            score = round(f['decay_score'] * f['confidence'], 3)
            output += f"- {f['subject']} {f['predicate']} {f['object']} (score: {score})\n"
        output += "\n"

    curated_path = MEMORY_DIR / "projects" / "curated-facts.md"
    curated_path.write_text(output)
    if verbose:
        print(f"Wrote {len(facts)} curated facts to {curated_path}")
    return len(facts)

def show_stats(conn):
    """Show decay statistics."""
    total = conn.execute("SELECT COUNT(*) as c FROM facts WHERE deleted=0").fetchone()['c']
    if total == 0:
        print("No facts in database.")
        return

    buckets = {
        "Fresh (>0.8)": conn.execute("SELECT COUNT(*) as c FROM facts WHERE deleted=0 AND decay_score > 0.8").fetchone()['c'],
        "Active (0.5-0.8)": conn.execute("SELECT COUNT(*) as c FROM facts WHERE deleted=0 AND decay_score BETWEEN 0.5 AND 0.8").fetchone()['c'],
        "Fading (0.2-0.5)": conn.execute("SELECT COUNT(*) as c FROM facts WHERE deleted=0 AND decay_score BETWEEN 0.2 AND 0.5").fetchone()['c'],
        "Stale (<0.2)": conn.execute("SELECT COUNT(*) as c FROM facts WHERE deleted=0 AND decay_score < 0.2").fetchone()['c'],
    }

    print(f"\nDecay Statistics ({total} total facts):")
    for label, count in buckets.items():
        pct = round(100 * count / total, 1) if total else 0
        bar = "█" * int(pct / 2)
        print(f"  {label:20s} {count:4d} ({pct:5.1f}%) {bar}")

def main():
    parser = argparse.ArgumentParser(description="Apply relevance decay to memory facts")
    parser.add_argument("--update", "-u", action="store_true", help="Update decay scores")
    parser.add_argument("--archive", "-a", action="store_true", help="Archive old daily files")
    parser.add_argument("--curate", "-c", action="store_true", help="Generate curated facts list")
    parser.add_argument("--stats", "-s", action="store_true", help="Show decay statistics")
    parser.add_argument("--all", action="store_true", help="Run all operations")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    args = parser.parse_args()

    if not any([args.update, args.archive, args.curate, args.stats, args.all]):
        args.all = True

    conn = get_db()
    init_access_log(conn)

    if args.update or args.all:
        update_decay_scores(conn, args.verbose)

    if args.archive or args.all:
        archive_old_daily_files(conn, verbose=args.verbose)

    if args.curate or args.all:
        generate_curated_facts(conn, verbose=args.verbose)

    if args.stats or args.all:
        show_stats(conn)

    conn.close()

if __name__ == "__main__":
    main()
