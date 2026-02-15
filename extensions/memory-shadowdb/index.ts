/**
 * memory-shadowdb — OpenClaw memory plugin backed by PostgreSQL + pgvector
 *
 * Drop-in replacement for memory-core. Registers `memory_search` and
 * `memory_get` tools that query a PostgreSQL database with hybrid
 * semantic (pgvector cosine) + full-text (tsvector BM25) search.
 *
 * Connection config resolution order:
 *   1. Plugin config `connectionString`
 *   2. ~/.shadowdb.json → postgres.connection_string or host/port/user/password/database
 *   3. Environment: SHADOWDB_URL or DATABASE_URL
 *
 * Embedding config:
 *   - Provider-flexible: Ollama, OpenAI, OpenAI-compatible, Voyage, Gemini, or command-based
 *   - API keys from plugin config and provider-specific env vars
 *   - Dimensions must match existing pgvector column
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";

// ============================================================================
// Types
// ============================================================================

type ShadowDbConfig = {
  backend?: string;
  postgres?: {
    connection_string?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  };
};

type EmbeddingProvider =
  | "ollama"
  | "openai"
  | "openai-compatible"
  | "voyage"
  | "gemini"
  | "command";

type PluginConfig = {
  connectionString?: string;
  configPath?: string;
  embedding?: {
    provider?: EmbeddingProvider | string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
    ollamaUrl?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    voyageInputType?: "query" | "document";
    geminiTaskType?: string;
    command?: string;
    commandArgs?: string[];
    commandTimeoutMs?: number;
  };
  table?: string;
  search?: {
    maxResults?: number;
    minScore?: number;
    vectorWeight?: number;
    textWeight?: number;
  };
  startup?: {
    enabled?: boolean;
    mode?: "always" | "first-run" | "digest";
    maxChars?: number;
    /** Model-aware maxChars overrides. Keys are model patterns (substring match).
     *  Checked in order; first match wins. Falls back to maxChars. */
    maxCharsByModel?: Record<string, number>;
    cacheTtlMs?: number;
  };
};

type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
  citation?: string;
};

// ============================================================================
// Config Resolution
// ============================================================================

function loadShadowDbConfig(configPath?: string): ShadowDbConfig | null {
  const tryPaths = [
    configPath,
    path.join(os.homedir(), ".shadowdb.json"),
  ].filter(Boolean) as string[];

  for (const p of tryPaths) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw) as ShadowDbConfig;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveConnectionString(pluginCfg: PluginConfig): string {
  // 1. Explicit plugin config
  if (pluginCfg.connectionString) {
    return pluginCfg.connectionString;
  }

  // 2. Environment
  if (process.env.SHADOWDB_URL) {
    return process.env.SHADOWDB_URL;
  }
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // 3. ~/.shadowdb.json
  const shadowCfg = loadShadowDbConfig(pluginCfg.configPath);
  if (shadowCfg?.postgres) {
    const pg = shadowCfg.postgres;
    if (pg.connection_string) {
      return pg.connection_string;
    }
    const host = pg.host || "localhost";
    const port = pg.port || 5432;
    const user = pg.user || process.env.USER || "postgres";
    const db = pg.database || "shadow";
    const password = pg.password ? `:${encodeURIComponent(pg.password)}` : "";
    return `postgresql://${user}${password}@${host}:${port}/${db}`;
  }

  // 4. Fallback: local socket
  return `postgresql:///${process.env.USER || "shadow"}`;
}

function normalizeEmbeddingProvider(value: string | undefined): EmbeddingProvider {
  const v = (value || "ollama").trim().toLowerCase();
  switch (v) {
    case "openai-compatible":
    case "openai_compatible":
    case "openai-compatible-api":
      return "openai-compatible";
    case "voyage":
      return "voyage";
    case "gemini":
    case "google":
      return "gemini";
    case "command":
    case "external":
    case "custom":
      return "command";
    case "openai":
      return "openai";
    case "ollama":
    default:
      return "ollama";
  }
}

