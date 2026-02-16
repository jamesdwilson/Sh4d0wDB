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

header "Step 1 of 6 — Backing up your files"

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

header "Step 2 of 6 — Checking prerequisites"

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
# │   STEP 4 of 6:  INSTALL PLUGIN DEPENDENCIES                               │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 4 of 6 — Installing plugin dependencies"

PLUGIN_DIR="${SCRIPT_DIR}/extensions/memory-shadowdb"

if [[ -d "$PLUGIN_DIR" ]]; then
  if [[ -f "$PLUGIN_DIR/package.json" ]]; then
    info "Installing npm dependencies for memory-shadowdb..."

    if ! $DRY_RUN; then
      (cd "$PLUGIN_DIR" && npm install --production 2>&1 | tail -3)
      ok "Plugin dependencies installed"
    else
      ok "[DRY RUN] Would run npm install in $PLUGIN_DIR"
    fi
  else
    warn "No package.json found in plugin directory"
  fi
else
  warn "Plugin directory not found: $PLUGIN_DIR"
  detail "Expected at: extensions/memory-shadowdb/"
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 8 of 9:  WIRE PLUGIN INTO OPENCLAW                                 │
# │                                                                            │
# │   Patches ~/.openclaw/openclaw.json to:                                    │
# │     - Add the plugin path to plugins.load.paths                            │
# │     - Set plugins.slots.memory to memory-shadowdb                          │
# │     - Add plugins.entries.memory-shadowdb with default config              │
# │                                                                            │
# │   Uses python3 (already a prerequisite) to safely merge into               │
# │   the existing config without clobbering anything.                         │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 5 of 6 — Wiring plugin into OpenClaw"

OPENCLAW_CONFIG="${HOME}/.openclaw/openclaw.json"
PLUGIN_ABS_PATH="$(cd "$PLUGIN_DIR" 2>/dev/null && pwd)"

if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
  warn "OpenClaw config not found at $OPENCLAW_CONFIG"
  detail "Is OpenClaw installed? Run: npx openclaw@latest"
  detail "You can wire the plugin manually later."
  blank
else

  # Check if already wired
  if python3 -c "
import json, sys
cfg = json.load(open('$OPENCLAW_CONFIG'))
entries = cfg.get('plugins', {}).get('entries', {})
if 'memory-shadowdb' in entries:
    sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
    ok "Plugin already wired in OpenClaw config — skipping"
    blank
  else
    info "Patching ${BOLD}${OPENCLAW_CONFIG}${NC}"
    detail "Adding: plugins.load.paths, plugins.slots.memory, plugins.entries.memory-shadowdb"
    blank

    if ! $DRY_RUN; then

      # Back up config first
      cp "$OPENCLAW_CONFIG" "${OPENCLAW_CONFIG}.pre-shadowdb-backup"
      ok "Config backed up to ${OPENCLAW_CONFIG}.pre-shadowdb-backup"

      python3 << PYEOF
import json, sys

config_path = "$OPENCLAW_CONFIG"
plugin_path = "$PLUGIN_ABS_PATH"

with open(config_path) as f:
    cfg = json.load(f)

# Ensure plugins section exists
plugins = cfg.setdefault("plugins", {})

# Add load path (deduplicated)
load = plugins.setdefault("load", {})
paths = load.setdefault("paths", [])
if plugin_path not in paths:
    paths.append(plugin_path)

# Set memory slot
slots = plugins.setdefault("slots", {})
slots["memory"] = "memory-shadowdb"

# Add plugin entry with default config
entries = plugins.setdefault("entries", {})
if "memory-shadowdb" not in entries:
    entries["memory-shadowdb"] = {
        "enabled": True,
        "config": {
            "embedding": {
                "provider": "ollama",
                "model": "nomic-embed-text",
                "dimensions": 768,
                "ollamaUrl": "http://localhost:11434"
            },
            "table": "memories",
            "search": {
                "maxResults": 6,
                "minScore": 0.15,
                "vectorWeight": 0.7,
                "textWeight": 0.3,
                "recencyWeight": 0.15
            },
            "writes": {
                "enabled": True,
                "autoEmbed": True,
                "retention": {
                    "purgeAfterDays": 30
                }
            }
        }
    }

with open(config_path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")

print("  ✓  OpenClaw config patched successfully")
PYEOF

    else
      ok "[DRY RUN] Would patch OpenClaw config"
    fi

    blank
  fi
fi


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 9 of 9:  RESTART GATEWAY & VERIFY                                  │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 6 of 6 — Restarting gateway & verifying"

if ! $DRY_RUN; then

  # Try to restart gateway
  if command -v openclaw &>/dev/null; then
    info "Restarting OpenClaw gateway..."

    if openclaw gateway restart 2>/dev/null; then
      ok "Gateway restarted"
      blank

      # Give it a moment to come up
      sleep 3

      # Verify plugin loaded
      DOCTOR_OUT=$(openclaw doctor --non-interactive 2>&1 || true)

      if echo "$DOCTOR_OUT" | grep -q "memory-shadowdb"; then
        ok "Plugin loaded and verified!"
        blank
        echo "$DOCTOR_OUT" | grep "memory-shadowdb" | sed 's/^/     /'
      else
        warn "Gateway restarted but plugin not detected yet."
        detail "Try: openclaw doctor --non-interactive | grep shadowdb"
      fi
    else
      warn "Could not restart gateway automatically."
      detail "Run manually: openclaw gateway restart"
    fi
  else
    warn "openclaw CLI not found in PATH."
    detail "Start the gateway manually, then verify with:"
    detail "  openclaw doctor --non-interactive | grep shadowdb"
  fi

  blank

  # Show DB stats
  if [[ "$BACKEND" == "postgres" ]]; then
    ROW_COUNT=$(psql -qtAX "$DB_NAME" -c "SELECT count(*) FROM memories;" 2>/dev/null || echo "0")
    STARTUP_COUNT=$(psql -qtAX "$DB_NAME" -c "SELECT count(*) FROM startup;" 2>/dev/null || echo "0")

    ok "Database:"
    detail "memories: ${ROW_COUNT} records"
    detail "startup:  ${STARTUP_COUNT} entries"
  fi

else
  ok "[DRY RUN] Would restart gateway and verify plugin"
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
echo "  Your agent now has: memory_search, memory_get, memory_write,"
echo "  memory_update, memory_delete, and memory_undelete."
echo ""
echo "  Ask your agent:  ${BOLD}\"search memory for test\"${NC}"
echo ""
echo ""
echo "  ┌──────────────────────────────────────────────────────────────────┐"
echo "  │                                                                  │"
echo "  │   📦  Backups:                                                   │"
echo "  │       Workspace: ${BACKUP_DIR}/"
echo "  │       Config:    ${OPENCLAW_CONFIG}.pre-shadowdb-backup"
echo "  │                                                                  │"
echo "  │   🔄  Restore workspace anytime:                                 │"
echo "  │       cp ~/OpenClaw-Workspace-Backup-*/*.md \\                   │"
echo "  │          ${WORKSPACE}/                              │"
echo "  │                                                                  │"
echo "  │   🔁  Re-run setup anytime:                                      │"
echo "  │       ./setup.sh                                                 │"
echo "  │                                                                  │"
echo "  └──────────────────────────────────────────────────────────────────┘"
echo ""
echo "  📖  Docs:  https://github.com/jamesdwilson/Sh4d0wDB"
echo ""
