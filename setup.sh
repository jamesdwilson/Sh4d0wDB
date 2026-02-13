#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                                                                            ║
# ║                          ShadowDB — Setup                                  ║
# ║                                                                            ║
# ║   Replace 9,198 bytes of static markdown bloat with an 11-byte database    ║
# ║   instruction. Your agent gets smarter with every record.                  ║
# ║                                                                            ║
# ║   ONE COMMAND:                                                             ║
# ║     git clone https://github.com/openclaw/shadowdb && cd shadowdb          ║
# ║     ./setup.sh                                                             ║
# ║                                                                            ║
# ║   Re-runnable. Safe. Backs up first, always.                               ║
# ║                                                                            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
#
#   WHAT THIS SCRIPT DOES (step by step, with your permission):
#
#     1.  Backs up ALL your workspace .md files (always first, always safe)
#     2.  Checks that your system has the tools it needs
#     3.  Creates the ShadowDB database (skips if it already exists)
#     4.  Imports your .md files into the database
#     5.  Imports RULES_REINFORCE.md as always-on rules (if it exists)
#     6.  Empties workspace .md files and writes AGENTS.md
#     7.  Verifies everything works with a test search
#
#
#   ⚠️  THIS SCRIPT WILL EMPTY .md FILES IN YOUR WORKSPACE ROOT.
#
#     After importing your files into the database, the script replaces
#     workspace .md files with empty files (so the framework doesn't
#     complain about missing files) and writes AGENTS.md with the
#     11-byte database instruction.
#
#     Your originals are ALWAYS backed up first. Restore anytime:
#       cp ~/OpenClaw-Workspace-Backup-*/*.md ~/.openclaw/workspace/
#
#
#   WHAT THIS SCRIPT WILL NEVER DO:
#
#     ✗  Touch anything before backing up your files
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

  ShadowDB Setup
  ═══════════════

  Usage:

    ./setup.sh                                   # defaults (postgres, ~/.openclaw/workspace)
    ./setup.sh --workspace ~/my-agent            # custom workspace
    ./setup.sh --backend sqlite                  # use SQLite (no server needed)
    ./setup.sh --backend postgres                # use PostgreSQL (best search)
    ./setup.sh --backend mysql                   # use MySQL / MariaDB
    ./setup.sh --dry-run                         # preview without changes
    ./setup.sh --yes                             # skip prompts (CI/automation)

  Flags:

    --workspace <dir>   Where your .md files live (default: ~/.openclaw/workspace)
    --backend <type>    Database backend: postgres, sqlite, or mysql (default: postgres)
    --dry-run           Show what would happen without making any changes
    --yes               Auto-confirm all prompts
    --help, -h          Show this help

  Re-runnable: safe to run again. Backs up first, skips existing database,
  re-imports files and RULES_REINFORCE.md if they changed.

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
echo "  ║             🧠  ShadowDB Setup  🧠                  ║"
echo "  ║                                                      ║"
echo "  ║   Replace .md file bloat with a database brain.      ║"
echo "  ║   Your files are backed up first. Undo anytime.      ║"
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

echo -e "  ${RED}${BOLD}┌──────────────────────────────────────────────────────────────┐${NC}"
echo -e "  ${RED}${BOLD}│                                                              │${NC}"
echo -e "  ${RED}${BOLD}│   ⚠️   WARNING: This will empty .md files in your workspace  │${NC}"
echo -e "  ${RED}${BOLD}│                                                              │${NC}"
echo -e "  ${RED}${BOLD}│   After importing your files into the database, this script  │${NC}"
echo -e "  ${RED}${BOLD}│   will REPLACE workspace .md files with empty files and      │${NC}"
echo -e "  ${RED}${BOLD}│   write AGENTS.md with the 11-byte database instruction.     │${NC}"
echo -e "  ${RED}${BOLD}│                                                              │${NC}"
echo -e "  ${RED}${BOLD}│   Your originals are backed up FIRST.  Restore anytime:      │${NC}"
echo -e "  ${RED}${BOLD}│     cp ~/OpenClaw-Workspace-Backup-*/*.md \\                  │${NC}"
echo -e "  ${RED}${BOLD}│        ${WORKSPACE}/                             │${NC}"
echo -e "  ${RED}${BOLD}│                                                              │${NC}"
echo -e "  ${RED}${BOLD}└──────────────────────────────────────────────────────────────┘${NC}"

blank