function resolveEmbeddingConfig(pluginCfg: PluginConfig): {
  provider: EmbeddingProvider;
  apiKey: string;
  model: string;
  dimensions: number;
  ollamaUrl: string;
  baseUrl: string;
  headers: Record<string, string>;
  voyageInputType: "query" | "document";
  geminiTaskType: string;
  command?: string;
  commandArgs: string[];
  commandTimeoutMs: number;
} {
  const embeddingCfg = pluginCfg.embedding || {};
  const provider = normalizeEmbeddingProvider(embeddingCfg.provider);

  const apiKeyByProvider =
    provider === "openai" || provider === "openai-compatible"
      ? process.env.OPENAI_API_KEY || ""
      : provider === "voyage"
        ? process.env.VOYAGE_API_KEY || ""
        : provider === "gemini"
          ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
          : "";

  const apiKey = embeddingCfg.apiKey || apiKeyByProvider;

  const modelDefaultByProvider: Record<EmbeddingProvider, string> = {
    ollama: "nomic-embed-text",
    openai: "text-embedding-3-small",
    "openai-compatible": "text-embedding-3-small",
    voyage: "voyage-3-lite",
    gemini: "text-embedding-004",
    command: "external-command",
  };

  const model = embeddingCfg.model || modelDefaultByProvider[provider];
  const dimensions = embeddingCfg.dimensions || 768;
  const ollamaUrl = embeddingCfg.ollamaUrl || process.env.OLLAMA_URL || "http://localhost:11434";
  const baseUrlDefaultByProvider: Record<EmbeddingProvider, string> = {
    ollama: ollamaUrl,
    openai: "https://api.openai.com",
    "openai-compatible": process.env.EMBEDDING_BASE_URL || "https://api.openai.com",
    voyage: "https://api.voyageai.com",
    gemini: "https://generativelanguage.googleapis.com",
    command: "",
  };
  const baseUrl = embeddingCfg.baseUrl || baseUrlDefaultByProvider[provider];
  const headers = embeddingCfg.headers || {};
  const voyageInputType = embeddingCfg.voyageInputType || "query";
  const geminiTaskType = embeddingCfg.geminiTaskType || "RETRIEVAL_QUERY";
  const command = embeddingCfg.command;
  const commandArgs = embeddingCfg.commandArgs || [];
  const commandTimeoutMs = embeddingCfg.commandTimeoutMs || 15_000;

  return {
    provider,
    apiKey,
    model,
    dimensions,
    ollamaUrl,
    baseUrl,
    headers,
    voyageInputType,
    geminiTaskType,
    command,
    commandArgs,
    commandTimeoutMs,
  };
}

type StartupInjectionMode = "always" | "first-run" | "digest";

function resolveStartupInjectionConfig(pluginCfg: PluginConfig): {
  enabled: boolean;
  mode: StartupInjectionMode;
  maxChars: number;
  maxCharsByModel: Record<string, number>;
  cacheTtlMs: number;
} {
  const startup = pluginCfg.startup || {};
  const rawMode = String(startup.mode || "always").trim().toLowerCase();
  const mode: StartupInjectionMode =
    rawMode === "always" || rawMode === "first-run" || rawMode === "digest"
      ? (rawMode as StartupInjectionMode)
       : "always";

  const maxChars =
    typeof startup.maxChars === "number" && Number.isFinite(startup.maxChars) && startup.maxChars > 0
      ? Math.floor(startup.maxChars)
      : 4000;

  // Model-aware maxChars overrides
  const maxCharsByModel: Record<string, number> = {};
  if (startup.maxCharsByModel && typeof startup.maxCharsByModel === "object") {
    for (const [pattern, chars] of Object.entries(startup.maxCharsByModel)) {
      if (typeof chars === "number" && Number.isFinite(chars) && chars > 0) {
        maxCharsByModel[pattern.toLowerCase()] = Math.floor(chars);
      }
    }
  }

  const cacheTtlMs =
    typeof startup.cacheTtlMs === "number" && Number.isFinite(startup.cacheTtlMs) && startup.cacheTtlMs >= 0
      ? Math.floor(startup.cacheTtlMs)
      : 10 * 60 * 1000;

  return {
    enabled: startup.enabled !== false,
    mode,
    maxChars,
    maxCharsByModel,
    cacheTtlMs,
  };
}

