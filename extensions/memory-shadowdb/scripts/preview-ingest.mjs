#!/usr/bin/env node
/**
 * preview-ingest.mjs — Preview ingestion decisions on live Gmail messages
 * Shows: subject, from, entity filter result, LLM score, decision
 * Usage: node scripts/preview-ingest.mjs [limit]
 */

import { execSync } from "node:child_process";
import { parseGogSearchResults, parseGogMessage, shouldIngestMessage, buildSearchQuery } from "../dist/phase1-runner.js";
import { passesEntityFilter } from "../dist/phase1-gmail.js";
import { scoreInterestingness } from "../dist/phase1-scoring.js";

const ACCOUNT   = "james@jameswilson.name";
const LIMIT     = parseInt(process.argv[2] ?? "20", 10);
const THRESHOLD = 5;
const LLM_BASE  = "http://localhost:8000/v1";
const LLM_KEY   = "apikey";
const LLM_MODEL = "qwen3.5-35b-a3b-4bit";

const llm = {
  async complete(prompt) {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${LLM_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 1024, temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
      signal: AbortSignal.timeout(15_000),
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content ?? "";
  }
};

// Past 30 days, exclude promo/social
const query = buildSearchQuery({
  watermark: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  account: ACCOUNT,
});
console.log(`Query: ${query}`);
console.log(`Fetching ${LIMIT} messages from last 30 days...\n`);

const gogOutput = execSync(
  `gog gmail search ${JSON.stringify(query)} --json --account ${ACCOUNT} --max ${LIMIT}`,
  { timeout: 30_000, encoding: "utf8" }
);
const ids = parseGogSearchResults(gogOutput);
console.log(`Found ${ids.length} threads\n`);
console.log("─".repeat(100));

let kept = 0, dropped_veto = 0, dropped_score = 0, errors = 0;

for (const id of ids) {
  try {
    const raw = execSync(
      `gog gmail get ${id} --json --account ${ACCOUNT}`,
      { timeout: 10_000, encoding: "utf8" }
    );
    const content = parseGogMessage(raw);

    if (!content) {
      console.log(`[SKIP-EMPTY]                                                        | ${id}`);
      dropped_veto++;
      continue;
    }

    const entityPasses = passesEntityFilter(content.text);

    if (!entityPasses) {
      console.log(`[VETO      ] ${content.subject?.slice(0, 52).padEnd(52)} | ${content.from?.slice(0, 35)}`);
      dropped_veto++;
      continue;
    }

    // LLM score
    const score = await scoreInterestingness(
      content.text,
      { subject: content.subject, parties: content.parties },
      llm
    );
    const decision = shouldIngestMessage(content, THRESHOLD, score);
    const tag = decision.ingest
      ? `[KEEP  ${score.toFixed(1).padStart(3)}]`
      : `[DROP  ${score.toFixed(1).padStart(3)}]`;

    console.log(`${tag} ${content.subject?.slice(0, 50).padEnd(50)} | ${content.from?.slice(0, 35)}`);

    if (decision.ingest) kept++;
    else dropped_score++;

  } catch (e) {
    console.log(`[ERROR     ] ${id}: ${e.message?.slice(0, 60)}`);
    errors++;
  }
}

console.log("─".repeat(100));
console.log(`\nResult: ${ids.length} fetched | ${kept} KEEP | ${dropped_veto} hard-vetoed | ${dropped_score} score-dropped (threshold=${THRESHOLD}) | ${errors} errors`);
