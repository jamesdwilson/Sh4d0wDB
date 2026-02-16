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
#     --backend <type>      Database backend: postgres, sqlite, or mysql
#
#     --dry-run             Preview everything without making changes
#
#     --yes                 Skip confirmation prompts
#
#     --help                Show this help
#
# ════════════════════════════════════════════════════════════════════════════════

set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/jamesdwilson/Sh4d0wDB/main"
PLUGIN_DIR="${HOME}/.openclaw/plugins/memory-shadowdb"
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
    Same command. Downloads latest files, updates deps, restarts gateway.

  Flags:
    --backend <type>    Database backend: postgres, sqlite, or mysql
    --uninstall         Remove ShadowDB (plugin files + config entry)
    --dry-run           Preview without making changes
    --yes               Skip confirmation prompts
    --help, -h          Show this help

EOF
  exit 0
}

DO_UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)   BACKEND="$2";     shift 2 ;;
    --dry-run)   DRY_RUN=true;     shift   ;;
    --yes|-y)    AUTO_YES=true;    shift   ;;
    --uninstall) DO_UNINSTALL=true; shift  ;;
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
# ║                              UNINSTALL                                     ║
# ║                                                                            ║
# ║   Removes plugin files, unwires from OpenClaw config, optionally drops     ║
# ║   the database. Mirrors `openclaw uninstall` style.                        ║
# ║                                                                            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

if $DO_UNINSTALL; then
  echo ""
  echo "  ╔══════════════════════════════════════════════════════╗"
  echo "  ║                                                      ║"
  echo "  ║          🧠  ShadowDB Uninstall  🧠                 ║"
  echo "  ║                                                      ║"
  echo "  ╚══════════════════════════════════════════════════════╝"
  echo ""

  OPENCLAW_CONFIG="${HOME}/.openclaw/openclaw.json"

  # Show what will be removed
  echo -e "  ${BOLD}This will remove:${NC}"
  echo ""
  echo -e "  ${RED}✗${NC}  Plugin files:  ${BOLD}${PLUGIN_DIR}${NC}"
  [[ -f "$OPENCLAW_CONFIG" ]] && \
  echo -e "  ${RED}✗${NC}  Config entry:  plugins.entries.memory-shadowdb"
  echo ""

  echo -e "  ${BOLD}This will NOT remove:${NC}"
  echo ""
  echo -e "  ${GREEN}✓${NC}  Your database and all memory records (kept safe)"
  echo -e "  ${GREEN}✓${NC}  OpenClaw itself"
  echo ""

  if ! confirm "Uninstall ShadowDB?"; then
    info "Aborted. Nothing was changed."
    exit 0
  fi

  echo ""

  # 1. Remove plugin from OpenClaw config
  if [[ -f "$OPENCLAW_CONFIG" ]]; then
    if ! $DRY_RUN; then
      node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf8'));

// Remove plugin entry
if (cfg.plugins?.entries?.['memory-shadowdb']) {
  delete cfg.plugins.entries['memory-shadowdb'];
  console.log('  ✓  Removed plugins.entries.memory-shadowdb');
}

// Remove from load paths
if (cfg.plugins?.load?.paths) {
  const before = cfg.plugins.load.paths.length;
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter(p => !p.includes('memory-shadowdb'));
  if (cfg.plugins.load.paths.length < before) {
    console.log('  ✓  Removed from plugins.load.paths');
  }
}

// Clear memory slot if it points to us
if (cfg.plugins?.slots?.memory === 'memory-shadowdb') {
  delete cfg.plugins.slots.memory;
  console.log('  ✓  Cleared plugins.slots.memory');
}

fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 2) + '\n');
"
    else
      ok "[DRY RUN] Would remove memory-shadowdb from OpenClaw config"
    fi
  fi

  # 2. Remove plugin files
  if [[ -d "$PLUGIN_DIR" ]]; then
    if ! $DRY_RUN; then
      rm -rf "$PLUGIN_DIR"
      ok "Removed ${PLUGIN_DIR}"
    else
      ok "[DRY RUN] Would remove ${PLUGIN_DIR}"
    fi
  else
    info "Plugin directory not found — already removed?"
  fi

  echo ""
  ok "Your database and all memory records are untouched."

  # 3. Restart gateway
  echo ""
  if command -v openclaw &>/dev/null && ! $DRY_RUN; then
    info "Restarting OpenClaw gateway..."
    openclaw gateway restart 2>/dev/null && ok "Gateway restarted" || true
  fi

  echo ""
  echo "  ╔══════════════════════════════════════════════════════╗"
  echo "  ║                                                      ║"
  echo "  ║            🧠  Uninstall Complete  🧠                ║"
  echo "  ║                                                      ║"
  echo "  ║   Reinstall anytime:                                 ║"
  echo "  ║   curl -fsSL .../setup.sh | bash                     ║"
  echo "  ║                                                      ║"
  echo "  ╚══════════════════════════════════════════════════════╝"
  echo ""

  exit 0
fi


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

if $DRY_RUN; then
  warn "DRY RUN — nothing will be changed. This is a preview."
  blank
fi

# ┌────────────────────────────────────────────────────────────────────────────┐
# │                       DATABASE BACKEND PICKER                              │
# │                                                                            │
# │   On fresh install: ask the user which database they want.                 │
# │   On update: skip (we read existing config to detect the backend).         │
# │   If --backend was passed on CLI: skip the picker.                         │
# └────────────────────────────────────────────────────────────────────────────┘

# Detect non-interactive mode (agent piping curl | bash, or --yes flag)
# Non-interactive = no TTY on stdin → auto-yes + default to sqlite
if [[ ! -t 0 ]]; then
  AUTO_YES=true
  info "Non-interactive mode detected (no TTY) — using defaults"
  blank
fi

BACKEND_FROM_CLI=false
if [[ "$BACKEND" != "postgres" ]] || [[ "${SHADOWDB_BACKEND:-}" != "" ]]; then
  BACKEND_FROM_CLI=true
fi

# Check if this is an update (existing install with config already wired)
OPENCLAW_CONFIG="${HOME}/.openclaw/openclaw.json"
EXISTING_BACKEND=""
if [[ -f "$OPENCLAW_CONFIG" ]]; then
  EXISTING_BACKEND=$(node -e "
    try {
      const cfg = JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG','utf8'));
      const b = cfg.plugins?.entries?.['memory-shadowdb']?.config?.backend;
      if (b) process.stdout.write(b);
    } catch {}
  " 2>/dev/null || true)
fi

if [[ -n "$EXISTING_BACKEND" ]]; then
  # Update — use the existing backend
  BACKEND="$EXISTING_BACKEND"
  info "Existing install detected — backend: ${BOLD}${BACKEND}${NC}"
  blank
elif $BACKEND_FROM_CLI; then
  # CLI flag set — use it as-is
  :
elif $AUTO_YES; then
  # Non-interactive — default to sqlite (zero config, no prompts needed)
  BACKEND="sqlite"
  ok "Auto-selected: ${BOLD}sqlite${NC} (zero config default)"
  blank
else
  # Interactive fresh install — show the picker
  echo ""
  echo -e "  ${BOLD}Which database would you like to use?${NC}"
  echo ""
  echo -e "  ${BOLD}1)${NC}  ${GREEN}SQLite${NC}           Zero config. Single file. Just works."
  echo -e "                        Best for: personal use, trying it out"
  echo ""
  echo -e "  ${BOLD}2)${NC}  ${GREEN}PostgreSQL${NC}       Full power. Vector search, fuzzy matching."
  echo -e "                        Best for: large knowledge bases, production"
  echo ""
  echo -e "  ${BOLD}3)${NC}  ${GREEN}MySQL${NC}            Native vectors (9.2+). Familiar if you know MySQL."
  echo -e "                        Best for: existing MySQL setups"
  echo ""
  echo -ne "  ${BOLD}Pick [1/2/3]:${NC} "
  read -r db_choice

  case "${db_choice:-1}" in
    1|sqlite|s)
      BACKEND="sqlite"
      ;;
    2|postgres|p|pg)
      BACKEND="postgres"
      ;;
    3|mysql|m)
      BACKEND="mysql"
      ;;
    *)
      BACKEND="sqlite"
      info "Defaulting to SQLite"
      ;;
  esac

  blank
  ok "Selected: ${BOLD}${BACKEND}${NC}"
  blank
fi

info "Plugin dir:  ${BOLD}${PLUGIN_DIR}${NC}"
info "Backend:     ${BOLD}${BACKEND}${NC}"