/** Resolve maxChars for a specific model. First matching pattern wins. */
function resolveMaxCharsForModel(
  startupCfg: { maxChars: number; maxCharsByModel: Record<string, number> },
  model?: string,
): number {
  if (!model || Object.keys(startupCfg.maxCharsByModel).length === 0) {
    return startupCfg.maxChars;
  }
  const modelLower = model.toLowerCase();
  for (const [pattern, chars] of Object.entries(startupCfg.maxCharsByModel)) {
    if (modelLower.includes(pattern)) {
      return chars;
    }
  }
  return startupCfg.maxChars;
}

function validateEmbeddingDimensions(
  embedding: number[],
  expectedDimensions: number,
  providerModelLabel: string,
): number[] {
  if (expectedDimensions > 0 && embedding.length !== expectedDimensions) {
    throw new Error(
      `Embedding dimension mismatch for ${providerModelLabel}: expected ${expectedDimensions}, got ${embedding.length}. ` +
        "Check embedding.dimensions and your model/provider output size.",
    );
  }
  return embedding;
}

// ============================================================================
// Embedding Client
// ============================================================================

class EmbeddingClient {
  private provider: EmbeddingProvider;
  private model: string;
  private dimensions: number;
  private apiKey: string;
  private ollamaUrl: string;
  private baseUrl: string;
  private headers: Record<string, string>;
  private voyageInputType: "query" | "document";
  private geminiTaskType: string;
  private command?: string;
  private commandArgs: string[];
  private commandTimeoutMs: number;

  constructor(params: {
    provider: EmbeddingProvider;
    model: string;
    dimensions: number;
    apiKey?: string;
    ollamaUrl?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    voyageInputType?: "query" | "document";
    geminiTaskType?: string;
    command?: string;
    commandArgs?: string[];
    commandTimeoutMs?: number;
  }) {
    this.provider = params.provider;
    this.model = params.model;
    this.dimensions = params.dimensions;
    this.apiKey = params.apiKey || "";
    this.ollamaUrl = params.ollamaUrl || "http://localhost:11434";
    this.baseUrl = params.baseUrl || "";
    this.headers = params.headers || {};
    this.voyageInputType = params.voyageInputType || "query";
    this.geminiTaskType = params.geminiTaskType || "RETRIEVAL_QUERY";
    this.command = params.command;
    this.commandArgs = params.commandArgs || [];
    this.commandTimeoutMs = params.commandTimeoutMs || 15_000;
  }

  async embed(text: string): Promise<number[]> {
    let embedding: number[];

    switch (this.provider) {
      case "ollama":
        embedding = await this.embedOllama(text);
        break;
      case "openai":
      case "openai-compatible":
        embedding = await this.embedOpenAICompatible(text);
        break;
      case "voyage":
        embedding = await this.embedVoyage(text);
        break;
      case "gemini":
        embedding = await this.embedGemini(text);
        break;
      case "command":
        embedding = await this.embedCommand(text);
        break;
      default:
        throw new Error(`Unsupported embedding provider: ${this.provider}`);
    }

    return validateEmbeddingDimensions(
      embedding,
      this.dimensions,
      `${this.provider}:${this.model}`,
    );
  }