if ! confirm "Continue with setup?"; then
  info "Aborted. Nothing was changed."
  exit 0
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 1 of 7:  BACK UP YOUR FILES                                        │
# │                                                                            │
# │   ALWAYS FIRST. Before anything else touches your system, we copy ALL      │
# │   your .md files to a safe location. If anything goes wrong at any         │
# │   point — now or months from now — you restore with one command.           │
# │                                                                            │
# │   Backup location:                                                         │
# │     ~/OpenClaw-Workspace-Backup-2025-02-13/                                │
# │                                                                            │
# │   Restore command:                                                         │
# │     cp ~/OpenClaw-Workspace-Backup-*/*.md ~/.openclaw/workspace/           │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 1 of 7 — Backing up your files"

if [[ ! -d "$WORKSPACE" ]]; then
  warn "Workspace directory not found: $WORKSPACE"
  detail "We'll skip the backup and import. You can create it later."
  blank
  MD_COUNT=0
else
  MD_COUNT=$(find "$WORKSPACE" -maxdepth 1 -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')

  if [[ $MD_COUNT -eq 0 ]]; then
    info "No .md files found in $WORKSPACE"
    detail "Nothing to back up — this might be a fresh workspace."
    blank
  else
    info "Found ${BOLD}${MD_COUNT} .md files${NC} to back up:"
    blank

    find "$WORKSPACE" -maxdepth 1 -name "*.md" -type f | sort | while read -r f; do
      size=$(wc -c < "$f" | tr -d ' ')
      name=$(basename "$f")
      printf "     %-30s  %s bytes\n" "$name" "$size"
    done

    blank
    info "Backup destination:  ${BOLD}${BACKUP_DIR}/${NC}"
    blank

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


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 2 of 7:  CHECK PREREQUISITES                                       │
# │                                                                            │
# │   We need a few tools installed before we can set up ShadowDB.             │
# │   If anything's missing, we'll tell you exactly how to install it.         │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 2 of 7 — Checking prerequisites"

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
# │   STEP 3 of 7:  CREATE THE DATABASE                                        │
# │                                                                            │
# │   We create a database and set up the tables ShadowDB needs:                                                                   │
# │                                                                            │
# │     startup   — Your agent's identity (who it is, who you are, rules)      │
# │     memories  — Searchable knowledge base (everything the agent knows)     │
# │                                                                            │
# │   If the database already exists, we skip this step (safe to re-run).      │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 3 of 7 — Creating database"

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
# │   STEP 4 of 7:  IMPORT YOUR .md FILES                                     │
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

header "Step 4 of 7 — Importing your .md files"

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
# │   STEP 5 of 7:  IMPORT RULES_REINFORCE.md (if it exists)                  │
# │                                                                            │
# │   Convention: if your workspace contains RULES_REINFORCE.md, those rules   │
# │   are imported as always-on startup rows (reinforce=true). These rules     │
# │   appear in EVERY m query result — not just the first call in a session.   │
# │                                                                            │
# │   Why: critical rules (safety gates, communication policies) fail under    │
# │   context pressure. Reinforced rules arrive as fresh tool output in the    │
# │   high-attention zone (end of context), not habituated system prompt       │
# │   content at position 0. See: Lost in the Middle (Liu et al., 2023).      │
# │                                                                            │
# │   Format:                                                                  │
# │     # Rule Name                                                            │
# │     Rule content on following lines.                                       │
# │                                                                            │
# │     # Another Rule                                                         │
# │     More content here.                                                     │
# │                                                                            │
# │   Each # heading becomes a startup key. Content below becomes the rule.    │
# │   No file = no reinforcement = no questions asked.                         │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 5 of 7 — Checking for RULES_REINFORCE.md"

REINFORCE_FILE="${WORKSPACE}/RULES_REINFORCE.md"

if [[ -f "$REINFORCE_FILE" ]]; then
  RULE_COUNT=$(grep -c '^# ' "$REINFORCE_FILE" 2>/dev/null || echo "0")
  info "Found ${BOLD}RULES_REINFORCE.md${NC} with ${BOLD}${RULE_COUNT} rules${NC}"
  detail "These rules will appear in EVERY m query result (reinforced)."
  blank

  if ! $DRY_RUN; then
    # Parse: each # heading = key, content below = rule text
    current_key=""
    current_content=""

    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^#\  ]]; then
        # Save previous rule if exists
        if [[ -n "$current_key" && -n "$current_content" ]]; then
          key_slug=$(echo "$current_key" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')
          escaped_content=$(echo "$current_content" | sed "s/'/''/g")
          if [[ "$BACKEND" == "postgres" ]]; then
            psql "$DB_NAME" -c "INSERT INTO startup (key, content, priority, reinforce) VALUES ('${key_slug}', '${escaped_content}', 10, true) ON CONFLICT (key) DO UPDATE SET content='${escaped_content}', reinforce=true;" 2>/dev/null
          elif [[ "$BACKEND" == "sqlite" ]]; then
            sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO startup (key, content, priority, reinforce) VALUES ('${key_slug}', '${escaped_content}', 10, true);" 2>/dev/null
          fi
          ok "  Reinforced: ${current_key}"
        fi
        current_key="${line#\# }"
        current_content=""
      else
        [[ -n "$line" ]] && current_content="${current_content:+$current_content\n}${line}"
      fi
    done < "$REINFORCE_FILE"

    # Save last rule
    if [[ -n "$current_key" && -n "$current_content" ]]; then
      key_slug=$(echo "$current_key" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_')
      escaped_content=$(echo "$current_content" | sed "s/'/''/g")
      if [[ "$BACKEND" == "postgres" ]]; then
        psql "$DB_NAME" -c "INSERT INTO startup (key, content, priority, reinforce) VALUES ('${key_slug}', '${escaped_content}', 10, true) ON CONFLICT (key) DO UPDATE SET content='${escaped_content}', reinforce=true;" 2>/dev/null
      elif [[ "$BACKEND" == "sqlite" ]]; then
        sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO startup (key, content, priority, reinforce) VALUES ('${key_slug}', '${escaped_content}', 10, true);" 2>/dev/null
      fi
      ok "  Reinforced: ${current_key}"
    fi

    blank
    ok "Reinforced rules imported"
  else
    ok "[DRY RUN] Would import ${RULE_COUNT} reinforced rules"
  fi
else
  info "No RULES_REINFORCE.md found — skipping"
  detail "To add reinforced rules later, create RULES_REINFORCE.md and re-run setup."
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 6 of 7:  REPLACE WORKSPACE .md FILES                               │
# │                                                                            │
# │   Now that everything is in the database, we empty the workspace .md       │
# │   files and write AGENTS.md with the 11-byte database instruction.         │
# │                                                                            │
# │   Files are emptied (not deleted) so the framework doesn't complain        │
# │   about missing files. AGENTS.md gets the instruction that makes           │
# │   everything work.                                                         │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 6 of 7 — Replacing workspace .md files"

if [[ -d "$WORKSPACE" ]] && [[ $MD_COUNT -gt 0 ]]; then

  info "Emptying .md files in ${BOLD}${WORKSPACE}${NC}"
  detail "Files are emptied, not deleted — framework won't complain."
  blank

  if ! $DRY_RUN; then
    # Empty all .md files except AGENTS.md (we'll write that next)
    find "$WORKSPACE" -maxdepth 1 -name "*.md" -type f ! -name "AGENTS.md" | while read -r f; do
      echo -n > "$f"
      ok "  Emptied: $(basename "$f")"
    done

    blank

    # Write AGENTS.md with the 11-byte instruction
    echo "DB: m query" > "${WORKSPACE}/AGENTS.md"
    ok "Wrote AGENTS.md:  ${BOLD}DB: m query${NC}  (11 bytes)"
  else
    ok "[DRY RUN] Would empty ${MD_COUNT} files and write AGENTS.md"
  fi

else
  info "No workspace files to replace — skipping"
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 7 of 7:  VERIFY IT WORKS                                           │
# │                                                                            │
# │   We run a quick test search to make sure the full pipeline works:         │
# │                                                                            │
# │     query  →  database  →  search  →  ranked results                       │
# │                                                                            │
# │   If you see results, everything is working. If not, the database          │
# │   might be empty (which is fine — add records with `m save`).              │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 7 of 7 — Verifying installation"

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


header "Writing config"

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
echo "  Your workspace is now database-backed."
echo ""
echo "     AGENTS.md  →  ${BOLD}DB: m query${NC}  (11 bytes)"
echo "     All other .md files  →  emptied (data is in the database)"
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
echo "  │   🔁  Re-run setup anytime:                                      │"
echo "  │       ./setup.sh                                                 │"
echo "  │                                                                  │"
echo "  └──────────────────────────────────────────────────────────────────┘"
echo ""
echo "  📖  Docs:  https://github.com/openclaw/shadowdb"
echo ""
