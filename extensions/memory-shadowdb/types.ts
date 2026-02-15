/**
 * types.ts — Type definitions for memory-shadowdb plugin
 *
 * Pure type definitions with no runtime logic. All types used across the plugin
 * are centralized here for maintainability and clarity.
 *
 * Security: No sensitive data or logic here, only type definitions.
 */

/**
 * Configuration file structure for ~/.shadowdb.json
 *
 * Contains PostgreSQL connection details. This file may contain sensitive
 * credentials (passwords, connection strings) and should never be logged
 * in full or exposed to untrusted contexts.
 */
export type ShadowDbConfig = {
  backend?: string;
  postgres?: {
    /** Full connection string (postgresql://user:pass@host:port/db) */
    connection_string?: string;
    host?: string;
    port?: number;
    user?: string;
    /** SECURITY: Password field — never log this value */
    password?: string;
    database?: string;
  };
};

/**
 * Supported embedding providers
 *
 * Each provider has different authentication and API requirements:
 * - ollama: local, no auth required
 * - openai: requires OPENAI_API_KEY
 * - openai-compatible: requires API key and base URL
 * - voyage: requires VOYAGE_API_KEY
 * - gemini: requires GEMINI_API_KEY or GOOGLE_API_KEY
 * - command: external process via stdin/stdout
 */
export type EmbeddingProvider =
  | "ollama"
  | "openai"
  | "openai-compatible"
  | "voyage"
  | "gemini"
  | "command";

/**
 * Plugin configuration structure
 *
 * SECURITY NOTES:
 * - connectionString: may contain credentials, never log in full
 * - embedding.apiKey: API key for embedding providers, never logged
 * - embedding.headers: may contain auth headers, treat as sensitive
 * - All connection/auth config must be sourced from config files or env vars only,
 *   never from user input or external sources
 */
export type PluginConfig = {
  /** PostgreSQL connection string. SECURITY: may contain credentials */
  connectionString?: string;
  
  /** Path to ~/.shadowdb.json config file */
  configPath?: string;
  
  /** Embedding provider configuration */
  embedding?: {
    /** Provider type (ollama, openai, etc.) */
    provider?: EmbeddingProvider | string;
    
    /** API key for cloud providers. SECURITY: never logged */
    apiKey?: string;
    
    /** Model name/identifier */
    model?: string;
    
    /** Expected embedding dimensions (must match pgvector column) */
    dimensions?: number;
    
    /** Ollama base URL */
    ollamaUrl?: string;
    
    /** Base URL for API-based providers */
    baseUrl?: string;
    
    /** Custom HTTP headers. SECURITY: may contain auth tokens */
    headers?: Record<string, string>;
    
    /** Voyage-specific: input type hint */
    voyageInputType?: "query" | "document";
    
    /** Gemini-specific: task type hint */
    geminiTaskType?: string;
    
    /** Command-based provider: executable path */
    command?: string;
    
    /** Command-based provider: CLI arguments */
    commandArgs?: string[];
    
    /** Command timeout in milliseconds */
    commandTimeoutMs?: number;
  };
  
  /** Database table name (default: "memories") */
  table?: string;
  
  /** Search behavior configuration */
  search?: {
    /** Maximum number of results to return */
    maxResults?: number;
    
    /** Minimum score threshold for results */
    minScore?: number;
    
    /** Weight for vector similarity in RRF scoring */
    vectorWeight?: number;
    
    /** Weight for full-text search in RRF scoring */
    textWeight?: number;
  };
  
  /** Startup context injection configuration */
  startup?: {
    /** Enable/disable startup context injection */
    enabled?: boolean;
    
    /** Injection strategy: always, first-run, or digest-based */
    mode?: "always" | "first-run" | "digest";
    
    /** Maximum characters to inject (default: 4000) */
    maxChars?: number;
    
    /**
     * Model-aware maxChars overrides
     * 
     * Maps model name patterns (substring match) to character limits.
     * Enables small-context models to get compact essentials while
     * large-context models get full priority stack.
     * 
     * Example: { "opus": 6000, "ministral-8b": 1500 }
     */
    maxCharsByModel?: Record<string, number>;
    
    /** Cache TTL for digest mode (milliseconds) */
    cacheTtlMs?: number;
  };
};

/**
 * Startup injection mode strategies
 *
 * - always: inject on every agent start (highest overhead, strictest parity)
 * - first-run: inject only on first session start (lowest overhead)
 * - digest: inject when content changes or cache expires (balanced)
 */
export type StartupInjectionMode = "always" | "first-run" | "digest";

/**
 * Memory search result structure
 *
 * Returned by memory_search tool with all metadata needed for citation
 * and follow-up retrieval via memory_get.
 */
export type SearchResult = {
  /** Virtual path for this result (shadowdb/{category}/{id}) */
  path: string;
  
  /** Starting line number (always 1 for DB records) */
  startLine: number;
  
  /** Ending line number (always 1 for DB records) */
  endLine: number;
  
  /** Relevance score (RRF-combined vector + FTS + trigram) */
  score: number;
  
  /** Content snippet with metadata header */
  snippet: string;
  
  /** Source identifier ("memory") */
  source: string;
  
  /** Citation string (shadowdb:table#id) */
  citation?: string;
};
