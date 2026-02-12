#!/usr/bin/env bash
# =============================================================================
# ShadowDB Quick Start
# =============================================================================
#
# Run this to go from zero to a working ShadowDB in about 60 seconds.
#
# WHAT THIS SCRIPT DOES (in order):
#   1. Checks prerequisites (psql, python3, ollama)
#   2. BACKS UP your existing .md files (so you can always go back)
#   3. Creates the database and applies the schema
#   4. Imports your .md files into the database
#   5. Runs a test search to verify everything works
#   6. Prints next steps
#
# WHAT THIS SCRIPT DOES NOT DO:
#   - Delete or modify your original .md files
#   - Overwrite AGENTS.md (you do that manually — we just tell you how)
#   - Install PostgreSQL, Ollama, or Python (we check for them and tell you
#     how to install if missing)
#
# SAFETY:
#   The --dry-run flag shows exactly what would happen without making changes.
#   We ALWAYS back up your files first. You can restore them with one command.
#   If anything goes wrong, your originals are safe in ~/agent-backup-YYYYMMDD/.
#
# USAGE:
#   ./quickstart.sh                          # Defaults: postgres, ~/.openclaw/workspace
#   ./quickstart.sh --workspace ~/my-agent   # Custom workspace directory
#   ./quickstart.sh --backend sqlite         # Use SQLite instead of PostgreSQL
#   ./quickstart.sh --dry-run                # Preview without making changes
#   ./quickstart.sh --help                   # Show full help
#
# SEE ALSO:
#   import-md       — The import script this calls (can be run standalone)
#   m / m-universal — The search CLI you'll use after setup
#   README.md       — Full documentation and architecture details

# Exit on error, undefined variables, or pipe failures.
set -euo pipefail

# =============================================================================
# DEFAULT CONFIGURATION
# =============================================================================

# Where your agent's .md files live. This is the standard OpenClaw workspace.
# Override with --workspace if your files are somewhere else.
WORKSPACE="${HOME}/.openclaw/workspace"

# Which database backend to use.
# "postgres" is recommended (hybrid FTS + vector search).
# "sqlite" is simpler (no server process needed).
BACKEND="postgres"

# Whether to actually make changes, or just show what would happen.
DRY_RUN=false

# Default PostgreSQL database name for ShadowDB.
DB_NAME="shadow"

# Directory where this script lives — used to find import-md, m, schema.sql, etc.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============================================================================
# TERMINAL COLORS AND OUTPUT HELPERS
# =============================================================================
# We use colored emoji-prefixed output to make the script friendly and scannable.
# Each helper function prints a styled message:
#   info()  — informational (blue ℹ️)
#   ok()    — success (green ✅)
#   warn()  — warning, non-fatal (yellow ⚠️)
#   fail()  — fatal error, exits immediately (red ❌)
#   step()  — section header (green with bars)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color — resets to default terminal color

info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
ok()    { echo -e "${GREEN}✅ $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
step()  { echo -e "\n${GREEN}━━━ $1 ━━━${NC}"; }

# =============================================================================
# ARGUMENT PARSING
# =============================================================================

usage() {
  cat <<EOF
ShadowDB Quick Start 🚀

Replace agent .md file bloat with an 11-byte database instruction.
This script automates the setup process described in the README.

Usage: $0 [options]

Options:
  --workspace <dir>     Agent workspace directory containing your .md files
                        (default: ~/.openclaw/workspace)
  --backend <type>      Database backend: postgres or sqlite
                        (default: postgres — recommended for hybrid search)
  --dry-run             Show what would happen without making any changes.
                        Safe to run — doesn't touch your files or database.
  --help, -h            Show this help message

Examples:
  $0                                    # Quick start with defaults
  $0 --workspace ~/my-agent             # Custom workspace directory
  $0 --backend sqlite                   # Use SQLite (no server needed)
  $0 --dry-run                          # Preview — see what would happen

What happens:
  1. ✅ Check prerequisites (psql, python3, ollama)
  2. 📦 Back up your .md files to ~/agent-backup-YYYYMMDD/
  3. 🗄️  Create database and apply schema
  4. 📥 Import .md files into the database
  5. 🧪 Test that search works
  6. 🎉 Print next steps

Your files are NEVER deleted or modified. You can always restore from backup.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --backend)   BACKEND="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --help|-h)   usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# Strip trailing slash for clean path joining
WORKSPACE="${WORKSPACE%/}"

# =============================================================================
# WELCOME BANNER
# =============================================================================

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║        🧠 ShadowDB Quick Start 🧠           ║"
echo "║  Replace .md bloat with 11 bytes of power    ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
info "Backend:   $BACKEND"
info "Workspace: $WORKSPACE"
$DRY_RUN && warn "DRY RUN MODE — no changes will be made"
echo ""

# =============================================================================
# STEP 1: CHECK PREREQUISITES
# =============================================================================
# We check for required tools before doing anything else.
# If something's missing, we fail early with a helpful install command.
# Ollama is optional — without it, you lose vector/semantic search but
# FTS (keyword search) still works fine.

step "Step 1/6: Checking prerequisites"

# Helper: check if a command exists on PATH
check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 found: $(command -v "$1")"
    return 0
  else
    warn "$1 not found"
    return 1
  fi
}

