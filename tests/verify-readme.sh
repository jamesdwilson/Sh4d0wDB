#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# verify-readme.sh — Check that README examples match actual CLI
#
# Run before committing changes to m, m-literate, or README.md.
# Catches: output format drift, missing subcommands, stale examples.
#
# Usage:
#   ./tests/verify-readme.sh
# ─────────────────────────────────────────────────────────────

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

red()   { echo -e "\033[0;31m✗ $1\033[0m"; }
green() { echo -e "\033[0;32m✓ $1\033[0m"; }

# ── 1. Output format: README example should use ─── dividers ──
if grep -q '=== IDENTITY ===' "$SCRIPT_DIR/README.md"; then
    red "README still shows old '=== IDENTITY ===' format"
    FAIL=1
else
    green "Output format: no stale === wrappers"
fi

# ── 2. Output format: scores should be RRF-scale (0.0xxxxx) ──
if grep -E 'score:[[:space:]]*0\.[5-9]' "$SCRIPT_DIR/README.md" | grep -q "Example\|model.*sees\|actual output"; then
    red "README shows unrealistic scores (>0.5) — RRF scores are typically 0.01-0.05"
    FAIL=1
else
    green "Output format: scores are RRF-scale"
fi

# ── 3. All subcommands in m --help should appear in README Usage ──
SUBCMDS=$(python3 "$SCRIPT_DIR/m" --help 2>&1 | grep -oE '^\s+(SAVE|LOOPS|STATE|PEOPLE|HANDOFF|DASH|SEARCH):' | sed 's/://;s/^ *//' | tr '[:upper:]' '[:lower:]')
for cmd in $SUBCMDS; do
    if ! grep -qi "m $cmd\|m d" "$SCRIPT_DIR/README.md"; then
        red "Subcommand '$cmd' missing from README Usage section"
        FAIL=1
    fi
done
green "All subcommands present in README"

# ── 4. Files table: m and m-literate should both be listed ──
if ! grep -q '`m-literate`' "$SCRIPT_DIR/README.md"; then
    red "m-literate missing from Files table"
    FAIL=1
else
    green "Files table: m-literate listed"
fi

if ! grep -q '`quickstart.sh`' "$SCRIPT_DIR/README.md"; then
    red "quickstart.sh missing from Files table"
    FAIL=1
else
    green "Files table: quickstart.sh listed"
fi

# ── 5. No psql-married language outside postgres-specific sections ──
# Check m-literate module docstring for psql lectures
if head -80 "$SCRIPT_DIR/m-literate" | grep -qi "WHY psql\|psycopg"; then
    red "m-literate still has psql-specific advocacy in header"
    FAIL=1
else
    green "No psql-married language in m-literate header"
fi

# ── Summary ──
echo ""
if [[ $FAIL -eq 0 ]]; then
    green "All checks passed"
else
    red "Some checks failed — fix before committing"
    exit 1
fi