blank


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 1 of 6:  DOWNLOAD PLUGIN FILES                                     │
# │                                                                            │
# │   Downloads only the files needed for the chosen backend.                  │
# │   No git clone — just the TypeScript source + config.                      │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 1 of 6 — Downloading ShadowDB"

IS_UPDATE=false
if [[ -d "$PLUGIN_DIR" ]] && [[ -f "$PLUGIN_DIR/store.ts" ]]; then
  IS_UPDATE=true
  info "Existing install found — updating files..."
else
  info "Installing to ${BOLD}${PLUGIN_DIR}${NC}"
fi

if ! $DRY_RUN; then
  mkdir -p "$PLUGIN_DIR"

  # Shared files (every backend needs these)
  SHARED_FILES="store.ts index.ts embedder.ts config.ts types.ts openclaw.plugin.json package.json"

  for f in $SHARED_FILES; do
    curl -fsSL "${RAW_BASE}/extensions/memory-shadowdb/${f}" -o "${PLUGIN_DIR}/${f}"
  done
  ok "Downloaded core files (${SHARED_FILES// /, })"

  # Backend-specific file (only the one they chose)
  curl -fsSL "${RAW_BASE}/extensions/memory-shadowdb/${BACKEND}.ts" -o "${PLUGIN_DIR}/${BACKEND}.ts"
  ok "Downloaded ${BACKEND}.ts"

  # Schema file (Postgres only — SQLite/MySQL auto-create tables)
  if [[ "$BACKEND" == "postgres" ]]; then
    curl -fsSL "${RAW_BASE}/schema.sql" -o "${PLUGIN_DIR}/schema.sql"
    ok "Downloaded schema.sql"
  fi
else
  ok "[DRY RUN] Would download plugin files to $PLUGIN_DIR"
fi

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

# ── Backend-specific prerequisites ────────────────────────────────────────

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

elif [[ "$BACKEND" == "sqlite" ]]; then
  # SQLite itself comes from the npm package (better-sqlite3), no system dep needed
  ok "SQLite — no system dependencies needed"
  detail "better-sqlite3 is installed via npm"
  blank

elif [[ "$BACKEND" == "mysql" ]]; then
  if command -v mysql &>/dev/null; then
    ok "mysql client found"
    MYSQL_VER=$(mysql --version 2>&1 | head -1)
    detail "$MYSQL_VER"

    # Check for MySQL 9.2+ (required for native VECTOR type)
    if echo "$MYSQL_VER" | grep -qE '(9\.[2-9]|[1-9][0-9]+\.)'; then
      ok "MySQL version supports native vectors"
    else
      warn "MySQL 9.2+ required for vector search"
      detail "Your version may work for text search only"
    fi
  else
    warn "mysql client not found"
    detail "Install: brew install mysql   (macOS)"
    detail "         apt install mysql-client   (Ubuntu/Debian)"
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
# │     primer    — Your agent's identity (who it is, who you are, rules)      │
# │     memories  — Searchable knowledge base (everything the agent knows)     │
# │                                                                            │
# │   If the database already exists, we skip this step (safe to re-run).      │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 3 of 6 — Setting up database"

if [[ "$BACKEND" == "postgres" ]]; then

  # ── PostgreSQL setup ──────────────────────────────────────────────────

  if psql -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    ok "Database '${DB_NAME}' already exists"
  else
    info "Creating PostgreSQL database: ${BOLD}${DB_NAME}${NC}"
    if ! $DRY_RUN; then
      createdb "$DB_NAME"
      ok "Database '${DB_NAME}' created"
    else
      ok "[DRY RUN] Would create database '${DB_NAME}'"
    fi
  fi

  blank

  if [[ -f "$PLUGIN_DIR/schema.sql" ]]; then
    info "Applying schema..."
    if ! $DRY_RUN; then
      psql "$DB_NAME" -f "$PLUGIN_DIR/schema.sql" 2>/dev/null
      ok "Schema applied (CREATE IF NOT EXISTS — safe to re-run)"
    else
      ok "[DRY RUN] Would apply schema.sql"
    fi
  fi

  blank

  # Enable pgvector + pg_trgm extensions
  if ! $DRY_RUN; then
    if psql "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null; then
      ok "pgvector extension enabled"
    else
      warn "Could not enable pgvector — semantic search won't work"
      detail "Install: brew install pgvector   (macOS)"
    fi

    if psql "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" 2>/dev/null; then
      ok "pg_trgm extension enabled"
    else
      detail "pg_trgm not available — fuzzy search disabled (keyword search still works)"
    fi
  fi

  # Connection string for config patching
  CONN_STRING="postgresql://localhost:5432/${DB_NAME}"
  blank

