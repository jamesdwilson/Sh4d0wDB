#!/usr/bin/env node
/**
 * reembed-omlx.mjs — Re-embed all ShadowDB records using oMLX Qwen3-Embedding-4B
 */

import pg from "pg";

const BASE_URL = "http://localhost:8000/v1";
const API_KEY = "apikey";
const MODEL = "qwen3-embedding-4b-4bit";
const DIMS = 2560;
const BATCH_SIZE = 20;
const DRY_RUN = process.argv.includes("--dry-run");

const db = new pg.Client({
  host: "localhost",
  port: 5432,
  database: "shadow",
  user: process.env.USER,
});

// Qwen3-Embedding: documents use plain text, queries use instruct prefix
async function embed(texts) {
  // Document prefix: plain text (no prefix for Qwen3-Embedding documents)
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

async function main() {
  await db.connect();

  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL`
  );
  console.log(`Records to embed: ${count}`);
  if (DRY_RUN) { console.log("DRY RUN — no writes"); await db.end(); return; }

  // Update vector column dimensions if needed
  // Check current dim
  const { rows: sample } = await db.query(
    `SELECT id, title, content FROM memories WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
  );
  if (!sample.length) { console.log("No records"); await db.end(); return; }

  let processed = 0, errors = 0;
  let lastId = 0;

  while (true) {
    const { rows } = await db.query(
      `SELECT id, title, content, tags FROM memories 
       WHERE deleted_at IS NULL AND id > $1 
       ORDER BY id LIMIT $2`,
      [lastId, BATCH_SIZE]
    );
    if (!rows.length) break;

    const texts = rows.map(r => {
      const tag = (r.tags || []).join(" ");
      return `${r.title || ""}\n${tag}\n${(r.content || "").slice(0, 2000)}`.trim();
    });

    try {
      const vectors = await embed(texts);
      for (let i = 0; i < rows.length; i++) {
        const vec = `[${vectors[i].join(",")}]`;
        await db.query(
          `UPDATE memories SET embedding = $1::vector WHERE id = $2`,
          [vec, rows[i].id]
        );
      }
      processed += rows.length;
      lastId = rows[rows.length - 1].id;
      process.stdout.write(`\rEmbedded ${processed}/${count} (id up to ${lastId})`);
    } catch (e) {
      console.error(`\nBatch error at id ${lastId}: ${e.message}`);
      errors++;
      lastId = rows[rows.length - 1].id;
    }
  }

  console.log(`\nDone. Processed: ${processed}, Errors: ${errors}`);
  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
