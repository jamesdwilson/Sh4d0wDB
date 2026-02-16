#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                                                                            ║
# ║                          ShadowDB — Setup                                  ║
# ║                                                                            ║
# ║   Install or update ShadowDB, the database-backed memory plugin for       ║
# ║   OpenClaw. One command does everything.                                   ║
# ║                                                                            ║
# ║   INSTALL:                                                                 ║
# ║     curl -fsSL https://raw.githubusercontent.com/jamesdwilson/             ║
# ║       Sh4d0wDB/main/setup.sh | bash                                       ║
# ║                                                                            ║
# ║   UPDATE:                                                                  ║
# ║     Same command. Re-runnable. Pulls latest, updates deps, restarts.       ║
# ║                                                                            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
#
#   FLAGS:
#
#     --dir <path>          Where to clone/find ShadowDB
#                           (default: ~/projects/ShadowDB)
#
#     --backend <type>      Database backend: postgres or sqlite
#                           (default: postgres)
#
#     --dry-run             Preview everything without making changes
#
#     --yes                 Skip confirmation prompts
#
#     --help                Show this help
#
# ════════════════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO_URL="https://github.com/jamesdwilson/Sh4d0wDB.git"
INSTALL_DIR="${SHADOWDB_DIR:-$HOME/projects/ShadowDB}"
WORKSPACE="${HOME}/.openclaw/workspace"
BACKEND="postgres"
DB_NAME="shadow"
DRY_RUN=false
AUTO_YES=false
TODAY=$(date +%Y-%m-%d)


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

  Install:
    curl -fsSL https://raw.githubusercontent.com/jamesdwilson/Sh4d0wDB/main/setup.sh | bash

  Update:
    Same command. Pulls latest code, updates deps, restarts gateway.

  Flags:
    --dir <path>        Where to clone ShadowDB (default: ~/projects/ShadowDB)
    --backend <type>    Database backend: postgres or sqlite (default: postgres)
    --dry-run           Preview without making changes
    --yes               Skip confirmation prompts
    --help, -h          Show this help

EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)       INSTALL_DIR="$2"; shift 2 ;;
    --backend)   BACKEND="$2";     shift 2 ;;
    --dry-run)   DRY_RUN=true;     shift   ;;
    --yes|-y)    AUTO_YES=true;    shift   ;;
    --help|-h)   usage ;;
    *) echo "  Unknown option: $1"; usage ;;
  esac
done


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
echo "  ║   Database-backed memory for OpenClaw.               ║"
echo "  ║   Install or update — same command, always safe.     ║"
echo "  ║                                                      ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""

info "Install dir: ${BOLD}${INSTALL_DIR}${NC}"
info "Backend:     ${BOLD}${BACKEND}${NC}"

if $DRY_RUN; then
  blank
  warn "DRY RUN — nothing will be changed. This is a preview."
fi

blank

if ! confirm "Continue?"; then
  info "Aborted. Nothing was changed."
  exit 0
fi

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 1 of 6:  CLONE OR UPDATE REPO                                      │
# │                                                                            │
# │   Fresh install: git clone into INSTALL_DIR                                │
# │   Update: git pull to get latest code                                      │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 1 of 6 — Getting ShadowDB"

IS_UPDATE=false

if [[ -d "$INSTALL_DIR/.git" ]]; then
  IS_UPDATE=true
  info "Existing install found — updating..."

  if ! $DRY_RUN; then
    (cd "$INSTALL_DIR" && git pull --ff-only 2>&1 | tail -3)
    ok "Updated to latest"
  else
    ok "[DRY RUN] Would git pull in $INSTALL_DIR"
  fi

elif [[ -d "$INSTALL_DIR" ]]; then
  # Directory exists but isn't a git repo
  fail "$INSTALL_DIR exists but isn't a git repo. Remove it or use --dir <other-path>."

else
  info "Cloning ShadowDB..."

  if ! $DRY_RUN; then
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | tail -3
    ok "Cloned to ${INSTALL_DIR}"
  else
    ok "[DRY RUN] Would clone to $INSTALL_DIR"
  fi
fi