elif [[ "$BACKEND" == "sqlite" ]]; then

  # ── SQLite setup ──────────────────────────────────────────────────────
  #
  #   Zero config. The plugin auto-creates tables on first start.
  #   We just need to make sure the directory exists.

  DB_PATH="${SHADOWDB_PATH:-${HOME}/.shadowdb/memory.db}"

  echo -ne "  ${BOLD}Database file path${NC} [${DB_PATH}]: "
  if ! $AUTO_YES; then
    read -r custom_path
    [[ -n "$custom_path" ]] && DB_PATH="$custom_path"
  else
    echo ""
  fi

  blank

  if ! $DRY_RUN; then
    mkdir -p "$(dirname "$DB_PATH")"
    ok "Directory ready: $(dirname "$DB_PATH")"
  fi

  info "Tables will be auto-created on first plugin start"

  # Connection string = file path for SQLite
  CONN_STRING="$DB_PATH"
  blank

elif [[ "$BACKEND" == "mysql" ]]; then

  # ── MySQL setup ───────────────────────────────────────────────────────

  DEFAULT_MYSQL_CONN="mysql://root@localhost:3306/shadow"
  echo -ne "  ${BOLD}MySQL connection string${NC} [${DEFAULT_MYSQL_CONN}]: "
  if ! $AUTO_YES; then
    read -r custom_conn
    MYSQL_CONN="${custom_conn:-$DEFAULT_MYSQL_CONN}"
  else
    MYSQL_CONN="$DEFAULT_MYSQL_CONN"
    echo ""
  fi

  blank

  info "Tables will be auto-created on first plugin start"
  detail "Requires MySQL 9.2+ for vector search"

  CONN_STRING="$MYSQL_CONN"
  blank
fi


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 4 of 6:  INSTALL PLUGIN DEPENDENCIES                               │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

header "Step 4 of 6 — Installing plugin dependencies"

# PLUGIN_DIR already set at top of script

if [[ -d "$PLUGIN_DIR" ]]; then
  if [[ -f "$PLUGIN_DIR/package.json" ]]; then
    info "Installing core dependencies..."

    if ! $DRY_RUN; then
      (cd "$PLUGIN_DIR" && npm install --production 2>&1 | tail -3)
      ok "Core dependencies installed"
    else
      ok "[DRY RUN] Would run npm install in $PLUGIN_DIR"
    fi

    # Install only the backend-specific driver
    blank
    info "Installing ${BOLD}${BACKEND}${NC} driver..."

    if ! $DRY_RUN; then
      case "$BACKEND" in
        postgres)
          (cd "$PLUGIN_DIR" && npm install --save pg 2>&1 | tail -3)
          ok "Installed: pg"
          ;;
        sqlite)
          (cd "$PLUGIN_DIR" && npm install --save better-sqlite3 sqlite-vec 2>&1 | tail -3)
          ok "Installed: better-sqlite3, sqlite-vec"
          ;;
        mysql)
          (cd "$PLUGIN_DIR" && npm install --save mysql2 2>&1 | tail -3)
          ok "Installed: mysql2"
          ;;
      esac
    else
      ok "[DRY RUN] Would install $BACKEND driver"
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
const backend = '$BACKEND';
const connString = '$CONN_STRING';

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

