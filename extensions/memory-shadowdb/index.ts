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
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";

import type { PluginConfig, SearchResult, WriteResult } from "./types.js";
import {
  resolveConnectionString,
  resolveEmbeddingConfig,
  resolvePrimerConfig,
  resolveMaxCharsForModel,
  normalizeEmbeddingProvider,
  validateEmbeddingDimensions,
  computeEmbeddingFingerprint,
} from "./config.js";
import { EmbeddingClient } from "./embedder.js";
import type { MemoryStore, StoreConfig } from "./store.js";
import { parseRerankerConfig, checkRerankerHealth } from "./reranker.js";

// ============================================================================
// Backend factory — picks the right store based on config
// ============================================================================

/**
 * Create the appropriate MemoryStore backend based on config.
 *
 * Dynamically imports backend modules so unused backends don't add
 * to the dependency tree (e.g., SQLite users don't need pg).
 */
async function createStore(
  backend: string,
  connectionString: string,
  embedder: EmbeddingClient,
  storeConfig: StoreConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<MemoryStore> {
  switch (backend) {
    case "postgres": {
      const { PostgresStore } = await import("./postgres.js");
      return new PostgresStore({ connectionString, embedder, config: storeConfig, logger });
    }

    case "sqlite": {
      const { SQLiteStore } = await import("./sqlite.js");
      // For SQLite, connectionString is the file path (e.g., ~/.shadowdb/memory.db)
      const dbPath = connectionString || `${process.env.HOME}/.shadowdb/memory.db`;
      return new SQLiteStore({ dbPath, embedder, config: storeConfig, logger });
    }

    case "mysql": {
      const { MySQLStore } = await import("./mysql.js");
      return new MySQLStore({ connectionString, embedder, config: storeConfig, logger });
    }

    default:
      throw new Error(
        `memory-shadowdb: unknown backend "${backend}". Supported: postgres, sqlite, mysql`,
      );
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryShadowdbPlugin = {
  id: "memory-shadowdb",
  name: "Memory (ShadowDB)",
  description:
    "Database-backed agent memory with hybrid semantic + full-text search. Supports PostgreSQL, SQLite, and MySQL.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig || {}) as PluginConfig;

    // ========================================================================
    // Configuration Resolution
    // ========================================================================

    const backend = pluginCfg.backend || "postgres";
    const connectionString = resolveConnectionString(pluginCfg);
    const embeddingCfg = resolveEmbeddingConfig(pluginCfg);
    const tableName = pluginCfg.table || "memories";
    // maxResults: how many candidates survive RRF scoring.
    // With large DBs (5k+ records), 6 is too few — good records get cut before
    // ranking. 15 is a safe default; increase further for very large corpora.
    const maxResultsDefault = pluginCfg.search?.maxResults ?? 15;
    // RRF scores are much smaller than raw similarity scores.
    // With k=60 and weights summing to ~1.35, the theoretical max RRF score
    // for a rank-1 result across all signals is ~0.022. A threshold of 0.15
    // would filter out everything. Default 0.005 = "appeared in at least one
    // signal with reasonable rank."
    const minScoreDefault = pluginCfg.search?.minScore ?? 0.005;
    // Weight balance: vector embeddings excel at semantic/conceptual queries
    // but are weak for proper names (nomic-embed-text treats names as opaque
    // tokens). FTS/text search is more reliable for exact name matches.
    // 0.5/0.5 is a balanced default; bias toward vectorWeight for
    // concept-heavy corpora, toward textWeight for contact/name-heavy corpora.
    const vectorWeight = pluginCfg.search?.vectorWeight ?? 0.5;
    const textWeight = pluginCfg.search?.textWeight ?? 0.5;
    const recencyWeight = pluginCfg.search?.recencyWeight ?? 0.15;
    const minVectorScore = pluginCfg.search?.minVectorScore ?? 0;
    const primerCfg = resolvePrimerConfig(pluginCfg);

    const writesCfg = {
      enabled: pluginCfg.writes?.enabled === true,
      autoEmbed: pluginCfg.writes?.autoEmbed !== false,
      purgeAfterDays: typeof pluginCfg.writes?.retention?.purgeAfterDays === "number"
        ? Math.max(0, Math.floor(pluginCfg.writes.retention.purgeAfterDays))
        : 30,
    };

    // Reranker config — optional, degrades gracefully if absent/unreachable
    const rerankerCfg = parseRerankerConfig(pluginCfg);

    const storeConfig: StoreConfig = {
      table: tableName,
      vectorWeight,
      textWeight,
      recencyWeight,
      minVectorScore,
      autoEmbed: writesCfg.autoEmbed,
      purgeAfterDays: writesCfg.purgeAfterDays,
      reranker: rerankerCfg,
    };

    // Primer injection cache (bounded at 5000 entries)
    const primerState = new Map<string, { digest: string; at: number }>();

    // Warn about missing API keys
    if (
      ["openai", "openai-compatible", "voyage", "gemini"].includes(embeddingCfg.provider) &&
      !embeddingCfg.apiKey
    ) {
      api.logger.warn(
        `memory-shadowdb: provider=${embeddingCfg.provider} selected but no API key found.`,
      );
    }

    // ========================================================================
    // Initialize Embedding Client
    // ========================================================================

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

    // ========================================================================
    // Create Store (deferred — initialized in service start)
    // ========================================================================

    let store: MemoryStore | null = null;

    /**
     * Get or create the store instance.
     * Store is created lazily on first use and fully initialized in service.start().
     */
    async function getStore(): Promise<MemoryStore> {
      if (!store) {
        store = await createStore(backend, connectionString, embedder, storeConfig, api.logger);
      }
      return store;
    }

    // Reranker health check at startup (non-blocking — warn only)
    if (rerankerCfg.enabled) {
      checkRerankerHealth(rerankerCfg).then((healthy) => {
        if (healthy) {
          api.logger.info(
            `memory-shadowdb: reranker healthy at ${rerankerCfg.baseUrl} — cross-encoder reranking enabled`,
          );
        } else {
          api.logger.warn(
            `memory-shadowdb: reranker unreachable at ${rerankerCfg.baseUrl} — search will use RRF-only (degraded mode)`,
          );
        }
      }).catch(() => {/* health check errors are non-fatal */});
    }

    api.logger.info(
      `memory-shadowdb: registered (backend: ${backend}, table: ${tableName}, provider: ${embeddingCfg.provider}, model: ${embeddingCfg.model}, dims: ${embeddingCfg.dimensions}, primer: ${primerCfg.enabled ? primerCfg.mode : "disabled"}, writes: ${writesCfg.enabled ? "enabled" : "disabled"}, reranker: ${rerankerCfg.enabled ? rerankerCfg.baseUrl : "disabled"})`,
    );

    // ========================================================================
    // Primer Hydration Hook
    //
    // MECHANISM: OpenClaw's before_agent_start hook fires on EVERY agent turn
    // (it's per-turn, not per-session, despite the name). We use in-memory
    // caching to control when we actually inject:
    //
    //   digest mode (default):
    //     Turn 1 → no cache → inject primer context as prependContext
    //     Turn 2+ → cache hit, same digest → return nothing (skip)
    //     After cacheTtlMs (default 10min) → cache expired → re-inject
    //
    // On turns where we skip, the model still sees the primer block from
    // the earlier turn in its conversation history. The TTL refresh is a
    // safety net for long sessions where the original injection might scroll
    // out of the context window.
    //
    // This means primer context is NOT sent every turn — only on first turn
    // and periodically as a refresh.
    // ========================================================================

    if (primerCfg.enabled) {
      api.on("before_agent_start", async (_event, ctx) => {
        try {
          const s = await getStore();
          // Model isn't in the hook context (model resolution happens after this hook).
          // Read from the agent config's primary model, or the session-level override if available.
          const currentModel =
            (ctx as Record<string, unknown>)?.model as string | undefined ||
            (() => { const m = api.config?.agents?.defaults?.model; return typeof m === "object" && m !== null ? (m as { primary?: string }).primary : (m as string | undefined); })();
          const effectiveMaxChars = resolveMaxCharsForModel(primerCfg, currentModel);

          const primer = await s.getPrimerContext(effectiveMaxChars);
          if (!primer?.text) return;

          const sessionKey = (ctx?.sessionKey || "__global__").trim();
          const now = Date.now();

          // Detect session reset (/new): if message history is empty, evict cache
          // so the primer is re-injected on the first turn of the new session.
          // Without this, /new clears history but the primerState cache still has
          // the session key, causing the hook to skip injection (mode=digest/first-run).
          const eventMessages = (_event as Record<string, unknown>)?.messages;
          const historyLength = Array.isArray(eventMessages) ? eventMessages.length : -1;
          if (historyLength === 0) {
            primerState.delete(sessionKey);
            api.logger.info(`memory-shadowdb: session reset detected (session=${sessionKey}) — evicting primer cache`);
          }

          const prev = primerState.get(sessionKey);

          // Decide whether to inject this turn or skip (let history carry it)
          let shouldInject = false;
          if (primerCfg.mode === "always") {
            // Inject every turn (expensive — only use if you have a reason)
            shouldInject = true;
          } else if (primerCfg.mode === "first-run") {
            // Inject once per session, never refresh
            shouldInject = !prev;
          } else {
            // digest mode: inject on first turn, re-inject when content changes
            // or TTL expires (safety net for long conversations)
            shouldInject = !prev ||
              prev.digest !== primer.digest ||
              (primerCfg.cacheTtlMs > 0 && now - prev.at >= primerCfg.cacheTtlMs);
          }

          if (!shouldInject) {
            api.logger.info(`memory-shadowdb: primer skipped (cached, session=${sessionKey}, mode=${primerCfg.mode}, age=${prev ? Math.round((now - prev.at) / 1000) + 's' : 'n/a'}, ttl=${Math.round(primerCfg.cacheTtlMs / 1000)}s)`);
            return;
          }

          // Record that we injected for this session
          primerState.set(sessionKey, { digest: primer.digest, at: now });

          // Evict stale cache entries (bound map at 5000 to prevent memory leak)
          if (primerState.size > 5000) {
            const stale = [...primerState.entries()]
              .sort((a, b) => a[1].at - b[1].at)
              .slice(0, 1000)
              .map(([key]) => key);
            for (const key of stale) primerState.delete(key);
          }

          const injectedChars = primer.text.length;
          api.logger.info(`memory-shadowdb: primer injected (${injectedChars} chars, ${primer.includedCount}/${primer.rowCount} sections, model=${currentModel || "default"}, maxChars=${effectiveMaxChars}, session=${sessionKey})`);
          if (primer.truncated) {
            api.logger.warn(`memory-shadowdb: primer budget exceeded — skipped ${primer.skippedKeys.length} section(s): [${primer.skippedKeys.join(", ")}]. Total DB content: ${primer.totalChars} chars, budget: ${effectiveMaxChars}. Model: ${currentModel || "default"}`);
          }
          return {
            prependContext:
              `init:\n` +
              `${primer.text}\n` +
              `/init`,
          };
        } catch (err) {
          api.logger.warn(`memory-shadowdb primer hydration failed: ${String(err)}`);
          return;
        }
      });
    }

    // ========================================================================
    // Tool Registration: memory_search and memory_get
    // ========================================================================

    api.registerTool(
      (_ctx) => {
        const memorySearchTool = {
          label: "Memory Search",
          name: "memory_search",
          description:
            "Mandatory recall step: semantically search the ShadowDB knowledge base before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
          parameters: Type.Object({
            query: Type.String(),
            maxResults: Type.Optional(Type.Number()),
            minScore: Type.Optional(Type.Number()),
            category: Type.Optional(Type.String({ description: "Filter by category" })),
            record_type: Type.Optional(Type.String({ description: "Filter by record_type" })),
            tags_include: Type.Optional(Type.Array(Type.String(), { description: "Record must have ALL these tags" })),
            tags_any: Type.Optional(Type.Array(Type.String(), { description: "Record must have ANY of these tags" })),
            priority_min: Type.Optional(Type.Number({ description: "Minimum priority" })),
            priority_max: Type.Optional(Type.Number({ description: "Maximum priority" })),
            created_after: Type.Optional(Type.String({ description: "ISO date (created after)" })),
            created_before: Type.Optional(Type.String({ description: "ISO date (created before)" })),
            parent_id: Type.Optional(Type.Number({ description: "Filter by parent record ID" })),
            detail_level: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("snippet"), Type.Literal("section"), Type.Literal("full")], { description: "summary=title+meta only, snippet=excerpt (default), section=most relevant ## heading block (~200-500 tokens), full=complete content" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const query = (params.query as string)?.trim();
            if (!query) return jsonResult({ results: [], error: "empty query" });

            const max = (params.maxResults as number) ?? maxResultsDefault;
            const min = (params.minScore as number) ?? minScoreDefault;

            // Build optional filters object
            const filters: Record<string, unknown> = {};
            if (params.category) filters.category = params.category;
            if (params.record_type) filters.record_type = params.record_type;
            if (params.tags_include) filters.tags_include = params.tags_include;
            if (params.tags_any) filters.tags_any = params.tags_any;
            if (params.priority_min !== undefined) filters.priority_min = params.priority_min;
            if (params.priority_max !== undefined) filters.priority_max = params.priority_max;
            if (params.created_after) filters.created_after = params.created_after;
            if (params.created_before) filters.created_before = params.created_before;
            if (params.parent_id !== undefined) filters.parent_id = params.parent_id;
            const hasFilters = Object.keys(filters).length > 0;
            const detailLevel = params.detail_level as "summary" | "snippet" | "section" | "full" | undefined;

            api.logger.info(`memory-shadowdb: tool memory_search called — query="${query.slice(0, 80)}", max=${max}, min=${min}, filters=${hasFilters ? JSON.stringify(filters) : "none"}, detail=${detailLevel || "snippet"}`);

            try {
              const s = await getStore();
              const results = await s.search(
                query, max, min,
                hasFilters ? (filters as import("./types.js").SearchFilters) : undefined,
                detailLevel,
              );

              const decorated = results.map((r) => ({
                ...r,
                snippet: `${r.snippet.trim()}\n\nSource: ${r.citation}`,
              }));

              api.logger.info(`memory-shadowdb: tool memory_search returned ${decorated.length} results`);
              return jsonResult({
                results: decorated,
                provider: "shadowdb",
                backend,
                model: `${backend}+fts (${embeddingCfg.model})`,
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
            "Read a specific ShadowDB record by path (shadowdb/{category}/{id}); use after memory_search to pull full content. Use include_children to fetch child records, or section to fetch a specific child by metadata.section_name.",
          parameters: Type.Object({
            path: Type.String(),
            from: Type.Optional(Type.Number()),
            lines: Type.Optional(Type.Number()),
            include_children: Type.Optional(Type.Boolean({ description: "Also fetch and append child records (WHERE parent_id = id)" })),
            section: Type.Optional(Type.String({ description: "Return only child WHERE metadata->>'section_name' = this value" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const reqPath = (params.path as string)?.trim();
            if (!reqPath) return jsonResult({ path: "", text: "", error: "path required" });

            const opts: { include_children?: boolean; section?: string } = {};
            if (params.include_children) opts.include_children = true;
            if (params.section) opts.section = params.section as string;

            try {
              const s = await getStore();
              const result = await s.getByPath(reqPath, params.from as number, params.lines as number, opts);
              return jsonResult(result);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return jsonResult({ path: reqPath, text: "", error: message });
            }
          },
        };

        return [memorySearchTool, memoryGetTool] as AnyAgentTool[];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // ========================================================================
    // Tool Registration: Write tools (config-gated)
    // ========================================================================

    if (writesCfg.enabled) {
      api.registerTool(
        (_ctx) => {
          const memoryWriteTool = {
            label: "Memory Write",
            name: "memory_write",
            description:
              "Create a new memory record in ShadowDB. Requires writes.enabled in plugin config. " +
              "Auto-embeds for vector search if writes.autoEmbed is true.",
            parameters: Type.Object({
              content: Type.String({ description: "Record content (required, max 100K chars)" }),
              category: Type.Optional(Type.String({ description: 'Category (default: "general")' })),
              title: Type.Optional(Type.String({ description: "Human-readable title" })),
              tags: Type.Optional(Type.Array(Type.String(), { description: "Searchable tags (max 50)" })),
              record_type: Type.Optional(Type.String({ description: "Record type (atom, section, document, fact, index). Default: fact" })),
              metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "JSON metadata. Use for graph edges: {entity_a, entity_b, relationship_type, confidence, last_verified}" })),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              try {
                const s = await getStore();
                const result = await s.write({
                  content: params.content as string,
                  category: params.category as string | undefined,
                  title: params.title as string | undefined,
                  tags: params.tags as string[] | undefined,
                  record_type: params.record_type as string | undefined,
                  metadata: params.metadata as Record<string, unknown> | undefined,
                });
                return jsonResult(result as unknown as Record<string, unknown>);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                api.logger.warn(`memory-shadowdb write error: ${message}`);
                return jsonResult({ ok: false, error: message });
              }
            },
          };

          const memoryUpdateTool = {
            label: "Memory Update",
            name: "memory_update",
            description:
              "Update an existing memory record in ShadowDB. Partial update: only modifies provided fields. " +
              "Re-embeds automatically if content changes.",
            parameters: Type.Object({
              id: Type.Number({ description: "Record ID to update" }),
              content: Type.Optional(Type.String({ description: "New content (triggers re-embedding)" })),
              title: Type.Optional(Type.String({ description: "New title" })),
              category: Type.Optional(Type.String({ description: "New category" })),
              tags: Type.Optional(Type.Array(Type.String(), { description: "New tags (replaces existing)" })),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              try {
                const s = await getStore();
                const result = await s.update({
                  id: params.id as number,
                  content: params.content as string | undefined,
                  title: params.title as string | undefined,
                  category: params.category as string | undefined,
                  tags: params.tags as string[] | undefined,
                });
                return jsonResult(result as unknown as Record<string, unknown>);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                api.logger.warn(`memory-shadowdb update error: ${message}`);
                return jsonResult({ ok: false, error: message });
              }
            },
          };

          const memoryDeleteTool = {
            label: "Memory Delete",
            name: "memory_delete",
            description:
              "Soft-delete a memory record from ShadowDB (sets deleted_at, excluded from search). " +
              "Reversible via memory_undelete. Permanent removal happens only via retention policy.",
            parameters: Type.Object({
              id: Type.Number({ description: "Record ID to soft-delete" }),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              try {
                const s = await getStore();
                const result = await s.delete({ id: params.id as number });
                return jsonResult(result as unknown as Record<string, unknown>);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                api.logger.warn(`memory-shadowdb delete error: ${message}`);
                return jsonResult({ ok: false, error: message });
              }
            },
          };

          const memoryUndeleteTool = {
            label: "Memory Undelete",
            name: "memory_undelete",
            description:
              "Restore a soft-deleted memory record (clears deleted_at). " +
              "Only works if the record hasn't been permanently purged by retention policy.",
            parameters: Type.Object({
              id: Type.Number({ description: "Record ID to restore" }),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              try {
                const s = await getStore();
                const result = await s.undelete({ id: params.id as number });
                return jsonResult(result as unknown as Record<string, unknown>);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                api.logger.warn(`memory-shadowdb undelete error: ${message}`);
                return jsonResult({ ok: false, error: message });
              }
            },
          };

          return [memoryWriteTool, memoryUpdateTool, memoryDeleteTool, memoryUndeleteTool] as AnyAgentTool[];
        },
        { names: ["memory_write", "memory_update", "memory_delete", "memory_undelete"] },
      );

      // memory_list — filter/browse records by metadata
      api.registerTool(
        () => {
          const memoryListTool = {
            name: "memory_list",
            description: "List and filter ShadowDB records by category, tags, record_type, priority, parent_id, or date range. Returns structured metadata. Use detail_level='full' to include content.",
            parameters: Type.Object({
                category: Type.Optional(Type.String({ description: "Filter by category" })),
                tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (all must match)" })),
                tags_include: Type.Optional(Type.Array(Type.String(), { description: "Record must have ALL these tags (tags @> array)" })),
                tags_any: Type.Optional(Type.Array(Type.String(), { description: "Record must have ANY of these tags (tags && array)" })),
                record_type: Type.Optional(Type.String({ description: "Filter by record type (atom, section, document, fact, index)" })),
                parent_id: Type.Optional(Type.Number({ description: "Filter by parent record ID" })),
                priority_min: Type.Optional(Type.Number({ description: "Minimum priority (1=highest, 10=lowest)" })),
                priority_max: Type.Optional(Type.Number({ description: "Maximum priority" })),
                created_after: Type.Optional(Type.String({ description: "ISO date filter (created after)" })),
                created_before: Type.Optional(Type.String({ description: "ISO date filter (created before)" })),
                metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "JSON containment filter (metadata @> value)" })),
                detail_level: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("snippet"), Type.Literal("full")], { description: "summary=metadata only, snippet=excerpt, full=full content" })),
                sort: Type.Optional(Type.String({ description: "Sort column: created_at, updated_at, priority, title, or metadata.{field} (e.g. metadata.confidence). Default: created_at" })),
                sort_order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "Sort direction (default: desc)" })),
                limit: Type.Optional(Type.Number({ description: "Max results (default 50, max 200)" })),
                offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
            }),
            execute: async (_toolCallId: unknown, params: Record<string, unknown>) => {
              try {
                const store = await getStore();
                const results = await store.list({
                  category: params.category as string | undefined,
                  tags: params.tags as string[] | undefined,
                  tags_include: params.tags_include as string[] | undefined,
                  tags_any: params.tags_any as string[] | undefined,
                  record_type: params.record_type as string | undefined,
                  parent_id: params.parent_id as number | undefined,
                  priority_min: params.priority_min as number | undefined,
                  priority_max: params.priority_max as number | undefined,
                  created_after: params.created_after as string | undefined,
                  created_before: params.created_before as string | undefined,
                  metadata: params.metadata as Record<string, unknown> | undefined,
                  detail_level: params.detail_level as "summary" | "snippet" | "full" | undefined,
                  sort: params.sort as string | undefined,
                  sort_order: params.sort_order as "asc" | "desc" | undefined,
                  limit: params.limit as number | undefined,
                  offset: params.offset as number | undefined,
                });
                return jsonResult({ count: results.length, results });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                api.logger.warn(`memory-shadowdb memory_list error: ${message}`);
                return jsonResult({ ok: false, error: message });
              }
            },
          };
          return [memoryListTool] as AnyAgentTool[];
        },
        { names: ["memory_list"] },
      );
    }

    // ========================================================================
    // Tool Registration: memory_assemble (read-only, always available)
    // ========================================================================

    api.registerTool(
      () => {
        const memoryAssembleTool = {
          label: "Memory Assemble",
          name: "memory_assemble",
          description:
            "Token-budget-aware context assembly from ShadowDB. Searches broadly, scores by relevance+recency+priority, fills a token budget highest-score first. Returns assembled text with citations.",
          parameters: Type.Object({
            query: Type.String({ description: "What context is needed" }),
            token_budget: Type.Optional(Type.Number({ description: "Max tokens to return. If both token_budget and task_type provided, uses the lesser." })),
            task_type: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("outreach"), Type.Literal("dossier"), Type.Literal("research")], { description: "Preset token budget: quick=500, outreach=2000, dossier=5000, research=10000. Default: outreach" })),
            include_categories: Type.Optional(Type.Array(Type.String(), { description: "Limit to specific categories" })),
            include_tags: Type.Optional(Type.Array(Type.String(), { description: "Require any of these tags" })),
            exclude_categories: Type.Optional(Type.Array(Type.String(), { description: "Skip these categories" })),
            prioritize: Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("recency"), Type.Literal("priority")], { description: "Scoring emphasis (default: relevance)" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const query = (params.query as string)?.trim();
            if (!query) return jsonResult({ error: "query is required" });

            const taskType = params.task_type as "quick" | "outreach" | "dossier" | "research" | undefined;
            const tokenBudget = params.token_budget as number | undefined;

            api.logger.info(`memory-shadowdb: tool memory_assemble called — query="${query.slice(0, 80)}", task_type=${taskType || "none"}, budget=${tokenBudget ?? "default"}`);

            try {
              const s = await getStore();
              const result = await s.assemble({
                query,
                token_budget: tokenBudget,
                task_type: taskType,
                include_categories: params.include_categories as string[] | undefined,
                include_tags: params.include_tags as string[] | undefined,
                exclude_categories: params.exclude_categories as string[] | undefined,
                prioritize: params.prioritize as "relevance" | "recency" | "priority" | undefined,
              });
              return jsonResult(result as unknown as Record<string, unknown>);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              api.logger.warn(`memory-shadowdb memory_assemble error: ${message}`);
              return jsonResult({ error: message });
            }
          },
        };
        return [memoryAssembleTool] as AnyAgentTool[];
      },
      { names: ["memory_assemble"] },
    );

    api.registerTool(
      () => {
        const memoryGraphTool = {
          label: "Memory Graph",
          name: "memory_graph",
          description:
            "Traverse the entity relationship graph in ShadowDB. Given an entity slug (e.g. 'james-wilson'), returns all relationship edges and connected entities up to N hops away. Use for relationship mapping, intro framing, and affinity scoring.",
          parameters: Type.Object({
            entity: Type.String({ description: "Entity slug to start from (e.g. 'james-wilson', 'reece-dewoody')" }),
            hops: Type.Optional(Type.Number({ description: "Number of hops to traverse (default 1, max 3)" })),
            min_confidence: Type.Optional(Type.Number({ description: "Minimum edge confidence 0-100 (default 0 = include all)" })),
            relationship_type: Type.Optional(Type.String({ description: "Filter to specific relationship type (e.g. 'knows', 'tension', 'co-investors')" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            const entity = (params.entity as string)?.trim();
            if (!entity) return jsonResult({ error: "entity is required" });

            api.logger.info(`memory-shadowdb: tool memory_graph called — entity="${entity}", hops=${params.hops ?? 1}`);

            try {
              const s = await getStore();
              if (typeof (s as unknown as { graph: unknown }).graph !== "function") {
                return jsonResult({ error: "memory_graph requires PostgreSQL backend" });
              }
              const result = await (s as unknown as { graph: (p: Record<string, unknown>) => Promise<unknown> }).graph({
                entity,
                hops: params.hops as number | undefined,
                min_confidence: params.min_confidence as number | undefined,
                relationship_type: params.relationship_type as string | undefined,
              });
              return jsonResult(result as Record<string, unknown>);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              api.logger.warn(`memory-shadowdb memory_graph error: ${message}`);
              return jsonResult({ error: message });
            }
          },
        };
        return [memoryGraphTool] as AnyAgentTool[];
      },
      { names: ["memory_graph"] },
    );

    // ========================================================================
    // Tool Registration: memory_conflicts
    // ========================================================================

    api.registerTool(
      () => {
        const memoryConflictsTool = {
          label: "Memory Conflicts",
          name: "memory_conflicts",
          description:
            "Detect contradictory relationship edges in the graph (e.g. knows+tension, allies+rivals). Use to identify relationship inconsistencies before making introductions or recommendations.",
          parameters: Type.Object({
            domain: Type.Optional(Type.String({ description: "Filter to specific domain (e.g. 'civic', 'ma')" })),
            min_confidence: Type.Optional(Type.Number({ description: "Only check edges above this confidence threshold (0-100)" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            api.logger.info(`memory-shadowdb: tool memory_conflicts called`);

            try {
              const s = await getStore();
              const { handleConflictsTool } = await import("./tools.js");
              const result = await handleConflictsTool(s as any, {
                domain: params.domain as string | undefined,
                min_confidence: params.min_confidence as number | undefined,
              });
              return jsonResult(result as Record<string, unknown>);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              api.logger.warn(`memory-shadowdb memory_conflicts error: ${message}`);
              return jsonResult({ error: message });
            }
          },
        };
        return [memoryConflictsTool] as AnyAgentTool[];
      },
      { names: ["memory_conflicts"] },
    );

    // ========================================================================
    // Tool Registration: memory_decay_preview
    // ========================================================================

    api.registerTool(
      () => {
        const memoryDecayPreviewTool = {
          label: "Memory Decay Preview",
          name: "memory_decay_preview",
          description:
            "Preview confidence decay for stale relationship edges based on last_verified age. Does NOT modify data — shows what would decay. Use to identify edges needing verification.",
          parameters: Type.Object({
            half_life_days: Type.Optional(Type.Number({ description: "Half-life in days (default 30)" })),
            min_confidence: Type.Optional(Type.Number({ description: "Floor confidence level (default 0)" })),
          }),
          execute: async (_toolCallId: string, params: Record<string, unknown>) => {
            api.logger.info(`memory-shadowdb: tool memory_decay_preview called`);

            try {
              const s = await getStore();
              const { handleDecayPreviewTool } = await import("./tools.js");
              const result = await handleDecayPreviewTool(s as any, {
                half_life_days: params.half_life_days as number | undefined,
                min_confidence: params.min_confidence as number | undefined,
              });
              return jsonResult(result as Record<string, unknown>);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              api.logger.warn(`memory-shadowdb memory_decay_preview error: ${message}`);
              return jsonResult({ error: message });
            }
          },
        };
        return [memoryDecayPreviewTool] as AnyAgentTool[];
      },
      { names: ["memory_decay_preview"] },
    );

    // ========================================================================
    // CLI Registration
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const cmd = program
          .command("shadowdb")
          .description("ShadowDB memory plugin commands");

        cmd
          .command("ping")
          .description("Test database connection")
          .action(async () => {
            const s = await getStore();
            const ok = await s.ping();
            console.log(ok ? "✓ Connected" : "✗ Connection failed");
            process.exit(ok ? 0 : 1);
          });

        cmd
          .command("search")
          .description("Search ShadowDB")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", String(maxResultsDefault))
          .action(async (query: string, opts: { limit: string }) => {
            const s = await getStore();
            const results = await s.search(query, parseInt(opts.limit, 10), minScoreDefault);
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
            const s = await getStore();
            const record = await s.get(parseInt(id, 10));
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
    // Service Registration
    // ========================================================================

    api.registerService({
      id: "memory-shadowdb",
      start: async () => {
        const s = await getStore();

        // Initialize backend (create tables for SQLite/MySQL, no-op for Postgres)
        await s.initialize();

        // Run startup recovery scan for orphaned writes
        try {
          const { initializeStartupRecovery } = await import('./startup-recovery.js');
          const orphanCount = await initializeStartupRecovery();
          if (orphanCount > 0) {
            api.logger.warn(`memory-shadowdb: startup recovery: ${orphanCount} orphaned write(s) detected`);
          }
        } catch (err) {
          api.logger.warn(`memory-shadowdb: startup recovery failed: ${String(err)}`);
        }

        const ok = await s.ping();
        if (ok) {
          api.logger.info(`memory-shadowdb: ${backend} connection verified`);

          // Run retention purge on start
          if (writesCfg.enabled && writesCfg.purgeAfterDays > 0) {
            try {
              await s.runRetentionPurge();
            } catch (err) {
              api.logger.warn(`memory-shadowdb: retention purge failed: ${String(err)}`);
            }
          }

          // Check embedding fingerprint — re-embed if config changed
          try {
            const fingerprint = computeEmbeddingFingerprint({
              provider: embeddingCfg.provider,
              model: embeddingCfg.model,
              dimensions: embeddingCfg.dimensions,
            });
            const stored = await s.getMetaValue("embedding_fingerprint");

            if (stored !== fingerprint) {
              const reason = stored
                ? `fingerprint changed (${stored} → ${fingerprint})`
                : "no stored fingerprint (first run or upgrade)";
              api.logger.info(`memory-shadowdb: embedding config mismatch — ${reason}. Starting background re-embed...`);

              // Background re-embed — don't block startup
              (async () => {
                try {
                  const startTime = Date.now();
                  const result = await s.reembedAll((done, _total) => {
                    if (done % 500 === 0) {
                      api.logger.info(`memory-shadowdb: re-embed progress: ${done} records processed`);
                    }
                  });
                  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                  api.logger.info(
                    `memory-shadowdb: re-embed complete — ${result.success} success, ${result.errors} errors, ${elapsed}s`,
                  );
                  await s.setMetaValue("embedding_fingerprint", fingerprint);
                } catch (err) {
                  api.logger.warn(`memory-shadowdb: background re-embed failed: ${String(err)}`);
                }
              })();
            } else {
              api.logger.info(`memory-shadowdb: embedding fingerprint matches (${fingerprint}) — no re-embed needed`);
            }
          } catch (err) {
            api.logger.warn(`memory-shadowdb: fingerprint check failed: ${String(err)}`);
          }
        } else {
          api.logger.warn(`memory-shadowdb: ${backend} connection failed — searches will error`);
        }
      },
      stop: async () => {
        if (store) {
          await store.close();
          api.logger.info("memory-shadowdb: connection closed");
        }
      },
    });
  },
};

// ============================================================================
// Helpers
// ============================================================================

function jsonResult(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// ============================================================================
// Exports
// ============================================================================

export const __test__ = {
  normalizeEmbeddingProvider,
  resolveEmbeddingConfig,
  resolvePrimerConfig,
  validateEmbeddingDimensions,
  computeEmbeddingFingerprint,
  resolveMaxCharsForModel,
};

export default memoryShadowdbPlugin;
