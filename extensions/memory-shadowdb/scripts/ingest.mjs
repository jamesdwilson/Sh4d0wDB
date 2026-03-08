#!/usr/bin/env node
/**
 * ingest.mjs — Gmail + iMessage ingestion entry point
 *
 * Standalone CLI script that wires up all dependencies and runs the
 * ingestion pipeline. Designed to be called from an OpenClaw cron job
 * or run manually for backfills.
 *
 * Usage:
 *   node scripts/ingest.mjs [--source gmail|imsg|all] [--dry-run] [--limit N]
 *
 * Environment / config:
 *   - DB: hardcoded to postgresql:///shadow (same as plugin)
 *   - Embedding: oMLX on http://localhost:8000/v1 (for store.write autoEmbed)
 *   - LLM scoring: oMLX on http://localhost:8000/v1 (local-qwen35)
 *   - gog account: james@jameswilson.name
 *
 * Output:
 *   - Logs to stdout (structured lines, grep-friendly)
 *   - Also appends to ~/models/eval-results/gmail-ingestion.log
 *
 * Exit codes:
 *   0 = success (complete or partial)
 *   1 = failed (gog/imsg CLI unreachable, DB down)
 */

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runIngestion, GmailFetcher, RunStatus } from "../dist/phase1-runner.js";
import { IMessageFetcher } from "../dist/phase1-fetcher-imsg.js";
import { PostgresStore } from "../dist/postgres.js";
import { EmbeddingClient } from "../dist/embedder.js";

// ============================================================================
// Config
// ============================================================================

const CONNECTION_STRING = "postgresql:///shadow";
const GMAIL_ACCOUNT     = "james@jameswilson.name";
const LOG_PATH          = path.join(os.homedir(), "models/eval-results/gmail-ingestion.log");
const SCORE_THRESHOLD   = 5;
const MAX_PER_RUN       = 100;  // per source; 0 = unlimited

// oMLX LLM client (OpenAI-compatible)
const LLM_BASE_URL = "http://localhost:8000/v1";
const LLM_API_KEY  = "apikey";
const LLM_MODEL    = "qwen3.5-35b-a3b-4bit";

// ============================================================================
// Parse args
// ============================================================================

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const VERBOSE  = args.includes("--verbose") || args.includes("-v");
const sources  = (() => {
  const idx = args.indexOf("--source");
  if (idx >= 0 && args[idx + 1]) {
    const val = args[idx + 1];
    if (val === "all") return ["gmail", "imsg"];
    return [val];
  }
  return ["gmail", "imsg"]; // default: run both
})();
const limitArg = (() => {
  const idx = args.indexOf("--limit");
  if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return MAX_PER_RUN;
})();

// ============================================================================
// Logging
// ============================================================================

const logStream = (() => {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    return fs.createWriteStream(LOG_PATH, { flags: "a" });
  } catch {
    return null;
  }
})();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  logStream?.write(line + "\n");
}

// ============================================================================
// LLM client (OpenAI-compatible, calls oMLX)
// ============================================================================

const llm = {
  async complete(prompt) {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  },
};

// ============================================================================
// DB client wrapper (satisfies DbClient interface)
// ============================================================================

function makeDbClient(pool) {
  return {
    async query(sql, params) {
      return pool.query(sql, params);
    },
  };
}

// ============================================================================
// Store write wrapper (satisfies store interface for runner)
// ============================================================================

function makeStoreClient(store) {
  return {
    async write(params) {
      if (DRY_RUN) {
        log(`[dry-run] would write: ${params.title} (${params.metadata?.operationId})`);
        return { id: -1 };
      }
      return store.write(params);
    },
  };
}

// ============================================================================
// Record run stats in ingestion_runs table
// ============================================================================

async function recordRun(pool, run) {
  if (DRY_RUN) { log(`[dry-run] would record run:`, JSON.stringify(run)); return; }
  try {
    await pool.query(
      `INSERT INTO ingestion_runs
         (source, account, started_at, completed_at, messages_processed,
          messages_ingested, messages_skipped, status, watermark_used, new_watermark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        run.source, run.account, run.started_at, run.completed_at,
        run.messages_processed, run.messages_ingested, run.messages_skipped,
        run.status, run.watermark_used, run.new_watermark,
      ],
    );
  } catch (err) {
    log(`[warn] failed to record run:`, err.message);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  log(`=== Ingestion run starting — sources: ${sources.join(", ")} | dry-run: ${DRY_RUN} | limit: ${limitArg} ===`);

  // Connect to DB
  const pool = new pg.Pool({ connectionString: CONNECTION_STRING, max: 3 });

  // Build embedder (for store.write autoEmbed)
  const embedder = new EmbeddingClient({
    provider: "openai",
    model: "qwen3-embedding-4b-4bit",
    dimensions: 2560,
    baseUrl: "http://localhost:8000/v1",
    apiKey: "apikey",
  });

  // Build store
  const store = new PostgresStore({
    connectionString: CONNECTION_STRING,
    embedder,
    config: { autoEmbed: !DRY_RUN, writes: { enabled: true } },
    logger: { info: log, error: log, warn: log, debug: () => {} },
  });

  const db = makeDbClient(pool);
  const storeClient = makeStoreClient(store);

  const ingestionConfig = {
    account:          GMAIL_ACCOUNT,
    scoringModel:     LLM_MODEL,
    scoreThreshold:   SCORE_THRESHOLD,
    maxMessagesPerRun: limitArg,
    searchQuery:      "",
    logPath:          LOG_PATH,
  };

  let exitCode = 0;

  for (const source of sources) {
    log(`--- Starting source: ${source} ---`);

    try {
      let fetcher;
      if (source === "gmail") {
        fetcher = new GmailFetcher(ingestionConfig);
      } else if (source === "imsg") {
        fetcher = new IMessageFetcher({ maxPerChat: 200, maxChats: 0 });
      } else {
        log(`[warn] unknown source: ${source}, skipping`);
        continue;
      }

      const run = await runIngestion(ingestionConfig, db, storeClient, llm, fetcher);
      await recordRun(pool, run);

      log(
        `[${source}] done — processed: ${run.messages_processed}, ` +
        `ingested: ${run.messages_ingested}, skipped: ${run.messages_skipped}, ` +
        `status: ${run.status}`
      );

      if (run.status === RunStatus.FAILED) exitCode = 1;

    } catch (err) {
      log(`[${source}] FATAL:`, err.message);
      exitCode = 1;
    }
  }

  await pool.end();
  log(`=== Ingestion run complete ===`);
  process.exit(exitCode);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
