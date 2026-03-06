#!/usr/bin/env python3
"""
ShadowDB Data Integrity Test Suite
Industry-standard PostgreSQL data integrity and backup testing.

On failure, emits an OpenClaw system event (no direct channel dependency).

Configuration via environment variables:
    SHADOWDB_NAME       Database name (default: shadow)
    SHADOWDB_HOST       Database host (default: localhost)
    SHADOWDB_PORT       Database port (default: 5432)
    SHADOWDB_USER       Database user (default: current OS user)
    SHADOWDB_WORKSPACE  Workspace dir for baseline/report files
                        (default: ~/.openclaw/workspace)

Usage:
    python3 db-integrity-suite.py --all           # Run all tests
    python3 db-integrity-suite.py --checksums     # Checksum validation
    python3 db-integrity-suite.py --amcheck       # Index/table consistency
    python3 db-integrity-suite.py --baseline      # Baseline comparison
    python3 db-integrity-suite.py --report        # Show last report
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
DB_NAME   = os.environ.get("SHADOWDB_NAME", "shadow")
DB_HOST   = os.environ.get("SHADOWDB_HOST", "localhost")
DB_PORT   = os.environ.get("SHADOWDB_PORT", "5432")
DB_USER   = os.environ.get("SHADOWDB_USER", os.environ.get("USER", ""))
_WORKSPACE = Path(os.environ.get("SHADOWDB_WORKSPACE",
                                  str(Path.home() / ".openclaw" / "workspace")))

BASELINE_FILE = _WORKSPACE / "db-baseline.json"
BACKUP_DIR    = Path(os.environ.get("SHADOWDB_BACKUP_DIR",
                                     str(Path.home() / "backups" / "postgres")))
REPORT_FILE   = _WORKSPACE / "db-integrity-report.json"


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
class TestResult(TypedDict, total=False):
    status: str          # PASS | FAIL | WARNING | SKIP | ERROR
    enabled: bool
    error: str
    reason: str
    install: str
    output: str


class SuiteResults(TypedDict):
    timestamp: str
    tests: dict[str, TestResult]
    issues: list[str]
    warnings: list[str]
    passed: int
    failed: int


class DBStats(TypedDict, total=False):
    total_records: int
    by_category: dict[str, int]
    contacts: int
    recent_24h: int
    connected: bool
    contact_graph_contacts: int
    timestamp: str


# ---------------------------------------------------------------------------
# Standalone DB stats helper (mirrors db-health-check.py)
# ---------------------------------------------------------------------------

def get_db_stats() -> DBStats:
    """Return current database statistics. Never raises."""
    _DB_CMD = (
        f"PGDATABASE={DB_NAME} PGHOST={DB_HOST} "
        f"PGPORT={DB_PORT} PGUSER={DB_USER} psql -t -A -c"
    )

    def _run(sql: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            _DB_CMD + f' "{sql}"',
            shell=True,
            capture_output=True,
            text=True,
        )

    stats: DBStats = {}

    r = _run("SELECT COUNT(*) FROM memories")
    stats["total_records"] = int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0

    r = _run("SELECT category, COUNT(*) FROM memories GROUP BY category")
    stats["by_category"] = {}
    if r.returncode == 0:
        for line in r.stdout.strip().split("\n"):
            if "|" in line:
                cat, count = line.split("|", 1)
                stats["by_category"][cat] = int(count)

    stats["contacts"] = stats["by_category"].get("contacts", 0)

    r = _run("SELECT COUNT(*) FROM memories WHERE created_at > NOW() - INTERVAL '24 hours'")
    stats["recent_24h"] = int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0

    r = _run("SELECT 1")
    stats["connected"] = r.returncode == 0

    graph_path = _WORKSPACE / "contact-graph.json"
    if graph_path.exists():
        with open(graph_path) as f:
            graph = json.load(f)
        stats["contact_graph_contacts"] = len(graph.get("contacts", []))
    else:
        stats["contact_graph_contacts"] = 0

    stats["timestamp"] = datetime.now().isoformat()
    return stats


# ---------------------------------------------------------------------------
# Suite class
# ---------------------------------------------------------------------------

class DBIntegritySuite:
    def __init__(self) -> None:
        self.results: SuiteResults = {
            "timestamp": datetime.now().isoformat(),
            "tests": {},
            "issues": [],
            "warnings": [],
            "passed": 0,
            "failed": 0,
        }

    # ------------------------------------------------------------------
    # Runner
    # ------------------------------------------------------------------

    def run_all(self) -> None:
        """Run all available integrity tests, save report, alert on failure."""
        print("=" * 60)
        print("ShadowDB Integrity Test Suite")
        print("=" * 60)

        self.test_checksums_enabled()
        self.test_pg_amcheck()
        self.test_baseline_comparison()

        print("\n" + "=" * 60)
        print("SUMMARY")
        print("=" * 60)
        print(f"Passed:   {self.results['passed']}")
        print(f"Failed:   {self.results['failed']}")
        print(f"Warnings: {len(self.results['warnings'])}")

        if self.results["issues"]:
            print(f"\n❌ Issues:")
            for issue in self.results["issues"]:
                print(f"  - {issue}")

        if self.results["warnings"]:
            print(f"\n⚠️  Warnings:")
            for w in self.results["warnings"]:
                print(f"  - {w}")

        with open(REPORT_FILE, "w") as f:
            json.dump(self.results, f, indent=2)

        if self.results["failed"] > 0:
            self._send_alert()
            sys.exit(1)
        else:
            print("\n✅ All integrity tests passed")
            sys.exit(0)

    # ------------------------------------------------------------------
    # Alert — uses openclaw system event, no direct channel dependency
    # ------------------------------------------------------------------

    def _send_alert(self) -> None:
        """Emit an OpenClaw system event on failure (no hardcoded channel)."""
        message = (
            f"ShadowDB Integrity Check FAILED — "
            f"{self.results['failed']} failed, "
            f"{len(self.results['issues'])} issues"
        )
        try:
            subprocess.run(
                ["openclaw", "system", "event", "--text", message, "--mode", "now"],
                capture_output=True,
            )
        except (FileNotFoundError, OSError):
            pass

    # ------------------------------------------------------------------
    # SQL helper
    # ------------------------------------------------------------------

    def run_sql(self, query: str, db: str = DB_NAME) -> Optional[str]:
        """Run a SQL query and return stripped stdout, or None on failure."""
        env = os.environ.copy()
        env.update({
            "PGDATABASE": db,
            "PGHOST": DB_HOST,
            "PGPORT": DB_PORT,
            "PGUSER": DB_USER,
        })
        result = subprocess.run(
            ["psql", "-t", "-A", "-c", query],
            env=env,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip() if result.returncode == 0 else None

    # ------------------------------------------------------------------
    # Tests
    # ------------------------------------------------------------------

    def test_checksums_enabled(self) -> bool:
        """Test 1: Verify data checksums are enabled in PostgreSQL."""
        print("\n=== TEST 1: Data Checksums ===")
        result = self.run_sql("SHOW data_checksums;")

        if result is None:
            print("❌ FAIL: Cannot query data_checksums setting")
            self.results["tests"]["checksums_enabled"] = {
                "status": "FAIL", "error": "Query failed"
            }
            self.results["failed"] += 1
            self.results["issues"].append("Cannot query data_checksums")
            return False

        enabled = result.lower() == "on"
        if enabled:
            print("✅ PASS: Data checksums enabled")
            self.results["tests"]["checksums_enabled"] = {"status": "PASS", "enabled": True}
            self.results["passed"] += 1
        else:
            print("⚠️  WARNING: Data checksums NOT enabled")
            print("   Enable with: pg_checksums --enable")
            self.results["tests"]["checksums_enabled"] = {"status": "WARNING", "enabled": False}
            self.results["warnings"].append("Data checksums not enabled — run: pg_checksums --enable")

        return enabled

    def test_pg_amcheck(self) -> Optional[bool]:
        """Test 2: Run pg_amcheck for index/table consistency (PostgreSQL 14+)."""
        print("\n=== TEST 2: Index/Table Consistency (pg_amcheck) ===")

        check = subprocess.run(["which", "pg_amcheck"], capture_output=True)
        if check.returncode != 0:
            print("⚠️  WARNING: pg_amcheck not available (requires PostgreSQL 14+)")
            self.results["tests"]["amcheck"] = {"status": "SKIP", "reason": "Not installed"}
            self.results["warnings"].append("pg_amcheck not available — upgrade to PostgreSQL 14+")
            return None

        amcheck_installed = self.run_sql(
            "SELECT COUNT(*) FROM pg_extension WHERE extname = 'amcheck';"
        )
        if not amcheck_installed or int(amcheck_installed) == 0:
            print("⚠️  WARNING: amcheck extension not installed")
            print("   Install with: CREATE EXTENSION amcheck;")
            self.results["tests"]["amcheck"] = {
                "status": "WARNING",
                "reason": "amcheck extension not installed",
                "install": "CREATE EXTENSION amcheck;",
            }
            self.results["warnings"].append(
                "amcheck extension not installed — run: CREATE EXTENSION amcheck;"
            )
            return None

        env = os.environ.copy()
        env.update({
            "PGDATABASE": DB_NAME,
            "PGHOST": DB_HOST,
            "PGPORT": DB_PORT,
            "PGUSER": DB_USER,
        })
        result = subprocess.run(
            ["pg_amcheck", "--verbose"],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode == 0:
            print("✅ PASS: All indexes and tables consistent")
            self.results["tests"]["amcheck"] = {"status": "PASS", "output": result.stdout}
            self.results["passed"] += 1
            return True
        elif "no relations to check" in result.stderr:
            print("⚠️  WARNING: No relations to check")
            self.results["tests"]["amcheck"] = {
                "status": "WARNING", "reason": "No relations to check"
            }
            self.results["warnings"].append("pg_amcheck found no relations to check")
            return None
        else:
            print(f"❌ FAIL: Corruption detected\n   {result.stderr[:200]}")
            self.results["tests"]["amcheck"] = {"status": "FAIL", "error": result.stderr}
            self.results["failed"] += 1
            self.results["issues"].append("pg_amcheck detected corruption")
            return False

    def test_baseline_comparison(self) -> Optional[bool]:
        """Test 3: Compare current DB state against known-good baseline."""
        print("\n=== TEST 3: Baseline Comparison ===")

        if not BASELINE_FILE.exists():
            print("⚠️  WARNING: No baseline file found")
            print("   Create one: python3 db-health-check.py --baseline")
            self.results["tests"]["baseline"] = {"status": "WARNING", "reason": "No baseline"}
            self.results["warnings"].append("No baseline file — create with: db-health-check.py --baseline")
            return None

        with open(BASELINE_FILE) as f:
            baseline: DBStats = json.load(f)

        current = get_db_stats()
        issues: list[str] = []
        warnings: list[str] = []

        if current["total_records"] < baseline.get("total_records", 0):
            diff = baseline["total_records"] - current["total_records"]
            issues.append(f"Lost {diff} records")

        if current["contacts"] < baseline.get("contacts", 0):
            diff = baseline["contacts"] - current["contacts"]
            issues.append(f"Lost {diff} contact records")

        if current["contact_graph_contacts"] < baseline.get("contact_graph_contacts", 0):
            diff = baseline["contact_graph_contacts"] - current["contact_graph_contacts"]
            warnings.append(f"Contact graph shrunk by {diff} contacts")

        if current["recent_24h"] == 0:
            warnings.append("No records created in last 24h")

        print(f"Baseline:  {baseline.get('timestamp', 'unknown')}")
        print(f"Current:   {current['timestamp']}")
        print(f"  Records: {current['total_records']}")
        print(f"  Contacts: {current['contacts']}")
        print(f"  Recent (24h): {current['recent_24h']}")
        print(f"  Contact graph: {current['contact_graph_contacts']}")

        for issue in issues:
            print(f"❌ {issue}")
            self.results["issues"].append(issue)

        for w in warnings:
            print(f"⚠️  {w}")
            self.results["warnings"].append(w)

        if not issues and not warnings:
            print("✅ All checks passed")
            self.results["passed"] += 1
        elif issues:
            self.results["failed"] += 1

        self.results["tests"]["baseline"] = {
            "status": "PASS" if not issues else "FAIL"
        }
        return len(issues) == 0

    def check_health(self) -> bool:
        """Standalone health check against baseline (for direct invocation)."""
        if not BASELINE_FILE.exists():
            print("[ERROR] No baseline found. Run with --baseline first.")
            self.results["tests"]["baseline"] = {"status": "ERROR", "reason": "No baseline"}
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
            issues.append(f"Lost {diff} records")
        if current["contacts"] < baseline.get("contacts", 0):
            diff = baseline["contacts"] - current["contacts"]
            issues.append(f"Lost {diff} contacts")
        if current["contact_graph_contacts"] < baseline.get("contact_graph_contacts", 0):
            diff = baseline["contact_graph_contacts"] - current["contact_graph_contacts"]
            warnings.append(f"Contact graph shrunk by {diff} contacts")
        if current["recent_24h"] == 0:
            warnings.append("No records created in last 24h")

        print("=== DB HEALTH CHECK ===")
        print(f"Timestamp: {current['timestamp']}")
        print(f"\nBaseline: {baseline.get('timestamp', 'unknown')}")
        print(f"\nCurrent state:")
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
        sys.exit(1)

    cmd = sys.argv[1]
    suite = DBIntegritySuite()

    if cmd == "--all":
        suite.run_all()
    elif cmd == "--checksums":
        suite.test_checksums_enabled()
    elif cmd == "--amcheck":
        suite.test_pg_amcheck()
    elif cmd == "--baseline":
        suite.test_baseline_comparison()
    elif cmd == "--report":
        if REPORT_FILE.exists():
            with open(REPORT_FILE) as f:
                print(json.dumps(json.load(f), indent=2))
        else:
            print("No report found. Run --all first.")
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
