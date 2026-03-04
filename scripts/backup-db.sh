#!/bin/bash
# ShadowDB Database Backup Tool
# Supports PostgreSQL, SQLite, and MySQL backends

set -euo pipefail

# Default values
BACKUP_DIR="db-backups"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKEND=""
DB_PATH=""
DB_NAME=""

# Parse config from openclaw.json or environment
detect_backend() {
  local config_file="$HOME/.openclaw/openclaw.json"
  
  # Check for explicit backend config
  if command -v jq &> /dev/null && [ -f "$config_file" ]; then
    BACKEND=$(jq -r '.plugins.entries["memory-shadowdb"].config.backend // empty' "$config_file" 2>/dev/null || true)
    DB_PATH=$(jq -r '.plugins.entries["memory-shadowdb"].config.connectionString // empty' "$config_file" 2>/dev/null || true)
  fi
  
  # Default to postgres if not specified
  BACKEND=${BACKEND:-postgres}
  
  # Try to detect database name from connection string or environment
  if [ -n "$DB_PATH" ]; then
    # Extract database name from connection string
    DB_NAME=$(echo "$DB_PATH" | sed -n 's/.*\/\([^?]*\).*/\1/p')
  elif [ "$BACKEND" = "postgres" ]; then
    DB_NAME="shadow"
  elif [ "$BACKEND" = "sqlite" ]; then
    DB_PATH="${DB_PATH:-$HOME/.shadowdb/memory.db}"
    DB_NAME=$(basename "$DB_PATH" .db)
  elif [ "$BACKEND" = "mysql" ]; then
    DB_NAME="shadow"
  fi
}

backup_postgres() {
  local backup_file="$BACKUP_DIR/shadowdb_${DB_NAME}_${TIMESTAMP}.sql"
  
  echo "Backing up PostgreSQL database: $DB_NAME"
  
  # Try to find matching pg_dump version
  local pg_dump_cmd=""
  if command -v pg_dump &> /dev/null; then
    # Check version compatibility
    local server_version=$(psql -t -c "SELECT version();" "$DB_NAME" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
    local client_version=$(pg_dump --version | grep -oE '[0-9]+\.[0-9]+' | head -1)
    
    if [ "$server_version" = "$client_version" ] 2>/dev/null; then
      pg_dump_cmd="pg_dump"
    fi
  fi
  
  # Try versioned pg_dump if available (common on Homebrew)
  if [ -z "$pg_dump_cmd" ]; then
    for ver in 17 16 15; do
      if command -v "pg_dump@$ver" &> /dev/null; then
        pg_dump_cmd="pg_dump@$ver"
        break
      fi
    done
  fi
  
  # Use SQL export via psql if pg_dump versions don't match
  if [ -z "$pg_dump_cmd" ]; then
    echo "pg_dump version mismatch, using SQL export via psql..."
    psql -t -A -F"," -c "COPY (SELECT * FROM memories ORDER BY id) TO STDOUT WITH CSV HEADER" "$DB_NAME" > "$backup_file.csv" 2>/dev/null || {
      echo "Error: Failed to export PostgreSQL database"
      exit 1
    }
    echo "✓ Created CSV backup: $backup_file.csv"
    return
  fi
  
  # Use pg_dump with custom format for better restore options
  $pg_dump_cmd --no-owner --no-acl -Fc "$DB_NAME" > "$backup_file.pgdump" 2>/dev/null || {
    # Fallback to plain SQL if custom format fails
    echo "Custom format failed, using plain SQL..."
    $pg_dump_cmd --no-owner --no-acl "$DB_NAME" > "$backup_file" 2>/dev/null || {
      echo "Error: Failed to backup PostgreSQL database"
      exit 1
    }
    echo "✓ Created backup: $backup_file"
  }
}

backup_sqlite() {
  local db_file="${DB_PATH:-$HOME/.shadowdb/memory.db}"
  local backup_file="$BACKUP_DIR/shadowdb_${DB_NAME}_${TIMESTAMP}.db"
  
  if [ ! -f "$db_file" ]; then
    echo "Error: SQLite database not found at $db_file"
    exit 1
  fi
  
  echo "Backing up SQLite database: $db_file"
  
  # Use sqlite3 backup API for consistent backup
  if command -v sqlite3 &> /dev/null; then
    sqlite3 "$db_file" ".backup '$backup_file'" 2>/dev/null || {
      # Fallback to file copy
      echo "SQLite backup API failed, using file copy..."
      cp "$db_file" "$backup_file" || {
        echo "Error: Failed to backup SQLite database"
        exit 1
      }
    }
    echo "✓ Created backup: $backup_file"
  else
    echo "Error: sqlite3 not found."
    exit 1
  fi
}

backup_mysql() {
  local backup_file="$BACKUP_DIR/shadowdb_${DB_NAME}_${TIMESTAMP}.sql"
  
  echo "Backing up MySQL database: $DB_NAME"
  
  # Use mysqldump
  if command -v mysqldump &> /dev/null; then
    mysqldump --single-transaction --routines --triggers "$DB_NAME" > "$backup_file" 2>/dev/null || {
      echo "Error: Failed to backup MySQL database"
      exit 1
    }
    echo "✓ Created backup: $backup_file"
  else
    echo "Error: mysqldump not found. Please install mysql-client."
    exit 1
  fi
}

cleanup_old_backups() {
  local max_days=${MAX_BACKUP_DAYS:-30}
  
  echo "Cleaning up backups older than $max_days days..."
  
  find "$BACKUP_DIR" -name "shadowdb_*" -type f -mtime +$max_days -delete 2>/dev/null || true
  echo "✓ Cleanup complete"
}

show_usage() {
  cat << EOF
ShadowDB Database Backup Tool

Usage: $0 [options]

Options:
  --backend <type>      Database backend: postgres, sqlite, mysql (default: auto-detect)
  --output <dir>        Backup directory (default: db-backups)
  --max-days <days>     Delete backups older than N days (default: 30)
  --help               Show this help message

Examples:
  $0                           # Auto-detect backend and backup
  $0 --backend postgres       # Force PostgreSQL backup
  $0 --backend sqlite         # Force SQLite backup
  $0 --max-days 7             # Keep only last 7 days of backups

EOF
  exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --backend)
      BACKEND="$2"
      shift 2
      ;;
    --output)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --max-days)
      MAX_BACKUP_DAYS="$2"
      shift 2
      ;;
    --help|-h)
      show_usage
      ;;
    *)
      echo "Unknown option: $1"
      show_usage
      ;;
  esac
done

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Auto-detect backend if not specified
if [ -z "$BACKEND" ]; then
  detect_backend
fi

echo "Using backend: $BACKEND"
echo "Backup directory: $BACKUP_DIR"
echo "Timestamp: $TIMESTAMP"
echo ""

# Perform backup based on backend
case "$BACKEND" in
  postgres|postgresql)
    backup_postgres
    ;;
  sqlite)
    backup_sqlite
    ;;
  mysql|mariadb)
    backup_mysql
    ;;
  *)
    echo "Error: Unknown backend '$BACKEND'. Supported: postgres, sqlite, mysql"
    exit 1
    ;;
esac

# Cleanup old backups
cleanup_old_backups

echo ""
echo "Backup complete!"