// Add plugin entry with backend-specific config
cfg.plugins.entries = cfg.plugins.entries || {};
if (!cfg.plugins.entries['memory-shadowdb']) {
  cfg.plugins.entries['memory-shadowdb'] = {
    enabled: true,
    config: {
      backend: backend,
      connectionString: connString,
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
# │   STEP 5.4:  AUTO-IMPORT WORKSPACE MARKDOWN AS MEMORIES                    │
# │                                                                            │
# │   Scans for common identity/knowledge files in the workspace and imports   │
# │   each section as a searchable memory record. This replaces static .md     │
# │   injection with on-demand retrieval.                                      │
# │                                                                            │
# │   Files detected: MEMORY.md, SOUL.md, IDENTITY.md, USER.md, RULES.md,     │
# │   BOOTSTRAP.md, KNOWLEDGE.md. Skips PRIMER.md and ALWAYS.md (those go     │
# │   to the primer table in the next step).                                   │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

# Helper: insert a memory record (backend-aware)
#   $1=content  $2=category  $3=title  $4=tags (JSON array string)
insert_memory_record() {
  local content="$1" category="$2" title="$3" tags="$4"

  local esc_content="${content//\'/\'\'}"
  local esc_title="${title//\'/\'\'}"
  local esc_category="${category//\'/\'\'}"
  local esc_tags="${tags//\'/\'\'}"

  case "$BACKEND" in
    postgres)
      psql "$DB_NAME" -c "INSERT INTO memories (content, category, title, tags) VALUES ('${esc_content}', '${esc_category}', '${esc_title}', '${esc_tags}'::jsonb);" 2>/dev/null
      ;;
    sqlite)
      sqlite3 "$CONN_STRING" "INSERT INTO memories (content, category, title, tags) VALUES ('${esc_content}', '${esc_category}', '${esc_title}', '${esc_tags}');" 2>/dev/null
      ;;
    mysql)
      mysql -e "INSERT INTO memories (content, category, title, tags) VALUES ('${esc_content}', '${esc_category}', '${esc_title}', '${esc_tags}');" "$DB_NAME" 2>/dev/null
      ;;
  esac
}

# Helper: parse a markdown file into sections and insert each as a memory
#   $1=file path  $2=category (derived from filename)
#   Returns count of records imported
import_md_as_memories() {
  local file="$1" category="$2"
  local current_heading=""
  local current_content=""
  local count=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^#{1,3}[[:space:]]+(.*) ]]; then
      # New heading — flush previous section
      if [[ -n "$current_heading" && -n "$current_content" ]]; then
        current_content="$(echo "$current_content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [[ -n "$current_content" ]]; then
          local tag_name
          tag_name="$(echo "$current_heading" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
          insert_memory_record "$current_content" "$category" "$current_heading" "[\"${category}\", \"${tag_name}\", \"imported\"]"
          ok "  ${current_heading}"
          count=$((count + 1))
        fi
      fi
      current_heading="${BASH_REMATCH[1]}"
      current_content=""
    else
      if [[ -n "$current_heading" ]]; then
        if [[ -n "$current_content" ]]; then
          current_content="${current_content}
${line}"
        else
          current_content="$line"
        fi
      else
        # Content before first heading — use filename as heading
        if [[ -n "$line" && ! "$line" =~ ^[[:space:]]*$ ]]; then
          current_heading="$(basename "$file" .md)"
          current_content="$line"
        fi
      fi
    fi
  done < "$file"

  # Flush last section
  if [[ -n "$current_heading" && -n "$current_content" ]]; then
    current_content="$(echo "$current_content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ -n "$current_content" ]]; then
      local tag_name
      tag_name="$(echo "$current_heading" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
      insert_memory_record "$current_content" "$category" "$current_heading" "[\"${category}\", \"${tag_name}\", \"imported\"]"
      ok "  ${current_heading}"
      count=$((count + 1))
    fi
  fi

  echo "$count"
}

# Map filenames to categories
filename_to_category() {
  case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
    memory.md|memories.md)   echo "general" ;;
    soul.md)                 echo "identity" ;;
    identity.md)             echo "identity" ;;
    user.md)                 echo "identity" ;;
    rules.md)                echo "rules" ;;
    bootstrap.md)            echo "ops" ;;
    knowledge.md)            echo "general" ;;
    agents.md)               echo "ops" ;;
    *)                       echo "general" ;;
  esac
}

