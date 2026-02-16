#!/usr/bin/env bash
# Re-embed all records with search_document: prefix for nomic-embed-text.
# Usage: ./scripts/reembed.sh [--dry-run] [--verify]
#
# Requires: psql, curl, jq
set -euo pipefail

PSQL="${PSQL:-/opt/homebrew/opt/postgresql@17/bin/psql}"
DB="${DB:-shadow}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
MODEL="${MODEL:-nomic-embed-text}"
DRY_RUN=false
VERIFY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verify) VERIFY=true ;;
  esac
done

TOTAL=$($PSQL -d "$DB" -tAc "SELECT count(*) FROM memories WHERE deleted_at IS NULL")
echo "Records to re-embed: $TOTAL"
if $DRY_RUN; then echo "(dry run)"; exit 0; fi

DONE=0
FAILED=0

# Stream IDs, fetch content one at a time (safe for any content)
$PSQL -d "$DB" -tA -c "SELECT id FROM memories WHERE deleted_at IS NULL ORDER BY id" | while read -r ID; do
  [ -z "$ID" ] && continue

  # Fetch content as JSON to handle all escaping
  CONTENT=$($PSQL -d "$DB" -tA -c "SELECT left(content, 8000) FROM memories WHERE id = $ID")

  # Build JSON payload with jq (handles all escaping)
  PREFIXED="search_document: $CONTENT"
  PAYLOAD=$(jq -n --arg model "$MODEL" --arg prompt "$PREFIXED" '{model:$model,prompt:$prompt}')

  EMBEDDING=$(curl -sf "$OLLAMA_URL/api/embeddings" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" | jq -c '.embedding')

  if [ -z "$EMBEDDING" ] || [ "$EMBEDDING" = "null" ]; then
    echo "FAIL: id=$ID"
    FAILED=$((FAILED + 1))
    continue
  fi

  $PSQL -d "$DB" -c "UPDATE memories SET embedding = '$EMBEDDING'::vector WHERE id = $ID" >/dev/null
  DONE=$((DONE + 1))
  [ $((DONE % 100)) -eq 0 ] && echo "Progress: $DONE / $TOTAL"
done

echo "Done. Re-embedded: $DONE, Failed: $FAILED"

if $VERIFY; then
  echo ""
  echo "=== VERIFICATION ==="
  QUERY_EMB=$(curl -sf "$OLLAMA_URL/api/embeddings" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg model "$MODEL" --arg prompt "search_query: Annie Lin" '{model:$model,prompt:$prompt}')" \
    | jq -c '.embedding')

  echo "Top 5 by vector similarity for 'Annie Lin':"
  $PSQL -d "$DB" -c "
    SELECT id, category, left(title, 40) as title,
           round((1 - (embedding <=> '$QUERY_EMB'::vector))::numeric, 4) as sim
    FROM memories
    WHERE deleted_at IS NULL AND embedding IS NOT NULL
    ORDER BY embedding <=> '$QUERY_EMB'::vector
    LIMIT 5"

  TOP_ID=$($PSQL -d "$DB" -tAc "
    SELECT id FROM memories
    WHERE deleted_at IS NULL AND embedding IS NOT NULL
    ORDER BY embedding <=> '$QUERY_EMB'::vector LIMIT 1")

  if [ "$TOP_ID" = "9992" ]; then
    echo "✅ PASS: Record 9992 (Annie Lin) ranks #1"
  else
    echo "❌ FAIL: Record $TOP_ID ranks #1 (expected 9992)"
    exit 1
  fi
fi
