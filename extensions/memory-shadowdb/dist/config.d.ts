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
import type { ShadowDbConfig, EmbeddingProvider, PluginConfig, PrimerInjectionMode } from "./types.js";
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
export declare function loadShadowDbConfig(configPath?: string): ShadowDbConfig | null;
/**
 * Resolve PostgreSQL connection string from config cascade
 *
 * Resolution order (first found wins):
 * 1. Plugin config connectionString (explicit override)
 * 2. SHADOWDB_URL environment variable
 * 3. DATABASE_URL environment variable
 * 4. ~/.shadowdb.json postgres.connection_string
 * 5. ~/.shadowdb.json postgres.{host,port,user,password,database}
 * 6. Error — no silent fallback
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
export declare function resolveConnectionString(pluginCfg: PluginConfig): string;
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
export declare function normalizeEmbeddingProvider(value: string | undefined): EmbeddingProvider;
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
export declare function resolveEmbeddingConfig(pluginCfg: PluginConfig): {
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
};
/**
 * Resolve primer injection configuration with validation
 *
 * Primer injection loads DB records into the agent's initial context before
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
 * @returns Validated primer injection configuration
 */
export declare function resolvePrimerConfig(pluginCfg: PluginConfig): {
    enabled: boolean;
    mode: PrimerInjectionMode;
    maxChars: number;
    maxCharsByModel: Record<string, number>;
    cacheTtlMs: number;
};
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
 * @param primerCfg - Resolved primer configuration
 * @param model - Model name string (may be undefined for unknown/default model)
 * @returns Character limit for this model
 */
export declare function resolveMaxCharsForModel(primerCfg: {
    maxChars: number;
    maxCharsByModel: Record<string, number>;
}, model?: string): number;
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
export declare function validateEmbeddingDimensions(embedding: number[], expectedDimensions: number, providerModelLabel: string): number[];
/**
 * Compute a fingerprint for the current embedding configuration.
 * Used to detect when re-embedding is needed (model change, prefix change, etc).
 */
export declare function computeEmbeddingFingerprint(cfg: {
    provider: string;
    model: string;
    dimensions: number;
}): string;