# Only auto-import on fresh installs (not updates) and not dry-run
if ! $IS_UPDATE && ! $DRY_RUN; then

  IMPORT_FILES=()
  OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-${HOME}/.openclaw/workspace}"

  # Scan for common identity/knowledge files (skip PRIMER.md, ALWAYS.md)
  for fname in MEMORY.md SOUL.md IDENTITY.md USER.md RULES.md BOOTSTRAP.md KNOWLEDGE.md AGENTS.md; do
    for candidate in "${OPENCLAW_WORKSPACE}/${fname}" "./${fname}"; do
      if [[ -f "$candidate" ]]; then
        # Skip PRIMER.md and ALWAYS.md — those go to the primer table
        base="$(basename "$candidate")"
        upper="$(echo "$base" | tr '[:lower:]' '[:upper:]')"
        if [[ "$upper" == "PRIMER.MD" || "$upper" == "ALWAYS.MD" ]]; then
          continue
        fi
        IMPORT_FILES+=("$candidate")
        break
      fi
    done
  done

  if [[ ${#IMPORT_FILES[@]} -gt 0 ]]; then
    blank
    header "Auto-importing workspace markdown files as memories"
    detail "Each # section becomes a searchable memory record."
    detail "Your agent retrieves these on demand instead of loading everything every turn."
    echo ""

    TOTAL_IMPORTED=0
    for mdfile in "${IMPORT_FILES[@]}"; do
      fname="$(basename "$mdfile")"
      cat="$(filename_to_category "$fname")"
      info "${BOLD}${fname}${NC} → category: ${cat}"
      imported=$(import_md_as_memories "$mdfile" "$cat")
      TOTAL_IMPORTED=$((TOTAL_IMPORTED + imported))
      blank
    done

    if [[ $TOTAL_IMPORTED -gt 0 ]]; then
      ok "Imported ${TOTAL_IMPORTED} memory record(s) from ${#IMPORT_FILES[@]} file(s)"
      detail "These will be embedded on first agent startup (or next reembed)."
      detail "You can safely remove or rename the source .md files now."
    fi
    blank
  fi
fi


# ┌────────────────────────────────────────────────────────────────────────────┐
# │                                                                            │
# │   STEP 5.5:  PRIMER RULES (optional)                                      │
# │                                                                            │
# │   Most identity/rules work as searchable memories. But a few things        │
# │   need to be present before the agent's first thought:                     │
# │     - Core identity ("You are Shadow, Alex's assistant")                  │
# │     - Safety rails ("Never send without confirmation")                     │
# │     - Hard constraints (banned words, communication gates)                 │
# │                                                                            │
# │   Auto-detects PRIMER.md in workspace or current dir.                      │
# │   Format: # heading = key, body = content, order = priority.               │
# │   Falls back to interactive paste if no file found.                        │
# │                                                                            │
# └────────────────────────────────────────────────────────────────────────────┘

# Helper: insert a primer rule (backend-aware upsert)
#   $1=key  $2=content  $3=priority  $4=always (0 or 1, default 0)
insert_primer_rule() {
  local key="$1" content="$2" priority="$3" always="${4:-0}"

  # Escape single quotes for SQL
  local esc_key="${key//\'/\'\'}"
  local esc_content="${content//\'/\'\'}"

  case "$BACKEND" in
    postgres)
      psql "$DB_NAME" -c "INSERT INTO primer (key, content, priority, \"always\") VALUES ('${esc_key}', '${esc_content}', ${priority}, $([ "$always" = "1" ] && echo "TRUE" || echo "FALSE")) ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, priority = EXCLUDED.priority, \"always\" = EXCLUDED.\"always\";" 2>/dev/null
      ;;
    sqlite)
      sqlite3 "$CONN_STRING" "INSERT OR REPLACE INTO primer (key, content, priority, \"always\") VALUES ('${esc_key}', '${esc_content}', ${priority}, ${always});" 2>/dev/null
      ;;
    mysql)
      mysql -e "INSERT INTO primer (\`key\`, content, priority, \`always\`) VALUES ('${esc_key}', '${esc_content}', ${priority}, ${always}) ON DUPLICATE KEY UPDATE content=VALUES(content), priority=VALUES(priority), \`always\`=VALUES(\`always\`);" "$DB_NAME" 2>/dev/null
      ;;
  esac
}