# Now we know where everything is
SCRIPT_DIR="$INSTALL_DIR"

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 2 of 6:  CHECK PREREQUISITES                                       │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 2 of 6 — Checking prerequisites"

MISSING=0

# ── Python 3 ──────────────────────────────────────────────────────────────
#
#   Required. The `m` search CLI and all backend adapters are Python.

if command -v node &>/dev/null; then
  ok "node found"
  detail "$(node --version 2>&1)"
else
  warn "node not found — required for OpenClaw and this plugin"
  detail "Install: brew install node   (macOS)"
  detail "         apt install nodejs   (Ubuntu/Debian)"
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
# │   Uses node (already required for OpenClaw) to safely merge into           │
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
  if node -e "
const cfg = JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG','utf8'));
process.exit(cfg.plugins?.entries?.['memory-shadowdb'] ? 0 : 1);
" 2>/dev/null; then
    ok "Plugin already wired in OpenClaw config — skipping"

    if $IS_UPDATE; then
      # On update, refresh the load path in case the install dir moved
      info "Verifying plugin path is current..."
      if ! $DRY_RUN; then
        node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG','utf8'));
const paths = cfg.plugins?.load?.paths || [];
const want = '$PLUGIN_ABS_PATH';
if (!paths.includes(want)) {
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.load = cfg.plugins.load || {};
  cfg.plugins.load.paths = [...paths.filter(p => !p.includes('memory-shadowdb')), want];
  fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 2) + '\n');
  console.log('  ✓  Updated plugin path');
} else {
  console.log('  ✓  Plugin path is current');
}
"
      fi
    fi

    blank
  else
    info "Patching ${BOLD}${OPENCLAW_CONFIG}${NC}"
    detail "Adding: plugins.load.paths, plugins.slots.memory, plugins.entries.memory-shadowdb"
    blank

    if ! $DRY_RUN; then

      # Back up config first
      cp "$OPENCLAW_CONFIG" "${OPENCLAW_CONFIG}.pre-shadowdb-backup"
      ok "Config backed up to ${OPENCLAW_CONFIG}.pre-shadowdb-backup"

      node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf8'));
const pluginPath = '$PLUGIN_ABS_PATH';

// Ensure plugins section
cfg.plugins = cfg.plugins || {};
cfg.plugins.load = cfg.plugins.load || {};
cfg.plugins.load.paths = cfg.plugins.load.paths || [];
if (!cfg.plugins.load.paths.includes(pluginPath)) {
  cfg.plugins.load.paths.push(pluginPath);
}

// Set memory slot
cfg.plugins.slots = cfg.plugins.slots || {};
cfg.plugins.slots.memory = 'memory-shadowdb';

// Add plugin entry
cfg.plugins.entries = cfg.plugins.entries || {};
if (!cfg.plugins.entries['memory-shadowdb']) {
  cfg.plugins.entries['memory-shadowdb'] = {
    enabled: true,
    config: {
      embedding: {
        provider: 'ollama',
        model: 'nomic-embed-text',
        dimensions: 768,
        ollamaUrl: 'http://localhost:11434'
      },
      table: 'memories',
      search: {
        maxResults: 6,
        minScore: 0.15,
        vectorWeight: 0.7,
        textWeight: 0.3,
        recencyWeight: 0.15
      },
      writes: {
        enabled: true,
        autoEmbed: true,
        retention: { purgeAfterDays: 30 }
      }
    }
  };
}

fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 2) + '\n');
console.log('  ✓  OpenClaw config patched successfully');
"

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
echo "  │   📦  Config backup: ${OPENCLAW_CONFIG}.pre-shadowdb-backup"
echo "  │                                                                  │"
echo "  │   🔁  Update anytime (same install command):                     │"
echo "  │       curl -fsSL https://raw.githubusercontent.com/              │"
echo "  │         jamesdwilson/Sh4d0wDB/main/setup.sh | bash               │"
echo "  │                                                                  │"
echo "  └──────────────────────────────────────────────────────────────────┘"
echo ""
echo "  📖  Docs:  https://github.com/jamesdwilson/Sh4d0wDB"
echo ""
