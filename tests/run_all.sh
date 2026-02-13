#!/usr/bin/env bash
# run_all.sh — Run all ShadowDB tests
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOTAL_PASS=0; TOTAL_FAIL=0

echo "╔══════════════════════════════════════╗"
echo "║     ShadowDB Test Suite              ║"
echo "╚══════════════════════════════════════╝"
echo ""

for test in "$SCRIPT_DIR"/test_*.sh; do
  echo "━━━ Running: $(basename "$test") ━━━"
  if bash "$test"; then
    TOTAL_PASS=$((TOTAL_PASS+1))
  else
    TOTAL_FAIL=$((TOTAL_FAIL+1))
  fi
  echo ""
done

echo "╔══════════════════════════════════════╗"
echo "║  Suite: $TOTAL_PASS passed, $TOTAL_FAIL failed              ║"
echo "╚══════════════════════════════════════╝"

[[ $TOTAL_FAIL -eq 0 ]] && exit 0 || exit 1
