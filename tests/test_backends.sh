#!/usr/bin/env bash
# test_backends.sh — Test backend Python modules parse and import correctly
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0

echo "=== test_backends.sh ==="

# --- Test 1: Python files parse correctly ---
echo ""
echo "Test 1: Backend syntax validation"

for f in backends/postgres.py backends/sqlite.py backends/mysql.py backends/__init__.py; do
  if python3 -c "compile(open('$SCRIPT_DIR/$f').read(), '$f', 'exec')" 2>/dev/null; then
    echo "  PASS: $f parses correctly"; PASS=$((PASS+1))
  else
    echo "  FAIL: $f has syntax errors"; FAIL=$((FAIL+1))
  fi
done

# --- Test 2: Backend classes are importable ---
echo ""
echo "Test 2: Backend imports"

if python3 -c "import sys; sys.path.insert(0,'$SCRIPT_DIR'); from backends.postgres import PostgresBackend; print('ok')" 2>/dev/null | grep -q ok; then
  echo "  PASS: PostgresBackend imports"; PASS=$((PASS+1))
else
  echo "  FAIL: PostgresBackend import failed"; FAIL=$((FAIL+1))
fi

if python3 -c "import sys; sys.path.insert(0,'$SCRIPT_DIR'); from backends.sqlite import SQLiteBackend; print('ok')" 2>/dev/null | grep -q ok; then
  echo "  PASS: SQLiteBackend imports"; PASS=$((PASS+1))
else
  echo "  FAIL: SQLiteBackend import failed"; FAIL=$((FAIL+1))
fi

if python3 -c "import sys; sys.path.insert(0,'$SCRIPT_DIR'); from backends.mysql import MySQLBackend; print('ok')" 2>/dev/null | grep -q ok; then
  echo "  PASS: MySQLBackend imports"; PASS=$((PASS+1))
else
  echo "  FAIL: MySQLBackend import failed"; FAIL=$((FAIL+1))
fi

# --- Test 3: Backend interface methods exist ---
echo ""
echo "Test 3: Interface compliance"

for cls in "PostgresBackend" "SQLiteBackend" "MySQLBackend"; do
  mod=$(echo "$cls" | sed 's/Backend//' | tr '[:upper:]' '[:lower:]')
  [[ "$mod" == "postgres" ]] && mod="postgres"
  [[ "$mod" == "sqlite" ]] && mod="sqlite"
  [[ "$mod" == "mysql" ]] && mod="mysql"
  
  for method in "startup" "search"; do
    if python3 -c "
import sys; sys.path.insert(0,'$SCRIPT_DIR')
from backends.$mod import $cls
assert hasattr($cls, '$method'), 'missing $method'
print('ok')
" 2>/dev/null | grep -q ok; then
      echo "  PASS: $cls has $method()"; PASS=$((PASS+1))
    else
      echo "  FAIL: $cls missing $method()"; FAIL=$((FAIL+1))
    fi
  done
done

# --- Test 4: PostgreSQL connectivity (if available) ---
echo ""
echo "Test 4: PostgreSQL connectivity (skipped if unavailable)"
if command -v psql &>/dev/null && psql shadow -c "SELECT 1" &>/dev/null 2>&1; then
  echo "  PASS: PostgreSQL shadow database accessible"; PASS=$((PASS+1))
  
  # Check tables exist
  for table in startup memories; do
    if psql shadow -t -A -c "SELECT 1 FROM $table LIMIT 1" &>/dev/null 2>&1; then
      echo "  PASS: Table '$table' exists"; PASS=$((PASS+1))
    else
      echo "  FAIL: Table '$table' not found"; FAIL=$((FAIL+1))
    fi
  done
else
  echo "  SKIP: PostgreSQL not available"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