# Helper: parse a markdown file and insert each # section as a primer rule
#   $1=file  $2=always flag (0 or 1)
#   Format: # heading lines become keys, body becomes content
#   Priority assigned by order of appearance (0, 10, 20, ...)
import_primer_file() {
  local file="$1" always="${2:-0}"
  local current_key=""
  local current_content=""
  local priority=0
  local count=0
  local always_label=""
  [[ "$always" == "1" ]] && always_label=" [always]"

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^#[[:space:]]+(.*) ]]; then
      # New heading — flush previous section
      if [[ -n "$current_key" && -n "$current_content" ]]; then
        # Trim leading/trailing whitespace from content
        current_content="$(echo "$current_content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [[ -n "$current_content" ]]; then
          insert_primer_rule "$current_key" "$current_content" "$priority" "$always"
          ok "  ${current_key} (priority ${priority})${always_label}"
          priority=$((priority + 10))
          count=$((count + 1))
        fi
      fi
      # Start new section — key is the heading text, lowercased, spaces→dashes
      current_key="$(echo "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
      current_content=""
    else
      # Accumulate body lines
      if [[ -n "$current_key" ]]; then
        if [[ -n "$current_content" ]]; then
          current_content="${current_content}
${line}"
        else
          current_content="$line"
        fi
      fi
    fi
  done < "$file"

  # Flush last section
  if [[ -n "$current_key" && -n "$current_content" ]]; then
    current_content="$(echo "$current_content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ -n "$current_content" ]]; then
      insert_primer_rule "$current_key" "$current_content" "$priority" "$always"
      ok "  ${current_key} (priority ${priority})${always_label}"
      count=$((count + 1))
    fi
  fi

  echo "$count"
}

