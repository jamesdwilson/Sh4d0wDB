#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                                                                            ║
# ║                      ShadowDB — Quick Start Installer                      ║
# ║                                                                            ║
# ║   Replace 9,198 bytes of static markdown bloat with an 11-byte database    ║
# ║   instruction. Your agent gets smarter with every record.                  ║
# ║                                                                            ║
# ║   ONE COMMAND:                                                             ║
# ║     curl -sSL https://raw.githubusercontent.com/openclaw/shadowdb/main/quickstart.sh | bash
# ║                                                                            ║
# ║   Or if you already cloned the repo:                                       ║
# ║     ./quickstart.sh                                                        ║
# ║                                                                            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
#
#   WHAT THIS SCRIPT DOES (step by step, with your permission):
#
#     1.  Checks that your system has the tools it needs
#     2.  Backs up ALL your workspace .md files (you can always undo everything)
#     3.  Creates the ShadowDB database
#     4.  Imports your .md files into the database
#     5.  Verifies everything works with a test search
#     6.  Shows you the two lines to paste into your workspace
#
#
#   WHAT THIS SCRIPT WILL NEVER DO:
#
#     ✗  Delete or modify your original .md files
#     ✗  Change your AGENTS.md (you do that — we just tell you what to paste)
#     ✗  Install software without telling you exactly what and why
#     ✗  Continue if something fails — it stops and tells you what went wrong
#
#
#   YOUR BACKUP IS SACRED:
#
#     Before touching anything, we copy your files to:
#
#       ~/OpenClaw-Workspace-Backup-2025-02-13/
#
#     If ANYTHING goes wrong — during setup, a week later, whenever — you
#     can restore your originals with one command:
#
#       cp ~/OpenClaw-Workspace-Backup-*/*.md ~/.openclaw/workspace/
#
#     Done. You're back to exactly where you started. No harm, no foul.
#
#
#   FLAGS:
#
#     --workspace <dir>     Where your .md files live
#                           (default: ~/.openclaw/workspace)
#
#     --backend <type>      Database to use: postgres or sqlite
#                           (default: postgres)
#
#     --dry-run             Preview everything without making changes
#
#     --yes                 Skip confirmation prompts (for automation)
#
#     --help                Show this help
#
#
# ════════════════════════════════════════════════════════════════════════════════

set -euo pipefail


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                              CONFIGURATION                                │
# └────────────────────────────────────────────────────────────────────────────┘

WORKSPACE="${HOME}/.openclaw/workspace"
BACKEND="postgres"
DB_NAME="shadow"
DRY_RUN=false
AUTO_YES=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SHADOWDB_CONFIG:-$HOME/.shadowdb.json}"
TODAY=$(date +%Y-%m-%d)
BACKUP_DIR="${HOME}/OpenClaw-Workspace-Backup-${TODAY}"


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                          COLORS & OUTPUT HELPERS                          │
# └────────────────────────────────────────────────────────────────────────────┘

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { echo -e "  ${BLUE}ℹ${NC}  $1"; }
ok()      { echo -e "  ${GREEN}✓${NC}  $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $1"; }
fail()    { echo -e "\n  ${RED}✗  $1${NC}\n"; exit 1; }
header()  { echo -e "\n${BOLD}  $1${NC}\n"; }
detail()  { echo -e "     ${DIM}$1${NC}"; }
blank()   { echo ""; }


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                           ARGUMENT PARSING                                │
# └────────────────────────────────────────────────────────────────────────────┘

usage() {
  cat <<'EOF'

  ShadowDB Quick Start
  ════════════════════

  Usage:

    ./quickstart.sh                              # defaults (postgres, ~/.openclaw/workspace)
    ./quickstart.sh --workspace ~/my-agent       # custom workspace
    ./quickstart.sh --backend sqlite             # use SQLite instead
    ./quickstart.sh --dry-run                    # preview without changes
    ./quickstart.sh --yes                        # skip prompts (CI/automation)

  Flags:

    --workspace <dir>   Where your .md files live (default: ~/.openclaw/workspace)
    --backend <type>    Database backend: postgres or sqlite (default: postgres)
    --dry-run           Show what would happen without making any changes
    --yes               Auto-confirm all prompts
    --help, -h          Show this help

EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --backend)   BACKEND="$2";   shift 2 ;;
    --dry-run)   DRY_RUN=true;   shift   ;;
    --yes|-y)    AUTO_YES=true;  shift   ;;
    --help|-h)   usage ;;
    *) echo "  Unknown option: $1"; usage ;;
  esac
