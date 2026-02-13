#!/usr/bin/env bash
# test_m_search.sh — Test m script search functionality
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"; PASS=$((PASS+1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"; FAIL=$((FAIL+1))
  fi
}

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"; PASS=$((PASS+1))
  else
    echo "  FAIL: $desc (expected exit=$expected, got=$actual)"; FAIL=$((FAIL+1))
  fi
}

echo "=== test_m_search.sh ==="

# --- Test 1: Help flag ---
echo ""
echo "Test 1: Help output"
OUTPUT=$("$SCRIPT_DIR/m" --help 2>&1 || true)
assert_contains "help shows usage" "query" "$OUTPUT"
assert_contains "help shows mem" "mem\|ShadowDB\|search" "$OUTPUT"

# --- Test 2: m-universal help ---
echo ""
echo "Test 2: m-universal help output"
OUTPUT=$("$SCRIPT_DIR/m-universal" --help 2>&1 || true)
assert_contains "universal help shows backend" "backend" "$OUTPUT"

# --- Test 3: m parses correctly (syntax check) ---
echo ""
echo "Test 3: Script syntax validation"
if python3 -c "compile(open('$SCRIPT_DIR/m').read(), 'm', 'exec')" 2>/dev/null; then
  echo "  PASS: m script parses correctly"; PASS=$((PASS+1))
else
  echo "  FAIL: m script has syntax errors"; FAIL=$((FAIL+1))
fi

if python3 -c "compile(open('$SCRIPT_DIR/m-universal').read(), 'm-universal', 'exec')" 2>/dev/null; then
  echo "  PASS: m-universal script parses correctly"; PASS=$((PASS+1))
else
  echo "  FAIL: m-universal script has syntax errors"; FAIL=$((FAIL+1))
fi

if python3 -c "compile(open('$SCRIPT_DIR/m-optimized').read(), 'm-optimized', 'exec')" 2>/dev/null; then
  echo "  PASS: m-optimized script parses correctly"; PASS=$((PASS+1))
else
  echo "  FAIL: m-optimized script has syntax errors"; FAIL=$((FAIL+1))
fi

if python3 -c "compile(open('$SCRIPT_DIR/m-universal-optimized').read(), 'm-universal-optimized', 'exec')" 2>/dev/null; then
  echo "  PASS: m-universal-optimized script parses correctly"; PASS=$((PASS+1))
else
  echo "  FAIL: m-universal-optimized script has syntax errors"; FAIL=$((FAIL+1))
fi

# --- Test 4: Search against live DB (if available) ---
echo ""
echo "Test 4: Live database search (skipped if DB unavailable)"
if command -v psql &>/dev/null && psql shadow -c "SELECT 1" &>/dev/null 2>&1; then
  ROWS=$(psql shadow -t -A -c "SELECT count(*) FROM memories" 2>/dev/null || echo "0")
  if [[ "$ROWS" -gt 0 ]]; then
    OUTPUT=$("$SCRIPT_DIR/m" "test" 2>&1 || true)
    if [[ -n "$OUTPUT" ]]; then
      echo "  PASS: m returned output against live DB ($ROWS records)"; PASS=$((PASS+1))
    else
      echo "  FAIL: m returned empty against live DB ($ROWS records)"; FAIL=$((FAIL+1))
    fi
  else
    echo "  SKIP: database has 0 records"
  fi
else
  echo "  SKIP: PostgreSQL not available"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
