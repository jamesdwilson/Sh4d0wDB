#!/usr/bin/env python3
"""
Daily DB Health Check
Compares current state against known good baseline.

Configuration via environment variables:
    SHADOWDB_NAME     Database name (default: shadow)
    SHADOWDB_HOST     Database host (default: localhost)
    SHADOWDB_PORT     Database port (default: 5432)
    SHADOWDB_USER     Database user (default: current OS user)
    SHADOWDB_WORKSPACE  Workspace directory for baseline/graph files
                        (default: ~/.openclaw/workspace)

Usage:
    python3 db-health-check.py --baseline  # Create baseline
    python3 db-health-check.py --check     # Daily check
    python3 db-health-check.py --cron      # For cron (exits 1 on failure)
"""

import subprocess
import json
import sys
import os
from datetime import datetime
from pathlib import Path
from typing import TypedDict, Optional

# ---------------------------------------------------------------------------
# Configuration — all from env vars, no hardcoded PII
# ---------------------------------------------------------------------------
_DB_NAME    = os.environ.get("SHADOWDB_NAME", "shadow")
_DB_HOST    = os.environ.get("SHADOWDB_HOST", "localhost")
_DB_PORT    = os.environ.get("SHADOWDB_PORT", "5432")
_DB_USER    = os.environ.get("SHADOWDB_USER", os.environ.get("USER", ""))
_WORKSPACE  = Path(os.environ.get("SHADOWDB_WORKSPACE",
                                   str(Path.home() / ".openclaw" / "workspace")))

BASELINE_FILE = _WORKSPACE / "db-baseline.json"
DB_CMD = (
    f"PGDATABASE={_DB_NAME} PGHOST={_DB_HOST} "
    f"PGPORT={_DB_PORT} PGUSER={_DB_USER} psql -t -A -c"
)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
class LastRecord(TypedDict):
    title: str
    created_at: Optional[str]


class DBStats(TypedDict, total=False):
    total_records: int
    by_category: dict[str, int]
    contacts: int
    recent_24h: int
    last_record: LastRecord
    connected: bool
    contact_graph_contacts: int
    id_gaps: int
    id_range: dict[str, int]
    timestamp: str


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------

def get_db_stats() -> DBStats:
    """Return current database statistics. Never raises — missing data defaults to 0/False."""
    stats: DBStats = {}

    def _run(sql: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            DB_CMD + f' "{sql}"',
            shell=True,
            capture_output=True,
            text=True,
        )

    # Total records
    r = _run("SELECT COUNT(*) FROM memories")
    stats["total_records"] = int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0

    # Records by category
    r = _run("SELECT category, COUNT(*) FROM memories GROUP BY category")
    stats["by_category"] = {}
    if r.returncode == 0:
        for line in r.stdout.strip().split("\n"):
            if "|" in line:
                cat, count = line.split("|", 1)
                stats["by_category"][cat] = int(count)

    stats["contacts"] = stats["by_category"].get("contacts", 0)

    # Recent records (last 24h)
    r = _run("SELECT COUNT(*) FROM memories WHERE created_at > NOW() - INTERVAL '24 hours'")
    stats["recent_24h"] = int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0

    # Last created record
    r = _run("SELECT title, created_at FROM memories ORDER BY created_at DESC LIMIT 1")
    if r.returncode == 0 and r.stdout.strip():
        parts = r.stdout.strip().split("|", 1)
        stats["last_record"] = {
            "title": parts[0],
            "created_at": parts[1] if len(parts) > 1 else None,
        }

    # Connectivity
    r = _run("SELECT 1")
    stats["connected"] = r.returncode == 0

    # Contact graph
    graph_path = _WORKSPACE / "contact-graph.json"
    if graph_path.exists():
        with open(graph_path) as f:
            graph = json.load(f)
        stats["contact_graph_contacts"] = len(graph.get("contacts", []))
    else:
        stats["contact_graph_contacts"] = 0

    # ID gaps
    r = _run(
        "SELECT COUNT(*) FROM generate_series("
        "(SELECT MIN(id) FROM memories), (SELECT MAX(id) FROM memories)"
        ") AS s(id) WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = s.id)"
    )
    stats["id_gaps"] = int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0

    # ID range
    r = _run("SELECT MIN(id), MAX(id) FROM memories")
    if r.returncode == 0 and r.stdout.strip():
        parts = r.stdout.strip().split("|", 1)
        stats["id_range"] = {
            "min": int(parts[0]) if parts[0] else 0,
            "max": int(parts[1]) if len(parts) > 1 and parts[1] else 0,
        }

    stats["timestamp"] = datetime.now().isoformat()
    return stats