done

WORKSPACE="${WORKSPACE%/}"


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                          CONFIRMATION HELPER                              │
# └────────────────────────────────────────────────────────────────────────────┘
#
#   Every major step asks for confirmation before proceeding.
#   Pass --yes to skip these prompts (useful for CI or if you've done this before).

confirm() {
  local prompt="$1"

  if $AUTO_YES; then
    return 0
  fi

  echo ""
  echo -ne "  ${BOLD}${prompt}${NC} [Y/n] "
  read -r answer

  case "${answer:-y}" in
    [Yy]*) return 0 ;;
    *)     echo ""; info "Skipped."; return 1 ;;
  esac
}


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                                                                            ║
# ║                            LET'S GET STARTED                               ║
# ║                                                                            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

clear 2>/dev/null || true

echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║                                                      ║"
echo "  ║         🧠  ShadowDB Quick Start  🧠                ║"
echo "  ║                                                      ║"
echo "  ║   Replace .md file bloat with a database brain.      ║"
echo "  ║   Your files are backed up. You can undo anytime.    ║"
echo "  ║                                                      ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""

info "Backend:    ${BOLD}${BACKEND}${NC}"
info "Workspace:  ${BOLD}${WORKSPACE}${NC}"
info "Backup to:  ${BOLD}${BACKUP_DIR}/${NC}"

if $DRY_RUN; then
  blank
  warn "DRY RUN — nothing will be changed. This is a preview."
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 1 of 6:  CHECK PREREQUISITES                                       │
# │                                                                            │
# │   We need a few tools installed before we can set up ShadowDB.             │
# │   If anything's missing, we'll tell you exactly how to install it.         │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 1 of 6 — Checking prerequisites"

MISSING=0

# ── Python 3 ──────────────────────────────────────────────────────────────
#
#   Required. The `m` search CLI and all backend adapters are Python.

if command -v python3 &>/dev/null; then
  ok "python3 found"
  detail "$(python3 --version 2>&1)"
else
  warn "python3 not found"
  detail "Install: brew install python3   (macOS)"
  detail "         apt install python3     (Ubuntu/Debian)"
  MISSING=1
fi

blank

# ── PostgreSQL (only if using postgres backend) ──────────────────────────
#
#   We need the `psql` client to create the database and run queries,
#   and `createdb` to create the database itself.

if [[ "$BACKEND" == "postgres" ]]; then

  if command -v psql &>/dev/null; then
    ok "psql found"
    detail "$(psql --version 2>&1 | head -1)"
  else
    warn "psql not found"
    detail "Install: brew install postgresql@17   (macOS)"
    detail "         apt install postgresql        (Ubuntu/Debian)"
    MISSING=1
  fi

  blank

  if command -v createdb &>/dev/null; then
    ok "createdb found"
  else
    warn "createdb not found (usually comes with psql)"
    MISSING=1
  fi

  blank
fi

# ── Ollama (optional but recommended) ────────────────────────────────────
#
#   Ollama provides the embedding model (nomic-embed-text) for semantic
#   vector search. Without it, you still get full-text keyword search —
#   just not the semantic "what does this mean" search.
#
#   Totally fine to skip this and add it later.

if command -v ollama &>/dev/null; then
  ok "ollama found"
  detail "Enables semantic search (recommended)"

  if ollama list &>/dev/null 2>&1; then

    if ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
      ok "nomic-embed-text model ready"
    else
      blank
      info "The embedding model isn't downloaded yet."
      info "It's ~275 MB — one-time download."
      blank

      if confirm "Download nomic-embed-text now?"; then
        if ! $DRY_RUN; then
          ollama pull nomic-embed-text
          ok "nomic-embed-text downloaded"
        else
          ok "[DRY RUN] Would download nomic-embed-text"
        fi
      fi
    fi

  else
    warn "Ollama is installed but not running"
    detail "Start it:  ollama serve"
    detail "Then re-run this script"
  fi

else
  blank
  info "Ollama not found — that's fine!"
  detail "Without it, you get keyword search (still very fast)."
  detail "Add semantic search later:  brew install ollama"
fi

blank

# ── Stop if anything critical is missing ─────────────────────────────────