  private async embedOllama(text: string): Promise<number[]> {
    const truncated = text.slice(0, 8000);
    const response = await fetch(`${this.ollamaUrl.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({ model: this.model, prompt: truncated }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) {
      throw new Error("Ollama embedding response missing `embedding` array");
    }
    return data.embedding;
  }

  private async embedOpenAICompatible(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error(`API key missing for embedding provider ${this.provider}`);
    }
    const truncated = text.slice(0, 8000);
    const body: Record<string, unknown> = {
      model: this.model,
      input: truncated,
    };
    if (this.dimensions > 0) {
      body.dimensions = this.dimensions;
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `${this.provider} embedding failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ""}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`${this.provider} response missing data[0].embedding`);
    }
    return embedding;
  }

  private async embedVoyage(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("VOYAGE_API_KEY (or embedding.apiKey) is required for provider=voyage");
    }
    const truncated = text.slice(0, 8000);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify({
        model: this.model,
        input: [truncated],
        input_type: this.voyageInputType,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Voyage embedding failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ""}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      embeddings?: number[][];
    };
    const embedding = data?.data?.[0]?.embedding || data?.embeddings?.[0];
    if (!Array.isArray(embedding)) {
      throw new Error("Voyage response missing embedding vector");
    }
    return embedding;
  }

  private async embedGemini(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY/GOOGLE_API_KEY (or embedding.apiKey) is required for provider=gemini");
    }
    const truncated = text.slice(0, 8000);
    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/v1beta/${modelPath}:embedContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        content: {
          parts: [{ text: truncated }],
        },
        taskType: this.geminiTaskType,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Gemini embedding failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ""}`,
      );
    }

    const data = (await response.json()) as {
      embedding?: { values?: number[] };
    };
    const embedding = data?.embedding?.values;
    if (!Array.isArray(embedding)) {
      throw new Error("Gemini response missing embedding.values");
    }
    return embedding;
  }

  private async embedCommand(text: string): Promise<number[]> {
    if (!this.command) {
      throw new Error("embedding.command is required when provider=command");
    }
    const truncated = text.slice(0, 8000);

    const payload = JSON.stringify({
      text: truncated,
      model: this.model,
      dimensions: this.dimensions,
    });

    const result = await runCommandForEmbedding({
      command: this.command,
      args: this.commandArgs,
      stdin: payload,
      timeoutMs: this.commandTimeoutMs,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`embedding.command returned non-JSON output: ${result.stdout.slice(0, 300)}`);
    }

    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "number")) {
      return parsed as number[];
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { embedding?: unknown }).embedding)
    ) {
      const emb = (parsed as { embedding: unknown[] }).embedding;
      if (emb.every((x) => typeof x === "number")) {
        return emb as number[];
      }
    }

    throw new Error("embedding.command JSON must be [number,...] or {\"embedding\":[number,...]}");
  }
}

async function runCommandForEmbedding(params: {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`embedding.command timed out after ${params.timeoutMs}ms`));
    }, params.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`embedding.command exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });

    child.stdin.write(params.stdin);
    child.stdin.end();
  });
}

// ============================================================================
// PostgreSQL Search
// ============================================================================

class ShadowSearch {
  private pool: pg.Pool | null = null;
  private connectionString: string;
  private table: string;
  private embedder: EmbeddingClient;
  private vectorWeight: number;
  private textWeight: number;

  constructor(params: {
    connectionString: string;
    table: string;
    embedder: EmbeddingClient;
    vectorWeight: number;
    textWeight: number;
  }) {
    this.connectionString = params.connectionString;
    this.table = params.table;
    this.embedder = params.embedder;
    this.vectorWeight = params.vectorWeight;
    this.textWeight = params.textWeight;
  }

  private getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({
        connectionString: this.connectionString,
        max: 3,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
    }
    return this.pool;
  }

