/**
 * index.ts — OpenClaw memory plugin registration for memory-shadowdb
 *
 * Orchestrates:
 * - Backend selection (postgres, sqlite, mysql) based on config
 * - Embedding client initialization
 * - Tool registration (memory_search, memory_get, memory_write, memory_update, memory_delete, memory_undelete)
 * - CLI command registration
 * - Primer context injection hook
 * - Service lifecycle (start/stop)
 *
 * ARCHITECTURE:
 * - store.ts: Abstract MemoryStore base class with shared logic (RRF, formatting, validation)
 * - postgres.ts: PostgreSQL backend (pgvector + FTS + pg_trgm)
 * - sqlite.ts: SQLite backend (sqlite-vec + FTS5)
 * - mysql.ts: MySQL backend (native VECTOR + FULLTEXT)
 * - embedder.ts: Multi-provider embedding client (backend-agnostic)
 * - config.ts: Configuration resolution with fallback chains
 * - types.ts: Shared type definitions
 * - index.ts (this file): Plugin registration and orchestration
 *
 * BACKEND SELECTION:
 * Config key `backend` determines which store is used:
 * - "postgres" (default): Full features — vector, FTS, trigram, recency
 * - "sqlite": Zero-config — vector (if sqlite-vec installed), FTS5
 * - "mysql": MySQL 9.2+ — native vector, FULLTEXT
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveEmbeddingConfig, resolvePrimerConfig, normalizeEmbeddingProvider, validateEmbeddingDimensions, computeEmbeddingFingerprint } from "./config.js";
declare const memoryShadowdbPlugin: {
    id: string;
    name: string;
    description: string;
    kind: "memory";
    register(api: OpenClawPluginApi): void;
};
export declare const __test__: {
    normalizeEmbeddingProvider: typeof normalizeEmbeddingProvider;
    resolveEmbeddingConfig: typeof resolveEmbeddingConfig;
    resolvePrimerConfig: typeof resolvePrimerConfig;
    validateEmbeddingDimensions: typeof validateEmbeddingDimensions;
    computeEmbeddingFingerprint: typeof computeEmbeddingFingerprint;
};
export default memoryShadowdbPlugin;