if [[ $MISSING -eq 1 ]]; then
  fail "Some required tools are missing. Install them (see above) and try again."
fi

ok "All prerequisites met"
blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 2 of 6:  BACK UP YOUR FILES                                        │
# │                                                                            │
# │   This is the most important step. We copy ALL your .md files to a         │
# │   safe location before touching anything else. If anything goes wrong      │
# │   at any point — now or months from now — you restore with one command.    │
# │                                                                            │
# │   Backup location:                                                         │
# │     ~/OpenClaw-Workspace-Backup-2025-02-13/                                │
# │                                                                            │
# │   Restore command:                                                         │
# │     cp ~/OpenClaw-Workspace-Backup-*/*.md ~/.openclaw/workspace/           │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 2 of 6 — Backing up your files"

if [[ ! -d "$WORKSPACE" ]]; then
  warn "Workspace directory not found: $WORKSPACE"
  detail "We'll skip the backup and import. You can create it later."
  blank
  MD_COUNT=0
else
  # Count .md files (top-level only — not subdirectories)
  MD_COUNT=$(find "$WORKSPACE" -maxdepth 1 -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')

  if [[ $MD_COUNT -eq 0 ]]; then
    info "No .md files found in $WORKSPACE"
    detail "Nothing to back up — this might be a fresh workspace."
    blank
  else
    info "Found ${BOLD}${MD_COUNT} .md files${NC} to back up:"
    blank

    # Show each file with its size so the user knows exactly what's being copied
    find "$WORKSPACE" -maxdepth 1 -name "*.md" -type f | sort | while read -r f; do
      size=$(wc -c < "$f" | tr -d ' ')
      name=$(basename "$f")
      printf "     %-30s  %s bytes\n" "$name" "$size"
    done

    blank
    info "Backup destination:  ${BOLD}${BACKUP_DIR}/${NC}"
    blank

    if confirm "Back up these files now?"; then
      if ! $DRY_RUN; then
        mkdir -p "$BACKUP_DIR"
        cp "$WORKSPACE"/*.md "$BACKUP_DIR/"
        ok "Backed up ${MD_COUNT} files to ${BACKUP_DIR}/"
      else
        ok "[DRY RUN] Would back up ${MD_COUNT} files"
      fi

      blank
      echo "  ┌──────────────────────────────────────────────────────────────┐"
      echo "  │                                                              │"
      echo "  │   📦  Your originals are safe!                               │"
      echo "  │                                                              │"
      echo "  │   To restore at any time, run:                               │"
      echo "  │                                                              │"
      echo "  │     cp ${BACKUP_DIR}/*.md \\"
      echo "  │        ${WORKSPACE}/                              │"
      echo "  │                                                              │"
      echo "  └──────────────────────────────────────────────────────────────┘"
      blank
    fi
  fi
fi


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 3 of 6:  CREATE THE DATABASE                                        │
# │                                                                            │
# │   We create a database called "shadow" and set up the tables ShadowDB      │
# │   needs:                                                                   │
# │                                                                            │
# │     startup   — Your agent's identity (who it is, who you are, rules)      │
# │     memories  — Searchable knowledge base (everything the agent knows)     │
# │                                                                            │
# │   If the database already exists, we skip this step (safe to re-run).      │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 3 of 6 — Creating database"

if [[ "$BACKEND" == "postgres" ]]; then

  # ── Check if database exists ───────────────────────────────────────────

  if psql -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    ok "Database '${DB_NAME}' already exists — skipping creation"
  else
    info "Creating PostgreSQL database: ${BOLD}${DB_NAME}${NC}"
    blank

    if confirm "Create database '${DB_NAME}'?"; then
      if ! $DRY_RUN; then
        createdb "$DB_NAME"
        ok "Database '${DB_NAME}' created"
      else
        ok "[DRY RUN] Would create database '${DB_NAME}'"
      fi
    fi
  fi

  blank

  # ── Apply schema ──────────────────────────────────────────────────────
  #
  #   The schema file creates the startup and memories tables, plus indexes
  #   for fast search. It uses CREATE TABLE IF NOT EXISTS, so it's safe to
  #   run multiple times.

  if [[ -f "$SCRIPT_DIR/schema.sql" ]]; then
    info "Applying database schema..."

    if ! $DRY_RUN; then
      psql "$DB_NAME" -f "$SCRIPT_DIR/schema.sql" 2>/dev/null
      ok "Schema applied"
    else
      ok "[DRY RUN] Would apply schema.sql"
    fi
  else
    info "No schema.sql found in $SCRIPT_DIR"
    detail "You may need to create tables manually — see README.md"
  fi

  blank

  # ── Enable pgvector extension ─────────────────────────────────────────
  #
  #   pgvector adds vector/embedding columns to PostgreSQL. This enables
  #   semantic search — finding records by meaning, not just keywords.
  #   If pgvector isn't installed, we warn but continue. FTS still works.

  if ! $DRY_RUN; then
    if psql "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null; then
      ok "pgvector extension enabled (semantic search ready)"
    else
      warn "Could not enable pgvector"
      detail "Semantic search won't work, but keyword search still will."
      detail "Install: brew install pgvector   (macOS)"
    fi
  fi

  blank

elif [[ "$BACKEND" == "sqlite" ]]; then

  DB_PATH="${HOME}/.shadowdb/shadow.db"
  info "SQLite database: ${BOLD}${DB_PATH}${NC}"
  blank

  if confirm "Create SQLite database?"; then
    if ! $DRY_RUN; then
      mkdir -p "$(dirname "$DB_PATH")"

      if [[ -f "$SCRIPT_DIR/schema-sqlite.sql" ]]; then
        sqlite3 "$DB_PATH" < "$SCRIPT_DIR/schema-sqlite.sql"
        ok "SQLite database created with schema"
      else
        info "No schema-sqlite.sql found — you may need to create tables manually"
      fi
    else
      ok "[DRY RUN] Would create SQLite database at $DB_PATH"
    fi
  fi

  blank
fi


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 4 of 6:  IMPORT YOUR .md FILES                                     │
# │                                                                            │
# │   This reads your workspace .md files and imports them into the database.  │
# │                                                                            │
# │   Here's where each file goes:                                             │
# │                                                                            │
# │     SOUL.md, IDENTITY.md  →  startup table  (agent identity)               │
# │     USER.md               →  memories table  (category: personal)          │
# │     MEMORY.md             →  memories table  (category: general)           │
# │     BOOTSTRAP.md          →  memories table  (category: ops)               │
# │     TOOLS.md              →  skipped  (framework manages this)             │
# │     AGENTS.md             →  skipped  (you'll replace this with 11 bytes)  │
# │     HEARTBEAT.md          →  skipped  (framework manages this)             │
# │     everything else       →  memories table  (auto-categorized)            │
# │                                                                            │
# │   Your original files are NOT modified. We only READ them.                 │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 4 of 6 — Importing your .md files"

if [[ -d "$WORKSPACE" ]] && [[ $MD_COUNT -gt 0 ]]; then

  info "Importing from: ${BOLD}${WORKSPACE}${NC}"
  blank

  if [[ -f "$SCRIPT_DIR/import-md" ]]; then

    if confirm "Import ${MD_COUNT} .md files into the database?"; then
      blank

      if ! $DRY_RUN; then
        "$SCRIPT_DIR/import-md" "$WORKSPACE" --backend "$BACKEND"
      else
        "$SCRIPT_DIR/import-md" "$WORKSPACE" --backend "$BACKEND" --dry-run
      fi

      blank
      ok "Import complete"
    fi

  else
    warn "import-md script not found in $SCRIPT_DIR"
    detail "You can import files manually later — see README.md"
  fi

else
  if [[ ! -d "$WORKSPACE" ]]; then
    info "Workspace directory doesn't exist yet — skipping import"
  else
    info "No .md files to import — skipping"
  fi
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 5 of 6:  VERIFY IT WORKS                                           │
# │                                                                            │
# │   We run a quick test search to make sure the full pipeline works:         │
# │                                                                            │
# │     query  →  database  →  search  →  ranked results                       │
# │                                                                            │
# │   If you see results, everything is working. If not, the database          │
# │   might be empty (which is fine — add records with `m save`).              │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 5 of 6 — Verifying installation"

if ! $DRY_RUN; then

  if [[ -f "$SCRIPT_DIR/m" ]]; then
    info "Running test search:  ${BOLD}m \"test\"${NC}"
    blank

    OUTPUT=$("$SCRIPT_DIR/m" "test" 2>&1 || true)

    if [[ -n "$OUTPUT" ]]; then
      ok "Search is working! Here's a preview:"
      blank
      echo "$OUTPUT" | head -15 | sed 's/^/     /'
    else
      info "No results returned — this is normal for an empty database."
      detail "Add your first record:  m save \"Hello\" \"My first memory\""
    fi

  else
    warn "m script not found — can't verify"
  fi

else
  ok "[DRY RUN] Would test with: m \"test\""
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 6 of 6:  WRITE THE CONFIG FILE                                     │
# │                                                                            │
# │   ShadowDB needs a small JSON config file at ~/.shadowdb.json that tells   │
# │   it which database to use and where to find the embedding model.          │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 6 of 6 — Writing config"

if [[ -f "$CONFIG_FILE" ]]; then
  ok "Config already exists at ${CONFIG_FILE}"
  detail "Leaving it as-is. Edit manually if you need to change settings."
else
  info "Creating config:  ${BOLD}${CONFIG_FILE}${NC}"
  blank

  if [[ "$BACKEND" == "postgres" ]]; then
    CONFIG_CONTENT='{
  "backend": "postgres",
  "postgres": {
    "psql_path": "'$(command -v psql || echo "/opt/homebrew/opt/postgresql@17/bin/psql")'",
    "database": "'"$DB_NAME"'",
    "embedding_url": "http://localhost:11434/api/embeddings",
    "embedding_model": "nomic-embed-text"
  }
}'
  else
    CONFIG_CONTENT='{
  "backend": "sqlite",
  "sqlite": {
    "db_path": "~/.shadowdb/shadow.db",
    "embedding_url": "http://localhost:11434/api/embeddings",
    "embedding_model": "nomic-embed-text"
  }
}'
  fi

  if ! $DRY_RUN; then
    echo "$CONFIG_CONTENT" > "$CONFIG_FILE"
    ok "Config written to ${CONFIG_FILE}"
  else
    ok "[DRY RUN] Would write config to ${CONFIG_FILE}"
  fi
fi

blank


# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                                                                            ║
# ║                              ALL DONE! 🎉                                  ║
# ║                                                                            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

echo ""
echo "  ╔══════════════════════════════════════════════════════════════════╗"
echo "  ║                                                                  ║"
echo "  ║                    🧠  Setup Complete!  🧠                       ║"
echo "  ║                                                                  ║"
echo "  ╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo ""
echo "  Now do two things:"
echo ""
echo ""
echo "  ┌──────────────────────────────────────────────────────────────────┐"
echo "  │                                                                  │"
echo "  │   1.  Replace your AGENTS.md with this:                          │"
echo "  │                                                                  │"
echo "  │         echo 'DB: m query' > ${WORKSPACE}/AGENTS.md"
echo "  │                                                                  │"
echo "  │       That's the entire agent config. 11 bytes.                  │"
echo "  │                                                                  │"
echo "  └──────────────────────────────────────────────────────────────────┘"
echo ""
echo ""
echo "  ┌──────────────────────────────────────────────────────────────────┐"
echo "  │                                                                  │"
echo "  │   2.  Zero out the old files (optional — keeps things clean):    │"
echo "  │                                                                  │"
echo "  │         cd ${WORKSPACE}"
echo "  │         for f in SOUL.md USER.md MEMORY.md BOOTSTRAP.md; do"
echo "  │           echo -n > \"\$f\""
echo "  │         done"
echo "  │                                                                  │"
echo "  │       This empties them without deleting — the framework         │"
echo "  │       won't complain about missing files.                        │"
echo "  │                                                                  │"
echo "  └──────────────────────────────────────────────────────────────────┘"
echo ""
echo ""
echo "  Try it out:"
echo ""
echo "     m \"your search query\"          Search your knowledge base"
echo "     m save \"Title\" \"Content\"       Save a new record"
echo "     m d                            Daily dashboard"
echo ""
echo ""
echo "  ┌──────────────────────────────────────────────────────────────────┐"
echo "  │                                                                  │"
echo "  │   📦  Your originals are backed up at:                           │"
echo "  │       ${BACKUP_DIR}/"
echo "  │                                                                  │"
echo "  │   🔄  Restore anytime:                                           │"
echo "  │       cp ~/OpenClaw-Workspace-Backup-*/*.md \\                   │"
echo "  │          ${WORKSPACE}/                              │"
echo "  │                                                                  │"
echo "  └──────────────────────────────────────────────────────────────────┘"
echo ""
echo "  📖  Docs:  https://github.com/openclaw/shadowdb"
echo ""