  /**
   * Hybrid search: pgvector cosine similarity + FTS tsvector ranking,
   * merged with reciprocal rank fusion (RRF).
   */
  async search(query: string, maxResults: number, minScore: number): Promise<SearchResult[]> {
    const queryVec = await this.embedder.embed(query);
    const vecLiteral = `[${queryVec.join(",")}]`;

    // Single query: hybrid vector + FTS with RRF merge
    // CTE approach: run both searches, combine via RRF
    // Uses plainto_tsquery for broader FTS matching
    // Filters on rrf_score (not vec_score alone) so FTS-only matches survive
    const sql = `
      WITH vector_search AS (
        SELECT id, content, category, title, record_type,
               1 - (embedding <=> $1::vector) AS vec_score,
               ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS vec_rank
        FROM ${this.table}
        WHERE embedding IS NOT NULL
          AND superseded_by IS NULL AND contradicted IS NOT TRUE
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      ),
      fts_search AS (
        SELECT id, content, category, title, record_type,
               ts_rank_cd(fts, plainto_tsquery('english', $3)) AS fts_score,
               ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts, plainto_tsquery('english', $3)) DESC) AS fts_rank
        FROM ${this.table}
        WHERE fts IS NOT NULL
          AND fts @@ plainto_tsquery('english', $3)
          AND superseded_by IS NULL AND contradicted IS NOT TRUE
        ORDER BY fts_score DESC
        LIMIT $2
      ),
      trigram_search AS (
        SELECT id, content, category, title, record_type,
               similarity(content, $3) AS trgm_score,
               ROW_NUMBER() OVER (ORDER BY content <-> $3) AS trgm_rank
        FROM ${this.table}
        WHERE (content % $3 OR content ILIKE '%' || $3 || '%')
          AND superseded_by IS NULL AND contradicted IS NOT TRUE
        ORDER BY content <-> $3
        LIMIT $2
      ),
      combined AS (
        SELECT
          COALESCE(v.id, f.id, t.id) AS id,
          COALESCE(v.content, f.content, t.content) AS content,
          COALESCE(v.category, f.category, t.category) AS category,
          COALESCE(v.title, f.title, t.title) AS title,
          COALESCE(v.record_type, f.record_type, t.record_type) AS record_type,
          COALESCE(v.vec_score, 0) AS vec_score,
          -- RRF: 1/(k+rank) with k=60
          COALESCE($4::float * (1.0 / (60 + v.vec_rank)), 0) +
          COALESCE($5::float * (1.0 / (60 + f.fts_rank)), 0) +
          COALESCE(0.2 * (1.0 / (60 + t.trgm_rank)), 0) AS rrf_score
        FROM vector_search v
        FULL OUTER JOIN fts_search f ON v.id = f.id
        FULL OUTER JOIN trigram_search t ON COALESCE(v.id, f.id) = t.id
      )
      SELECT DISTINCT ON (id) id, content, category, title, record_type, vec_score, rrf_score
      FROM combined
      WHERE rrf_score > 0.001
      ORDER BY id, rrf_score DESC
    `;

    const result = await this.getPool().query(sql, [
      vecLiteral,
      maxResults * 5, // oversample for RRF merge + trigram
      query,
      this.vectorWeight,
      this.textWeight,
    ]);

    // Sort by rrf_score descending (DISTINCT ON resets ordering)
    const sorted = result.rows.sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        (parseFloat(b.rrf_score as string) || 0) - (parseFloat(a.rrf_score as string) || 0),
    );

