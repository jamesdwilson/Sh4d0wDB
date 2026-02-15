/**
 * config.ts — Configuration resolution for memory-shadowdb
 *
 * Handles loading and resolving all plugin configuration with well-defined
 * fallback chains. All config sources are trusted (plugin config, env vars,
 * config files) — never accept config from user input or external sources.
 *
 * SECURITY MODEL:
 * - Connection strings may contain credentials — never log in full
 * - API keys are sourced from config/env only — never from user input
 * - Password fields are never logged
 * - All config resolution is deterministic and auditable
 *
 * DATA FLOW:
 * 1. Plugin config (openclaw.json)
 * 2. Environment variables
 * 3. Config file (~/.shadowdb.json)
 * 4. Hard-coded defaults
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  ShadowDbConfig,
  EmbeddingProvider,
  PluginConfig,
  StartupInjectionMode,
} from "./types.js";

/**
 * Load ShadowDB configuration from JSON file
 *
 * Tries plugin-specified path first, then ~/.shadowdb.json.
 * Returns null if no valid config file found (not an error — will fall back to env/defaults).
 *
 * SECURITY: This file may contain database passwords. Contents should never be
 * logged in full. Only log connection success/failure status.
 *
 * @param configPath - Optional explicit config file path from plugin config
 * @returns Parsed config object or null if no file found
 */
export function loadShadowDbConfig(configPath?: string): ShadowDbConfig | null {
  const tryPaths = [
    configPath,
    path.join(os.homedir(), ".shadowdb.json"),
  ].filter(Boolean) as string[];

  for (const p of tryPaths) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw) as ShadowDbConfig;
    } catch {
      // File missing or invalid JSON — try next path
      continue;
    }
  }
  return null;
}

/**
 * Resolve PostgreSQL connection string from config cascade
 *
 * Resolution order (first found wins):
 * 1. Plugin config connectionString (explicit override)
 * 2. SHADOWDB_URL environment variable
 * 3. DATABASE_URL environment variable
 * 4. ~/.shadowdb.json postgres.connection_string
 * 5. ~/.shadowdb.json postgres.{host,port,user,password,database}
 * 6. Fallback: local socket connection
 *
 * SECURITY NOTES:
 * - The returned string may contain credentials (postgresql://user:pass@host/db)
 * - NEVER log the full connection string
 * - Only log success/failure and which config source was used
 * - Password encoding uses encodeURIComponent to handle special chars safely
 *
 * @param pluginCfg - Plugin configuration object
 * @returns PostgreSQL connection string (may contain credentials)
 */
export function resolveConnectionString(pluginCfg: PluginConfig): string {
  // 1. Explicit plugin config (highest priority)
  if (pluginCfg.connectionString) {
    return pluginCfg.connectionString;
  }

  // 2. Environment variables (preferred for containerized/cloud deployments)
  if (process.env.SHADOWDB_URL) {
    return process.env.SHADOWDB_URL;
  }
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  // 3. Config file (~/.shadowdb.json)
  const shadowCfg = loadShadowDbConfig(pluginCfg.configPath);
  if (shadowCfg?.postgres) {
    const pg = shadowCfg.postgres;
    
    // Prefer explicit connection_string field
    if (pg.connection_string) {
      return pg.connection_string;
    }
    
    // Build connection string from components
    const host = pg.host || "localhost";
    const port = pg.port || 5432;
    const user = pg.user || process.env.USER || "postgres";
    const db = pg.database || "shadow";
    
    // SECURITY: Password is URL-encoded to handle special characters
    // and only included if present. Never log the password value.
    const password = pg.password ? `:${encodeURIComponent(pg.password)}` : "";
    
    return `postgresql://${user}${password}@${host}:${port}/${db}`;
  }

  // 4. Fallback: local Unix socket connection (no network, no password)
  // Assumes PostgreSQL is running locally with peer auth
  return `postgresql:///${process.env.USER || "shadow"}`;
}

/**
 * Normalize embedding provider string to canonical type
 *
 * Handles common aliases and variations for provider names.
 * This normalization happens early so all downstream code can use
 * the canonical EmbeddingProvider type.
 *
 * @param value - Raw provider string from config (may be undefined)
 * @returns Canonical EmbeddingProvider type
 */
export function normalizeEmbeddingProvider(value: string | undefined): EmbeddingProvider {
  const v = (value || "ollama").trim().toLowerCase();
  
  switch (v) {
    // OpenAI-compatible API aliases
    case "openai-compatible":
    case "openai_compatible":
    case "openai-compatible-api":
      return "openai-compatible";
    
    // Voyage AI
    case "voyage":
      return "voyage";
    
    // Google Gemini aliases
    case "gemini":
    case "google":
      return "gemini";
    
    // External command/process
    case "command":
    case "external":
    case "custom":
      return "command";
    
    // OpenAI
    case "openai":
      return "openai";
    
    // Default: Ollama (local, no auth required)
    case "ollama":
    default:
      return "ollama";
  }
}