def create_baseline() -> bool:
    """Write current stats to baseline file. Returns True on success."""
    stats = get_db_stats()
    with open(BASELINE_FILE, "w") as f:
        json.dump(stats, f, indent=2)
    print(f"[OK] Baseline created: {BASELINE_FILE}")
    print(f"  Total records: {stats['total_records']}")
    print(f"  Contacts: {stats['contacts']}")
    print(f"  Contact graph: {stats['contact_graph_contacts']}")
    print(f"  ID gaps: {stats.get('id_gaps', 0)}")
    return True


def check_health() -> bool:
    """Compare current state against baseline. Returns True if no issues."""
    if not BASELINE_FILE.exists():
        print("[ERROR] No baseline found. Run with --baseline first.")
        return False

    with open(BASELINE_FILE) as f:
        baseline: DBStats = json.load(f)

    current = get_db_stats()
    issues: list[str] = []
    warnings: list[str] = []

    if not current.get("connected"):
        issues.append("Database not connected")

    if current["total_records"] < baseline.get("total_records", 0):
        diff = baseline["total_records"] - current["total_records"]
        issues.append(
            f"Lost {diff} records "
            f"(baseline: {baseline['total_records']}, current: {current['total_records']})"
        )

    if current["contacts"] < baseline.get("contacts", 0):
        diff = baseline["contacts"] - current["contacts"]
        issues.append(f"Lost {diff} contact records")

    if current["contact_graph_contacts"] < baseline.get("contact_graph_contacts", 0):
        diff = baseline["contact_graph_contacts"] - current["contact_graph_contacts"]
        warnings.append(f"Contact graph shrunk by {diff} contacts")

    if current["recent_24h"] == 0:
        warnings.append("No records created in last 24h")

    print("=== DB HEALTH CHECK ===")
    print(f"Timestamp: {current['timestamp']}")
    print(f"\nBaseline: {baseline.get('timestamp', 'unknown')}")
    print("\nCurrent State:")
    print(f"  Total records: {current['total_records']}")
    print(f"  Contacts: {current['contacts']}")
    print(f"  Recent (24h): {current['recent_24h']}")
    print(f"  Contact graph: {current['contact_graph_contacts']}")

    if issues:
        print(f"\n❌ ISSUES ({len(issues)}):")
        for issue in issues:
            print(f"  - {issue}")

    if warnings:
        print(f"\n⚠️  WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"  - {w}")

    if not issues and not warnings:
        print("\n✅ All checks passed")

    return len(issues) == 0


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1]

    if cmd == "--baseline":
        create_baseline()

    elif cmd == "--check":
        success = check_health()
        sys.exit(0 if success else 1)

    elif cmd == "--cron":
        if not BASELINE_FILE.exists():
            print("[ERROR] No baseline found")
            sys.exit(1)

        with open(BASELINE_FILE) as f:
            baseline: DBStats = json.load(f)

        current = get_db_stats()

        if not current.get("connected"):
            print("[CRITICAL] Database not connected")
            sys.exit(1)

        if current["total_records"] < baseline.get("total_records", 0):
            diff = baseline["total_records"] - current["total_records"]
            print(f"[CRITICAL] Lost {diff} records")
            sys.exit(1)

        if current["contacts"] < baseline.get("contacts", 0):
            diff = baseline["contacts"] - current["contacts"]
            print(f"[CRITICAL] Lost {diff} contacts")
            sys.exit(1)

        sys.exit(0)

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
