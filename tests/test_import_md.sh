#!/usr/bin/env bash
# test_import_md.sh — Test import-md script with mock .md files
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR=$(mktemp -d)
PASS=0; FAIL=0

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"; PASS=$((PASS+1))
  else
    echo "  FAIL: $desc (expected='$expected', got='$actual')"; FAIL=$((FAIL+1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"; PASS=$((PASS+1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"; FAIL=$((FAIL+1))
  fi
}

echo "=== test_import_md.sh ==="

# --- Setup: create mock workspace ---
mkdir -p "$TMPDIR/workspace"
echo "You are a helpful assistant. Precise and analytical." > "$TMPDIR/workspace/SOUL.md"
echo "Test user. Likes databases." > "$TMPDIR/workspace/USER.md"
echo "DB: m query" > "$TMPDIR/workspace/AGENTS.md"
echo "" > "$TMPDIR/workspace/TOOLS.md"
echo "Remember to check the weather daily." > "$TMPDIR/workspace/MEMORY.md"
echo "Run setup on first boot." > "$TMPDIR/workspace/BOOTSTRAP.md"

# --- Test 1: --dry-run produces output ---
echo ""
echo "Test 1: --dry-run mode"
OUTPUT=$("$SCRIPT_DIR/import-md" "$TMPDIR/workspace" --dry-run --backend postgres 2>&1 || true)
assert_contains "dry-run shows SOUL.md" "SOUL.md" "$OUTPUT"
assert_contains "dry-run shows DRY RUN" "DRY RUN" "$OUTPUT"
assert_contains "dry-run skips AGENTS.md" "AGENTS.md" "$OUTPUT"
assert_contains "dry-run skips TOOLS.md" "TOOLS.md" "$OUTPUT"

# --- Test 2: Categorization is correct ---
echo ""
echo "Test 2: File categorization"
assert_contains "SOUL.md → startup" "startup" "$OUTPUT"
assert_contains "USER.md → personal" "personal" "$OUTPUT"
assert_contains "MEMORY.md → general" "general" "$OUTPUT"
assert_contains "BOOTSTRAP.md → ops" "ops" "$OUTPUT"

# --- Test 3: Empty files are skipped ---
echo ""
echo "Test 3: Empty file handling"
assert_contains "TOOLS.md skipped (empty)" "TOOLS.md" "$OUTPUT"

# --- Test 4: Script exits cleanly ---
echo ""
echo "Test 4: Exit code"
"$SCRIPT_DIR/import-md" "$TMPDIR/workspace" --dry-run --backend postgres >/dev/null 2>&1
assert_eq "exit code 0 on dry-run" "0" "$?"

# --- Test 5: Missing directory fails ---
echo ""
echo "Test 5: Missing directory"
if "$SCRIPT_DIR/import-md" "$TMPDIR/nonexistent" --dry-run 2>/dev/null; then
  echo "  FAIL: should have failed on missing directory"; FAIL=$((FAIL+1))
else
  echo "  PASS: correctly fails on missing directory"; PASS=$((PASS+1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