/**
 * Resolve complete embedding configuration with provider-specific defaults
 *
 * SECURITY NOTES:
 * - API keys are sourced from plugin config or environment variables ONLY
 * - Never accept API keys from user input, tool parameters, or external sources
 * - Keys are never logged (logging happens in caller if needed, but never key values)
 * - Custom headers may contain auth tokens — treat as sensitive
 * - Command-based provider: executable path comes from config only (no user input)
 *
 * Environment variables by provider:
 * - openai/openai-compatible: OPENAI_API_KEY
 * - voyage: VOYAGE_API_KEY
 * - gemini: GEMINI_API_KEY or GOOGLE_API_KEY
 * - ollama: no key required
 * - command: no key required (uses command/args config)
 *
 * @param pluginCfg - Plugin configuration object
 * @returns Complete embedding configuration with all defaults resolved
 */
export function resolveEmbeddingConfig(pluginCfg: PluginConfig): {
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

  // SECURITY: API key resolution — plugin config takes precedence over env vars
  // This allows explicit override but defaults to env for cloud deployments
  const apiKeyByProvider =
    provider === "openai" || provider === "openai-compatible"
      ? process.env.OPENAI_API_KEY || ""
      : provider === "voyage"
        ? process.env.VOYAGE_API_KEY || ""
        : provider === "gemini"
          ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
          : "";

  const apiKey = embeddingCfg.apiKey || apiKeyByProvider;

  // Provider-specific model defaults
  // These are known-good defaults for each provider's most common use case
  const modelDefaultByProvider: Record<EmbeddingProvider, string> = {
    ollama: "nomic-embed-text",
    openai: "text-embedding-3-small",
    "openai-compatible": "text-embedding-3-small",
    voyage: "voyage-3-lite",
    gemini: "text-embedding-004",
    command: "external-command",
  };

  const model = embeddingCfg.model || modelDefaultByProvider[provider];
  
  // Default dimension: 768 (nomic-embed-text, many common models)
  // This MUST match the pgvector column dimension in the database
  const dimensions = embeddingCfg.dimensions || 768;
  
  const ollamaUrl = embeddingCfg.ollamaUrl || process.env.OLLAMA_URL || "http://localhost:11434";
  
  // Provider-specific base URL defaults
  const baseUrlDefaultByProvider: Record<EmbeddingProvider, string> = {
    ollama: ollamaUrl,
    openai: "https://api.openai.com",
    "openai-compatible": process.env.EMBEDDING_BASE_URL || "https://api.openai.com",
    voyage: "https://api.voyageai.com",
    gemini: "https://generativelanguage.googleapis.com",
    command: "", // Not used for command provider
  };
  
  const baseUrl = embeddingCfg.baseUrl || baseUrlDefaultByProvider[provider];
  
  // SECURITY: Custom headers may contain auth tokens — never log header values
  const headers = embeddingCfg.headers || {};
  
  // Provider-specific option defaults
  const voyageInputType = embeddingCfg.voyageInputType || "query";
  const geminiTaskType = embeddingCfg.geminiTaskType || "RETRIEVAL_QUERY";
  
  // Command-based provider configuration
  // SECURITY: Command path comes from config only, never user input
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

/**
 * Resolve startup injection configuration with validation
 *
 * Startup injection loads DB records into the agent's initial context before
 * the first user message. This front-loads identity, rules, and critical memory.
 *
 * SECURITY NOTES:
 * - maxChars bounds prevent unbounded context injection (DoS protection)
 * - Maximum injected chars: min(maxChars, available DB content)
 * - Map size is capped at 5000 entries to prevent memory exhaustion
 * - Model-aware overrides enable small-context models to get compact essentials
 *
 * Mode semantics:
 * - always: inject on every agent start (highest overhead, strictest parity)
 * - first-run: inject only once per session (lowest overhead)
 * - digest: inject when DB content changes or cache expires (balanced)
 *
 * @param pluginCfg - Plugin configuration object
 * @returns Validated startup injection configuration
 */
export function resolveStartupInjectionConfig(pluginCfg: PluginConfig): {
  enabled: boolean;
  mode: StartupInjectionMode;
  maxChars: number;
  maxCharsByModel: Record<string, number>;
  cacheTtlMs: number;
} {
  const startup = pluginCfg.startup || {};
  
  // Normalize and validate mode string
  const rawMode = String(startup.mode || "always").trim().toLowerCase();
  const mode: StartupInjectionMode =
    rawMode === "always" || rawMode === "first-run" || rawMode === "digest"
      ? (rawMode as StartupInjectionMode)
      : "always"; // Invalid mode falls back to "always"

  // SECURITY: Validate and bound maxChars to prevent DoS via unbounded injection
  // Must be positive finite number, defaults to 4000 (safe for most models)
  const maxChars =
    typeof startup.maxChars === "number" && Number.isFinite(startup.maxChars) && startup.maxChars > 0
      ? Math.floor(startup.maxChars)
      : 4000;

  // Model-aware maxChars overrides
  // Enables small-context models (ministral-8b, qwen3) to get compact essentials
  // while large-context models (opus, sonnet) get full priority stack
  // Pattern matching is case-insensitive substring match
  const maxCharsByModel: Record<string, number> = {};
  if (startup.maxCharsByModel && typeof startup.maxCharsByModel === "object") {
    for (const [pattern, chars] of Object.entries(startup.maxCharsByModel)) {
      if (typeof chars === "number" && Number.isFinite(chars) && chars > 0) {
        // Pattern is lowercased for case-insensitive matching
        maxCharsByModel[pattern.toLowerCase()] = Math.floor(chars);
      }
    }
  }

  // SECURITY: Cache TTL validation — must be non-negative finite number
  // Default: 10 minutes (600,000 ms)
  const cacheTtlMs =
    typeof startup.cacheTtlMs === "number" && Number.isFinite(startup.cacheTtlMs) && startup.cacheTtlMs >= 0
      ? Math.floor(startup.cacheTtlMs)
      : 10 * 60 * 1000;

  return {
    enabled: startup.enabled !== false, // Default: enabled
    mode,
    maxChars,
    maxCharsByModel,
    cacheTtlMs,
  };
}

/**
 * Resolve maxChars for a specific model using pattern matching
 *
 * Checks maxCharsByModel patterns in definition order — first match wins.
 * Pattern matching is case-insensitive substring match against model name.
 *
 * Example:
 * - Model: "claude-opus-4"
 * - Patterns: { "opus": 6000, "claude": 5000 }
 * - Result: 6000 (first match)
 *
 * Falls back to default maxChars if no pattern matches or model is unknown.
 *
 * @param startupCfg - Resolved startup configuration
 * @param model - Model name string (may be undefined for unknown/default model)
 * @returns Character limit for this model
 */
export function resolveMaxCharsForModel(
  startupCfg: { maxChars: number; maxCharsByModel: Record<string, number> },
  model?: string,
): number {
  if (!model || Object.keys(startupCfg.maxCharsByModel).length === 0) {
    return startupCfg.maxChars;
  }
  
  const modelLower = model.toLowerCase();
  
  // First match wins — order matters!
  for (const [pattern, chars] of Object.entries(startupCfg.maxCharsByModel)) {
    if (modelLower.includes(pattern)) {
      return chars;
    }
  }
  
  return startupCfg.maxChars;
}

/**
 * Validate embedding dimensions and enforce strict matching
 *
 * SECURITY/CORRECTNESS: Dimension mismatches cause silent degradation or crashes.
 * We fail loudly with a clear error message instead of allowing corrupted embeddings.
 *
 * This check is critical because:
 * - pgvector column has fixed dimensions (e.g., vector(768))
 * - Inserting wrong-sized vector causes SQL error or silent truncation
 * - Querying with wrong-sized vector returns garbage similarity scores
 *
 * Dimension validation is a defense against:
 * - Config errors (wrong model or dimensions setting)
 * - Provider changes (model upgrade without config update)
 * - API bugs (provider returns unexpected dimensions)
 *
 * @param embedding - Embedding vector from provider
 * @param expectedDimensions - Expected dimension count from config
 * @param providerModelLabel - Provider and model for error message
 * @returns The validated embedding vector (same as input)
 * @throws Error if dimensions don't match (and expectedDimensions > 0)
 */
export function validateEmbeddingDimensions(
  embedding: number[],
  expectedDimensions: number,
  providerModelLabel: string,
): number[] {
  // Only validate if expectedDimensions is explicitly set
  // (expectedDimensions=0 means "no validation")
  if (expectedDimensions > 0 && embedding.length !== expectedDimensions) {
    throw new Error(
      `Embedding dimension mismatch for ${providerModelLabel}: expected ${expectedDimensions}, got ${embedding.length}. ` +
        "Check embedding.dimensions and your model/provider output size.",
    );
  }
  return embedding;
}