    return sorted.slice(0, maxResults).map((row) => {
      const snippet = this.formatSnippet(row);
      const virtualPath = `shadowdb/${row.category || "general"}/${row.id}`;
      return {
        path: virtualPath,
        startLine: 1,
        endLine: 1,
        score: parseFloat(row.rrf_score) || parseFloat(row.vec_score) || 0,
        snippet,
        source: "memory",
        citation: `shadowdb:${this.table}#${row.id}`,
      };
    });
  }

  /**
   * Read a specific record by ID (for memory_get).
   */
  async get(recordId: number): Promise<{ text: string; path: string } | null> {
    const sql = `SELECT id, content, category, title, record_type FROM ${this.table} WHERE id = $1`;
    const result = await this.getPool().query(sql, [recordId]);
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    const virtualPath = `shadowdb/${row.category || "general"}/${row.id}`;
    return {
      text: this.formatFullRecord(row),
      path: virtualPath,
    };
  }

  /**
   * Read multiple records by category or keyword (for memory_get with path prefix).
   */
  async getByPath(
    pathQuery: string,
    from?: number,
    lines?: number,
  ): Promise<{ text: string; path: string }> {
    // Parse virtual path: shadowdb/{category}/{id} or shadowdb/{category}
    const parts = pathQuery.replace(/^shadowdb\//, "").split("/");

    if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
      // Specific record by ID
      const id = parseInt(parts[parts.length - 1], 10);
      const record = await this.get(id);
      if (!record) {
        return { text: `Record ${id} not found`, path: pathQuery };
      }
      if (from || lines) {
        const allLines = record.text.split("\n");
        const start = Math.max(1, from ?? 1);
        const count = Math.max(1, lines ?? allLines.length);
        return { text: allLines.slice(start - 1, start - 1 + count).join("\n"), path: pathQuery };
      }
      return record;
    }

    // Category listing
    const category = parts[0] || null;
    const sql = category
      ? `SELECT id, left(content, 200) as content, category, title FROM ${this.table} WHERE category = $1 ORDER BY id DESC LIMIT 20`
      : `SELECT id, left(content, 200) as content, category, title FROM ${this.table} ORDER BY id DESC LIMIT 20`;
    const params = category ? [category] : [];
    const result = await this.getPool().query(sql, params);

    const text = result.rows
      .map((r) => `[${r.id}] ${r.title || r.category || "—"}: ${(r.content || "").slice(0, 120)}`)
      .join("\n");

    return { text: text || "No records found", path: pathQuery };
  }

  async getStartupContext(maxChars: number): Promise<{
    text: string;
    digest: string;
    totalChars: number;
    rowCount: number;
    truncated: boolean;
  } | null> {
    const rows = await this.fetchStartupRows();
    if (rows.length === 0) {
      return null;
    }

    const sections = rows
      .map((row) => {
        const key = String(row.key || "startup").trim();
        const content = String(row.content || "").trim();
        if (!content) {
          return "";
        }
        return `## ${key}\n${content}`;
      })
      .filter(Boolean);

    if (sections.length === 0) {
      return null;
    }

    const fullText = sections.join("\n\n");
    const digest = createHash("sha1").update(fullText).digest("hex").slice(0, 16);

    const trimmedMax = Math.max(0, maxChars);
    const truncated = trimmedMax > 0 && fullText.length > trimmedMax;
    const text = truncated
      ? `${fullText.slice(0, trimmedMax)}\n\n[...startup context truncated...]`
      : fullText;

    return {
      text,
      digest,
      totalChars: fullText.length,
      rowCount: sections.length,
      truncated,
    };
  }

  private async fetchStartupRows(): Promise<Array<{ key: string; content: string }>> {
    const queries = [
      `SELECT key, content FROM startup WHERE (enabled IS NULL OR enabled IS TRUE) ORDER BY priority ASC NULLS LAST, key ASC`,
      `SELECT key, content FROM startup ORDER BY priority ASC NULLS LAST, key ASC`,
      `SELECT key, content FROM startup ORDER BY key ASC`,
    ];

    for (const sql of queries) {
      try {
        const result = await this.getPool().query(sql);
        return result.rows as Array<{ key: string; content: string }>;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "42P01") {
          // startup table missing
          return [];
        }
        // try fallback query variants for missing column/etc.
        continue;
      }
    }

    return [];
  }

  async ping(): Promise<boolean> {
    try {
      await this.getPool().query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private formatSnippet(row: {
    id: number;
    content: string;
    category?: string;
    title?: string;
    record_type?: string;
  }): string {
    const maxChars = 700;
    const header = [
      row.title ? `# ${row.title}` : null,
      row.category ? `[${row.category}]` : null,
      row.record_type && row.record_type !== row.category
        ? `type: ${row.record_type}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const prefix = header ? `${header}\n` : "";
    const body = (row.content || "").slice(0, maxChars - prefix.length);
    return `${prefix}${body}`.trim();
  }

  private formatFullRecord(row: {
    id: number;
    content: string;
    category?: string;
    title?: string;
    record_type?: string;
  }): string {
    const parts: string[] = [];
    if (row.title) parts.push(`# ${row.title}`);
    if (row.category) parts.push(`Category: ${row.category}`);
    if (row.record_type) parts.push(`Type: ${row.record_type}`);
    parts.push("");
    parts.push(row.content || "");
    return parts.join("\n");
  }
}

// ============================================================================
// Plugin
// ============================================================================

const memoryShadowdbPlugin = {
  id: "memory-shadowdb",
  name: "Memory (ShadowDB)",
  description:
    "PostgreSQL + pgvector memory search. Replaces memory-core with hybrid semantic + full-text search over ShadowDB.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig || {}) as PluginConfig;

    // Resolve connection
    const connectionString = resolveConnectionString(pluginCfg);
    const embeddingCfg = resolveEmbeddingConfig(pluginCfg);
    const tableName = pluginCfg.table || "memories";
    const maxResultsDefault = pluginCfg.search?.maxResults ?? 6;
    const minScoreDefault = pluginCfg.search?.minScore ?? 0.15;
    const vectorWeight = pluginCfg.search?.vectorWeight ?? 0.7;
    const textWeight = pluginCfg.search?.textWeight ?? 0.3;
    const startupCfg = resolveStartupInjectionConfig(pluginCfg);
    const startupInjectState = new Map<string, { digest: string; at: number }>();

    if (
      ["openai", "openai-compatible", "voyage", "gemini"].includes(embeddingCfg.provider) &&
      !embeddingCfg.apiKey
    ) {
      api.logger.warn(
        `memory-shadowdb: provider=${embeddingCfg.provider} selected but no API key found. Set embedding.apiKey or provider env var.`,
      );
    }

    if (embeddingCfg.provider === "command" && !embeddingCfg.command) {
      api.logger.warn(
        "memory-shadowdb: provider=command selected but embedding.command is missing.",
      );
    }

    const embedder = new EmbeddingClient({
      provider: embeddingCfg.provider,
      model: embeddingCfg.model,
      dimensions: embeddingCfg.dimensions,
      apiKey: embeddingCfg.apiKey,
      ollamaUrl: embeddingCfg.ollamaUrl,
      baseUrl: embeddingCfg.baseUrl,
      headers: embeddingCfg.headers,
      voyageInputType: embeddingCfg.voyageInputType,
      geminiTaskType: embeddingCfg.geminiTaskType,
      command: embeddingCfg.command,
      commandArgs: embeddingCfg.commandArgs,
      commandTimeoutMs: embeddingCfg.commandTimeoutMs,
    });

    const search = new ShadowSearch({
      connectionString,
      table: tableName,
      embedder,
      vectorWeight,
      textWeight,
    });

    api.logger.info(
      `memory-shadowdb: registered (table: ${tableName}, provider: ${embeddingCfg.provider}, model: ${embeddingCfg.model}, dims: ${embeddingCfg.dimensions}, startup: ${startupCfg.enabled ? startupCfg.mode : "disabled"})`,
    );

    // ========================================================================
    // Startup hydration hook (identity/rules front-load)
    // ========================================================================

    if (startupCfg.enabled) {
      api.on("before_agent_start", async (_event, ctx) => {
        try {
          const currentModel = (ctx as Record<string, unknown>)?.model as string | undefined;
          const effectiveMaxChars = resolveMaxCharsForModel(startupCfg, currentModel);

          const startup = await search.getStartupContext(effectiveMaxChars);
          if (!startup?.text) {
            return;
          }

          const sessionKey = (ctx?.sessionKey || "__global__").trim();
          const now = Date.now();
          const prev = startupInjectState.get(sessionKey);

          let shouldInject = false;
          if (startupCfg.mode === "always") {
            shouldInject = true;
          } else if (startupCfg.mode === "first-run") {
            shouldInject = !prev;
          } else {
            // digest mode
            shouldInject =
              !prev ||
              prev.digest !== startup.digest ||
              (startupCfg.cacheTtlMs > 0 && now - prev.at >= startupCfg.cacheTtlMs);
          }

          if (!shouldInject) {
            return;
          }

          startupInjectState.set(sessionKey, { digest: startup.digest, at: now });

          // Keep map bounded in long-running gateways.
          if (startupInjectState.size > 5000) {
            const stale = [...startupInjectState.entries()]
              .sort((a, b) => a[1].at - b[1].at)
              .slice(0, 1000)
              .map(([key]) => key);
            for (const key of stale) {
              startupInjectState.delete(key);
            }
          }

          const truncatedAttr = startup.truncated ? ' truncated="true"' : "";

          api.logger.debug?.(
            `memory-shadowdb: startup injected (mode=${startupCfg.mode}, model=${currentModel || "unknown"}, maxChars=${effectiveMaxChars}, rows=${startup.rowCount}, chars=${startup.totalChars}, digest=${startup.digest}, session=${sessionKey})`,
          );

          return {
            prependContext:
              `<startup-identity source="shadowdb" digest="${startup.digest}"${truncatedAttr}>
` +
              `${startup.text}
` +
              `</startup-identity>`,
          };
        } catch (err) {
          api.logger.warn(`memory-shadowdb startup hydration failed: ${String(err)}`);
          return;
        }
      });
    }

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      (ctx) => {
        // Return both memory_search and memory_get as a pair
        const memorySearchTool = {
          label: "Memory Search",
          name: "memory_search",
          description:
            "Mandatory recall step: semantically search the ShadowDB knowledge base before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
          parameters: Type.Object({
            query: Type.String(),
            maxResults: Type.Optional(Type.Number()),
            minScore: Type.Optional(Type.Number()),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const query = (params.query as string)?.trim();
            if (!query) {
              return jsonResult({ results: [], error: "empty query" });
            }
            const max = (params.maxResults as number) ?? maxResultsDefault;
            const min = (params.minScore as number) ?? minScoreDefault;

            try {
              const results = await search.search(query, max, min);

              // Attach citations
              const decorated = results.map((r) => ({
                ...r,
                snippet: `${r.snippet.trim()}\n\nSource: ${r.citation}`,
              }));

              return jsonResult({
                results: decorated,
                provider: "shadowdb",
                model: `pgvector+fts (${embeddingCfg.model})`,
                citations: "auto",
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              api.logger.warn(`memory-shadowdb search error: ${message}`);
              return jsonResult({ results: [], error: message });
            }
          },
        };

        const memoryGetTool = {
          label: "Memory Get",
          name: "memory_get",
          description:
            "Read a specific ShadowDB record by path (shadowdb/{category}/{id}); use after memory_search to pull full content.",
          parameters: Type.Object({
            path: Type.String(),
            from: Type.Optional(Type.Number()),
            lines: Type.Optional(Type.Number()),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const reqPath = (params.path as string)?.trim();
            if (!reqPath) {
              return jsonResult({ path: "", text: "", error: "path required" });
            }
            const from = params.from as number | undefined;
            const lines = params.lines as number | undefined;

            try {
              const result = await search.getByPath(reqPath, from, lines);
              return jsonResult(result);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return jsonResult({ path: reqPath, text: "", error: message });
            }
          },
        };

        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // ========================================================================
    // CLI
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const cmd = program
          .command("shadowdb")
          .description("ShadowDB memory plugin commands");

        cmd
          .command("ping")
          .description("Test PostgreSQL connection")
          .action(async () => {
            const ok = await search.ping();
            console.log(ok ? "✓ Connected" : "✗ Connection failed");
            process.exit(ok ? 0 : 1);
          });

        cmd
          .command("search")
          .description("Search ShadowDB")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", String(maxResultsDefault))
          .action(async (query: string, opts: { limit: string }) => {
            const results = await search.search(
              query,
              parseInt(opts.limit, 10),
              minScoreDefault,
            );
            for (const r of results) {
              console.log(`[${r.score.toFixed(3)}] ${r.citation}`);
              console.log(`  ${r.snippet.slice(0, 120).replace(/\n/g, " ")}`);
              console.log();
            }
          });

        cmd
          .command("get")
          .description("Get a specific record")
          .argument("<id>", "Record ID")
          .action(async (id: string) => {
            const record = await search.get(parseInt(id, 10));
            if (record) {
              console.log(record.text);
            } else {
              console.log(`Record ${id} not found`);
            }
          });
      },
      { commands: ["shadowdb"] },
    );

    // ========================================================================
    // Service (connection lifecycle)
    // ========================================================================

    api.registerService({
      id: "memory-shadowdb",
      start: async () => {
        const ok = await search.ping();
        if (ok) {
          api.logger.info("memory-shadowdb: PostgreSQL connection verified");
        } else {
          api.logger.warn("memory-shadowdb: PostgreSQL connection failed — searches will error");
        }
      },
      stop: async () => {
        await search.close();
        api.logger.info("memory-shadowdb: connection pool closed");
      },
    });
  },
};

// ============================================================================
// Helpers
// ============================================================================

function jsonResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export const __test__ = {
  normalizeEmbeddingProvider,
  resolveEmbeddingConfig,
  resolveStartupInjectionConfig,
  validateEmbeddingDimensions,
};

export default memoryShadowdbPlugin;
