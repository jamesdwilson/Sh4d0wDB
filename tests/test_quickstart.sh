#!/usr/bin/env bash
# test_quickstart.sh — Test quickstart.sh in dry-run mode
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR=$(mktemp -d)
PASS=0; FAIL=0

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"; PASS=$((PASS+1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"; FAIL=$((FAIL+1))
  fi
}

echo "=== test_quickstart.sh ==="

# --- Setup: create a mock workspace ---
mkdir -p "$TMPDIR/workspace"
echo "Test soul content for quickstart test." > "$TMPDIR/workspace/SOUL.md"
echo "Test user content." > "$TMPDIR/workspace/USER.md"

# --- Test 1: --help works ---
echo ""
echo "Test 1: Help output"
OUTPUT=$("$SCRIPT_DIR/quickstart.sh" --help 2>&1 || true)
assert_contains "help shows Usage" "Usage" "$OUTPUT"
assert_contains "help shows --workspace" "workspace" "$OUTPUT"
assert_contains "help shows --backend" "backend" "$OUTPUT"
assert_contains "help shows --dry-run" "dry-run" "$OUTPUT"

# --- Test 2: --dry-run mode ---
echo ""
echo "Test 2: Dry-run mode"
OUTPUT=$("$SCRIPT_DIR/quickstart.sh" --dry-run --workspace "$TMPDIR/workspace" 2>&1 || true)
assert_contains "dry-run shows DRY RUN" "DRY RUN" "$OUTPUT"
assert_contains "dry-run shows prerequisites" "prerequisite\|Checking" "$OUTPUT"
assert_contains "dry-run shows backup step" "ack" "$OUTPUT"

# --- Test 3: Script parses correctly ---
echo ""
echo "Test 3: Bash syntax validation"
if bash -n "$SCRIPT_DIR/quickstart.sh" 2>/dev/null; then
  echo "  PASS: quickstart.sh parses correctly"; PASS=$((PASS+1))
else
  echo "  FAIL: quickstart.sh has syntax errors"; FAIL=$((FAIL+1))
fi

# --- Test 4: Exits cleanly with --help ---
echo ""
echo "Test 4: Clean exit"
"$SCRIPT_DIR/quickstart.sh" --help >/dev/null 2>&1
assert_contains "help exits 0" "0" "$?"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
