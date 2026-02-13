#!/usr/bin/env bash
# ShadowDB Quick Start — run this to get up and running in 60 seconds
#
# Usage:
#   ./quickstart.sh                          # defaults: postgres backend, ~/.openclaw/workspace
#   ./quickstart.sh --workspace ~/my-agent   # custom workspace directory
#   ./quickstart.sh --backend sqlite         # use SQLite instead of PostgreSQL
#   ./quickstart.sh --dry-run                # show what would happen without doing it
#   ./quickstart.sh --help                   # show this help
#
set -euo pipefail

# --- Defaults ---
WORKSPACE="${HOME}/.openclaw/workspace"
BACKEND="postgres"
DRY_RUN=false
DB_NAME="shadow"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
ok()    { echo -e "${GREEN}✅ $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
step()  { echo -e "\n${GREEN}━━━ $1 ━━━${NC}"; }

# --- Parse args ---
usage() {
  cat <<EOF
ShadowDB Quick Start 🚀

Usage: $0 [options]

Options:
  --workspace <dir>     Agent workspace directory (default: ~/.openclaw/workspace)
  --backend <type>      Database backend: postgres or sqlite (default: postgres)
  --dry-run             Show what would happen without making changes
  --help, -h            Show this help

Examples:
  $0                                    # Quick start with defaults
  $0 --workspace ~/my-agent             # Custom workspace
  $0 --backend sqlite                   # Use SQLite (no server needed)
  $0 --dry-run                          # Preview without changes
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

WORKSPACE="${WORKSPACE%/}"

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

# ━━━ Step 1: Check prerequisites ━━━
step "Step 1/6: Checking prerequisites"

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
check_cmd python3 || MISSING=1

if [[ "$BACKEND" == "postgres" ]]; then
  check_cmd psql || MISSING=1
  check_cmd createdb || MISSING=1
fi

check_cmd ollama || { warn "ollama not found — embeddings won't work (FTS still will)"; }

if [[ $MISSING -eq 1 ]]; then
  fail "Missing required tools. Install them and try again:
    brew install postgresql@17 ollama   # macOS
    apt install postgresql              # Ubuntu/Debian"
fi

# Check Ollama is running
if command -v ollama &>/dev/null; then
  if ollama list &>/dev/null 2>&1; then
    ok "Ollama is running"
    if ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
      ok "nomic-embed-text model available"
    else
      info "Pulling nomic-embed-text model..."
      $DRY_RUN || ollama pull nomic-embed-text
      ok "nomic-embed-text ready"
    fi
  else
    warn "Ollama not running — start it with: ollama serve"
  fi
fi

# ━━━ Step 2: Back up existing .md files ━━━
step "Step 2/6: Backing up your .md files"

BACKUP_DIR="${HOME}/agent-backup-$(date +%Y%m%d)"

if [[ -d "$WORKSPACE" ]]; then
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

# ━━━ Step 3: Create database + schema ━━━
step "Step 3/6: Setting up database"

if [[ "$BACKEND" == "postgres" ]]; then
  # Check if database exists
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

  # Run schema if schema.sql exists
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

  # Enable pgvector
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

# ━━━ Step 4: Import .md files ━━━
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

# ━━━ Step 5: Test ━━━
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

# ━━━ Step 6: Done! ━━━
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