MISSING=0

# python3 is required for the `m` search scripts and backend adapters
check_cmd python3 || MISSING=1

# PostgreSQL tools are only required for the postgres backend
if [[ "$BACKEND" == "postgres" ]]; then
  check_cmd psql || MISSING=1       # SQL client for querying
  check_cmd createdb || MISSING=1   # Database creation utility
fi

# Ollama is optional but recommended — provides embedding vectors for
# semantic search. Without it, you only get keyword (FTS) search.
check_cmd ollama || { warn "ollama not found — embeddings won't work (FTS still will)"; }

if [[ $MISSING -eq 1 ]]; then
  fail "Missing required tools. Install them and try again:
    brew install postgresql@17 ollama   # macOS
    apt install postgresql              # Ubuntu/Debian"
fi

# If Ollama is installed, check that it's running and has the embedding model.
# The nomic-embed-text model (~275MB) needs to be pulled once.
if command -v ollama &>/dev/null; then
  if ollama list &>/dev/null 2>&1; then
    ok "Ollama is running"
    if ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
      ok "nomic-embed-text model available"
    else
      info "Pulling nomic-embed-text model (one-time download, ~275MB)..."
      $DRY_RUN || ollama pull nomic-embed-text
      ok "nomic-embed-text ready"
    fi
  else
    warn "Ollama not running — start it with: ollama serve"
  fi
fi

# =============================================================================
# STEP 2: BACK UP EXISTING .md FILES
# =============================================================================
# THIS IS THE MOST IMPORTANT STEP.
# We copy all .md files to a timestamped backup directory BEFORE doing anything
# else. If anything goes wrong — during import, during search testing, or even
# weeks later — you can restore your originals with one command:
#   cp ~/agent-backup-YYYYMMDD/*.md ~/.openclaw/workspace/
#
# The backup directory includes the date so multiple runs don't overwrite
# each other. Running this script on Feb 12 and Feb 15 creates two separate
# backup directories.

step "Step 2/6: Backing up your .md files"

BACKUP_DIR="${HOME}/agent-backup-$(date +%Y%m%d)"