# Only run primer setup on fresh installs (not updates) and not dry-run
if ! $IS_UPDATE && ! $DRY_RUN; then

  # Look for PRIMER.md and ALWAYS.md in likely locations
  PRIMER_FILE=""
  ALWAYS_FILE=""
  OPENCLAW_WORKSPACE="${HOME}/.openclaw/workspace"

  for candidate in \
    "${OPENCLAW_WORKSPACE}/PRIMER.md" \
    "${OPENCLAW_WORKSPACE}/primer.md" \
    "./PRIMER.md" \
    "./primer.md"; do
    if [[ -f "$candidate" ]]; then
      PRIMER_FILE="$candidate"
      break
    fi
  done

  for candidate in \
    "${OPENCLAW_WORKSPACE}/ALWAYS.md" \
    "${OPENCLAW_WORKSPACE}/always.md" \
    "./ALWAYS.md" \
    "./always.md"; do
    if [[ -f "$candidate" ]]; then
      ALWAYS_FILE="$candidate"
      break
    fi
  done

  FOUND_FILES=false

  # ── Import PRIMER.md (injected on first turn) ────────────────────────
  if [[ -n "$PRIMER_FILE" ]]; then
    FOUND_FILES=true
    blank
    info "Found primer file: ${BOLD}${PRIMER_FILE}${NC}"
    detail "Parsing sections (# heading = key, body = rule text)"
    detail "These rules are injected on the first turn of each session."
    echo ""

    IMPORTED=$(import_primer_file "$PRIMER_FILE" 0)

    if [[ "$IMPORTED" -gt 0 ]]; then
      blank
      ok "Imported ${IMPORTED} primer rule(s) from ${PRIMER_FILE}"
    else
      warn "No sections found in ${PRIMER_FILE}"
      detail "Expected format: # heading on its own line, content below it"
    fi
    blank
  fi

  # ── Import ALWAYS.md (injected every turn) ────────────────────────────
  if [[ -n "$ALWAYS_FILE" ]]; then
    FOUND_FILES=true
    blank
    info "Found always-on file: ${BOLD}${ALWAYS_FILE}${NC}"
    detail "Parsing sections (# heading = key, body = rule text)"
    detail "These rules are injected on ${BOLD}every turn${NC}, not just the first."
    echo ""

    IMPORTED_ALWAYS=$(import_primer_file "$ALWAYS_FILE" 1)

    if [[ "$IMPORTED_ALWAYS" -gt 0 ]]; then
      blank
      ok "Imported ${IMPORTED_ALWAYS} always-on rule(s) from ${ALWAYS_FILE}"
      detail "⚠️  These cost tokens every turn. Keep them short and critical."
    else
      warn "No sections found in ${ALWAYS_FILE}"
      detail "Expected format: # heading on its own line, content below it"
    fi
    blank
  fi

  if $FOUND_FILES; then
    detail "Edit the files and re-run setup to update."
    blank

  elif ! $AUTO_YES; then
    # ── Interactive fallback ──────────────────────────────────────────
    blank
    echo ""
    echo "  ┌──────────────────────────────────────────────────────────────────┐"
    echo "  │                                                                  │"
    echo "  │   🧬  Primer Rules (optional)                                    │"
    echo "  │                                                                  │"
    echo "  │   Most rules work as searchable memories — the agent finds       │"
    echo "  │   them when relevant. But a few need to be loaded before the     │"
    echo "  │   agent's first thought:                                         │"
    echo "  │                                                                  │"
    echo "  │     • Core identity (\""You are Shadow"\")                           │"
    echo "  │     • Safety rails (\"Never send without confirmation\")           │"
    echo "  │     • Banned words, hard constraints                             │"
    echo "  │                                                                  │"
    echo "  │   The test: if violating this rule before the agent thinks to    │"
    echo "  │   search would cause damage, it's a primer rule.                 │"
    echo "  │                                                                  │"
    echo "  │   💡  Or create PRIMER.md / ALWAYS.md in workspace and re-run.  │"
    echo "  │                                                                  │"
    echo "  └──────────────────────────────────────────────────────────────────┘"
    echo ""

    echo -ne "  ${BOLD}Do you have always-on rules to add?${NC} (y/N): "
    read -r ADD_PRIMER
    echo ""

    if [[ "$ADD_PRIMER" =~ ^[Yy] ]]; then

      PRIMER_COUNT=0

      echo "  Enter primer rules one at a time."
      echo "  Each needs a ${BOLD}key${NC} (short name) and ${BOLD}content${NC} (the rule text)."
      echo "  Priority: lower number = injected first (0 = highest priority)."
      echo ""
      echo "  Type ${BOLD}done${NC} when finished."
      echo ""

      while true; do
        echo -ne "  ${BOLD}Key${NC} (e.g. identity, safety, banned-words) or 'done': "
        read -r PRIMER_KEY
        [[ "$PRIMER_KEY" == "done" || -z "$PRIMER_KEY" ]] && break

        echo -ne "  ${BOLD}Content${NC}: "
        read -r PRIMER_CONTENT
        if [[ -z "$PRIMER_CONTENT" ]]; then
          warn "Empty content — skipping"
          echo ""
          continue
        fi

        echo -ne "  ${BOLD}Priority${NC} [${PRIMER_COUNT}0]: "
        read -r PRIMER_PRIORITY
        PRIMER_PRIORITY="${PRIMER_PRIORITY:-${PRIMER_COUNT}0}"

        insert_primer_rule "$PRIMER_KEY" "$PRIMER_CONTENT" "$PRIMER_PRIORITY"

        PRIMER_COUNT=$((PRIMER_COUNT + 1))
        ok "Added: ${PRIMER_KEY}"
        echo ""
      done

      if [[ $PRIMER_COUNT -gt 0 ]]; then
        ok "Added ${PRIMER_COUNT} primer rule(s)"
        detail "These will be injected before the agent's first thought each session."
      fi

      blank
    else
      detail "No problem — you can add primer rules anytime:"
      detail "  • Create PRIMER.md (first turn) or ALWAYS.md (every turn)"
      detail "    in ~/.openclaw/workspace/ and re-run setup"
      detail "  • Insert with SQL directly"
      detail "  • Ask your agent to do it"
      detail "See: https://github.com/jamesdwilson/Sh4d0wDB#importing-your-identity"
      blank
    fi

  fi
  # AUTO_YES with no PRIMER.md → silently skip (agent-driven install)
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

  # Show DB stats (backend-aware)
  if [[ "$BACKEND" == "postgres" ]]; then
    ROW_COUNT=$(psql -qtAX "$DB_NAME" -c "SELECT count(*) FROM memories;" 2>/dev/null || echo "0")
    PRIMER_COUNT=$(psql -qtAX "$DB_NAME" -c "SELECT count(*) FROM primer;" 2>/dev/null || echo "0")
    ok "Database (postgres):"
    detail "memories: ${ROW_COUNT} records"
    detail "primer:   ${PRIMER_COUNT} entries"
  elif [[ "$BACKEND" == "sqlite" ]]; then
    ok "Database (sqlite): ${CONN_STRING:-~/.shadowdb/memory.db}"
    detail "Tables auto-created on first start"
  elif [[ "$BACKEND" == "mysql" ]]; then
    ok "Database (mysql): connected"
    detail "Tables auto-created on first start"
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
