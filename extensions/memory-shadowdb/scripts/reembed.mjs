#!/usr/bin/env node
/**
 * reembed.mjs — Re-embed all memory records with nomic task prefixes
 *
 * This script re-generates embeddings for all non-deleted records in the
 * memories table using the `search_document: ` prefix required by
 * nomic-embed-text for optimal retrieval performance.
 *
 * Background: Existing embeddings were generated without task prefixes.
 * nomic-embed-text uses `search_query: ` and `search_document: ` prefixes
 * to place queries and documents in different vector subspaces. Without
 * prefixes on both sides, cosine similarity is degraded.
 *
 * Usage:
 *   node scripts/reembed.mjs [--dry-run] [--batch-size=50] [--ollama-url=http://localhost:11434]
 *
 * Options:
 *   --dry-run        Show what would be done without writing to DB
 *   --batch-size=N   Records per batch (default: 50)
 *   --ollama-url=URL Ollama server URL (default: http://localhost:11434)
 *   --model=MODEL    Embedding model (default: nomic-embed-text)
 *   --start-id=N     Resume from this record ID (skip lower IDs)
 *   --dims=N         Expected embedding dimensions (default: 768)
 */

import pg from "pg";

// ============================================================================
// CLI args
// ============================================================================
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }
    return [a, "true"];
  }),
);

const DRY_RUN = args["dry-run"] === "true";
const BATCH_SIZE = parseInt(args["batch-size"] || "50", 10);
const OLLAMA_URL = (args["ollama-url"] || "http://localhost:11434").replace(/\/$/, "");
const MODEL = args["model"] || "nomic-embed-text";
const START_ID = parseInt(args["start-id"] || "0", 10);
const EXPECTED_DIMS = parseInt(args["dims"] || "768", 10);
const PREFIX = "search_document: ";
const MAX_TEXT_CHARS = 8000;

// ============================================================================
// Embedding
// ============================================================================
async function embedText(text) {
  const truncated = text.slice(0, MAX_TEXT_CHARS);
  const prompt = `${PREFIX}${truncated}`;

  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!Array.isArray(data.embedding)) {
    throw new Error("Ollama response missing embedding array");
  }

  if (data.embedding.length !== EXPECTED_DIMS) {
    throw new Error(
      `Dimension mismatch: got ${data.embedding.length}, expected ${EXPECTED_DIMS}`,
    );
  }

  return data.embedding;
}

// ============================================================================
// Format vector for pgvector
// ============================================================================
function toPgVector(vec) {
  return `[${vec.join(",")}]`;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log(`Re-embed script for nomic-embed-text task prefixes`);
  console.log(`  Ollama:     ${OLLAMA_URL}`);
  console.log(`  Model:      ${MODEL}`);
  console.log(`  Prefix:     "${PREFIX}"`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`  Start ID:   ${START_ID || "(beginning)"}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log();

  // Test Ollama connectivity
  try {
    const test = await embedText("test");
    console.log(`✓ Ollama reachable, embedding dims: ${test.length}`);
  } catch (err) {
    console.error(`✗ Ollama connectivity test failed: ${err.message}`);
    process.exit(1);
  }

  const pool = new pg.Pool({ database: "shadow" });

  try {
    // Get total count
    const countRes = await pool.query(
      "SELECT COUNT(*) as cnt FROM memories WHERE deleted_at IS NULL AND id > $1",
      [START_ID],
    );
    const total = parseInt(countRes.rows[0].cnt, 10);
    console.log(`\nRecords to re-embed: ${total}\n`);

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    let processed = 0;
    let errors = 0;
    let lastId = START_ID;
    const startTime = Date.now();

    while (true) {
      // Fetch next batch (cursor-based pagination by id)
      const batch = await pool.query(
        `SELECT id, content FROM memories 
         WHERE deleted_at IS NULL AND id > $1 
         ORDER BY id ASC LIMIT $2`,
        [lastId, BATCH_SIZE],
      );

      if (batch.rows.length === 0) break;

      for (const row of batch.rows) {
        try {
          const embedding = await embedText(row.content);

          if (!DRY_RUN) {
            await pool.query(
              `UPDATE memories SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
              [toPgVector(embedding), row.id],
            );
          }

          processed++;
          lastId = row.id;

          if (processed % 100 === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);
            const eta = ((total - processed) / (processed / (Date.now() - startTime) * 1000)).toFixed(0);
            console.log(
              `Progress: ${processed} / ${total} (${((processed / total) * 100).toFixed(1)}%) | ` +
              `${elapsed}s elapsed | ${rate}/s | ETA: ${eta}s | last_id: ${lastId}`,
            );
          }
        } catch (err) {
          errors++;
          console.error(`  ✗ Record ${row.id}: ${err.message}`);
          lastId = row.id; // Skip and continue
          if (errors > 50) {
            console.error("\nToo many errors (>50), aborting.");
            process.exit(1);
          }
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✓ Done: ${processed} re-embedded, ${errors} errors, ${elapsed}s total`);

    if (DRY_RUN) {
      console.log("(dry run — no records were updated)");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