if [[ -d "$WORKSPACE" ]]; then
  # Count .md files (only top-level, not subdirectories)
  MD_COUNT=$(find "$WORKSPACE" -maxdepth 1 -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ $MD_COUNT -gt 0 ]]; then
    info "Found $MD_COUNT .md files in $WORKSPACE"
    info "Backing up to $BACKUP_DIR/"
    if ! $DRY_RUN; then
      mkdir -p "$BACKUP_DIR"
      cp "$WORKSPACE"/*.md "$BACKUP_DIR/"
      ok "Backed up $MD_COUNT files to $BACKUP_DIR/"
      echo ""
      echo "    📦 Your originals are safe! To restore anytime:"
      echo "       cp ${BACKUP_DIR}/*.md ${WORKSPACE}/"
      echo ""
    else
      ok "[DRY RUN] Would back up $MD_COUNT files to $BACKUP_DIR/"
    fi
  else
    info "No .md files found in $WORKSPACE — nothing to back up"
  fi
else
  warn "$WORKSPACE doesn't exist yet — will skip backup"
fi

# =============================================================================
# STEP 3: CREATE DATABASE + SCHEMA
# =============================================================================
# Set up the database tables that ShadowDB needs:
#   startup  — Agent identity (soul, user, rules)
#   memories — Searchable knowledge base (contacts, cases, knowledge, etc.)
#
# For PostgreSQL, we also enable the pgvector extension for vector search.
# If pgvector isn't installed, vector search won't work but FTS still will.

step "Step 3/6: Setting up database"

if [[ "$BACKEND" == "postgres" ]]; then
  # Check if the database already exists (idempotent — safe to re-run)
  if psql -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    ok "Database '$DB_NAME' already exists"
  else
    info "Creating database '$DB_NAME'..."
    if ! $DRY_RUN; then
      createdb "$DB_NAME"
      ok "Database '$DB_NAME' created"
    else
      ok "[DRY RUN] Would create database '$DB_NAME'"
    fi
  fi

  # Apply the schema file if it exists in the repo
  if [[ -f "$SCRIPT_DIR/schema.sql" ]]; then
    info "Applying schema..."
    if ! $DRY_RUN; then
      psql "$DB_NAME" -f "$SCRIPT_DIR/schema.sql" 2>/dev/null
      ok "Schema applied"
    else
      ok "[DRY RUN] Would apply schema.sql"
    fi
  else
    info "No schema.sql found — you may need to create tables manually"
    info "See README.md for schema definitions"
  fi

  # Enable pgvector for semantic vector search
  # This is a CREATE EXTENSION IF NOT EXISTS — safe to run multiple times
  if ! $DRY_RUN; then
    psql "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null && \
      ok "pgvector extension enabled" || \
      warn "Could not enable pgvector — vector search won't work (FTS still will)"
  fi

elif [[ "$BACKEND" == "sqlite" ]]; then
  DB_PATH="${HOME}/.shadowdb/shadow.db"
  info "SQLite database at $DB_PATH"
  if ! $DRY_RUN; then
    mkdir -p "$(dirname "$DB_PATH")"
    if [[ -f "$SCRIPT_DIR/schema-sqlite.sql" ]]; then
      sqlite3 "$DB_PATH" < "$SCRIPT_DIR/schema-sqlite.sql"
      ok "SQLite database initialized"
    else
      info "No schema-sqlite.sql found — you may need to create tables manually"
    fi
  else
    ok "[DRY RUN] Would create SQLite database at $DB_PATH"
  fi
fi

# =============================================================================
# STEP 4: IMPORT .md FILES
# =============================================================================
# Run the import-md script to read .md files and insert them into the database.
# In dry-run mode, import-md shows what it would do without writing.
# See import-md for the full categorization logic.

step "Step 4/6: Importing .md files"

if [[ -d "$WORKSPACE" ]] && [[ -f "$SCRIPT_DIR/import-md" ]]; then
  info "Running import-md on $WORKSPACE..."
  if ! $DRY_RUN; then
    "$SCRIPT_DIR/import-md" "$WORKSPACE" --backend "$BACKEND"
    ok "Import complete"
  else
    "$SCRIPT_DIR/import-md" "$WORKSPACE" --backend "$BACKEND" --dry-run
    ok "[DRY RUN] Import preview complete"
  fi
else
  if [[ ! -d "$WORKSPACE" ]]; then
    warn "Workspace $WORKSPACE doesn't exist — skipping import"
  else
    warn "import-md script not found — skipping import"
  fi
fi

# =============================================================================
# STEP 5: TEST SEARCH
# =============================================================================
# Run a quick search to verify the pipeline works end-to-end:
#   query → embedding → FTS + vector search → RRF fusion → results
# If this works, your setup is complete.

step "Step 5/6: Testing"

if ! $DRY_RUN; then
  if [[ -f "$SCRIPT_DIR/m" ]]; then
    info "Running: m \"test\""
    OUTPUT=$("$SCRIPT_DIR/m" "test" 2>&1 || true)
    if [[ -n "$OUTPUT" ]]; then
      ok "m returned results! Here's a preview:"
      echo "$OUTPUT" | head -10
    else
      warn "m returned no results — this is normal if the database is empty"
      info "Try: m \"your search term\" after importing some data"
    fi
  else
    warn "m script not found in $SCRIPT_DIR"
  fi
else
  ok "[DRY RUN] Would test with: m \"test\""
fi

# =============================================================================
# STEP 6: SUCCESS + NEXT STEPS
# =============================================================================

step "Step 6/6: All done! 🎉"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║            🧠 Setup Complete! 🧠             ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Point your agent at ShadowDB:"
echo "     echo 'DB: m query' > ${WORKSPACE}/AGENTS.md"
echo ""
echo "  2. Zero out the old .md files (optional):"
echo "     for f in SOUL.md USER.md MEMORY.md; do"
echo "       echo -n > \"${WORKSPACE}/\$f\""
echo "     done"
echo ""
echo "  3. Try a search:"
echo "     m \"your query here\""
echo ""
echo "  📦 Your originals are backed up at:"
echo "     ${BACKUP_DIR}/"
echo ""
echo "  🔄 To restore anytime:"
echo "     cp ${BACKUP_DIR}/*.md ${WORKSPACE}/"
echo ""
echo "  📖 Full docs: https://github.com/openclaw/shadowdb"
echo ""
