/**
 * index.ts — OpenClaw memory plugin registration for memory-shadowdb
 *
 * This is the main entry point for the plugin. It orchestrates:
 * - Configuration resolution
 * - Embedding client initialization
 * - Search service setup
 * - Tool registration (memory_search, memory_get, memory_write, memory_update, memory_delete)
 * - CLI command registration
 * - Startup context injection hook
 * - Service lifecycle (start/stop)
 *
 * ARCHITECTURE:
 * - types.ts: Pure type definitions (SearchResult, WriteResult, PluginConfig, etc.)
 * - config.ts: Configuration resolution with fallback chains
 * - embedder.ts: Multi-provider embedding client
 * - search.ts: PostgreSQL hybrid search implementation (read path)
 * - writer.ts: Memory write/update/delete with auto-embedding (write path)
 * - index.ts (this file): Plugin registration and orchestration
 *
 * SECURITY MODEL:
 * - All config sources are trusted (plugin config, env vars, config files)
 * - No user input flows into SQL queries (all parameterized)
 * - API keys and connection strings never logged
 * - Startup injection bounded by maxChars to prevent DoS
 * - Connection pool capped at 3 connections
 *
 * DROP-IN COMPATIBILITY:
 * - Registers memory_search and memory_get tools (same API as memory-core)
 * - Startup hydration via before_agent_start hook
 * - Clean rollback: disable plugin → falls back to memory-core
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";

// Local module imports (ESM .js extensions required)
import type { PluginConfig, SearchResult, WriteResult } from "./types.js";
import {
  resolveConnectionString,
  resolveEmbeddingConfig,
  resolveStartupInjectionConfig,
  resolveMaxCharsForModel,
  normalizeEmbeddingProvider,
  validateEmbeddingDimensions,
} from "./config.js";
import { EmbeddingClient } from "./embedder.js";
import { ShadowSearch } from "./search.js";
import { ShadowWriter } from "./writer.js";

/**
 * Memory-ShadowDB Plugin Definition
 *
 * Registers as a "memory" plugin for OpenClaw, providing database-backed
 * memory retrieval with hybrid semantic + full-text search.
 *
 * LIFECYCLE:
 * 1. register() called by OpenClaw during plugin load
 * 2. Config resolved from cascade: plugin config → env vars → ~/.shadowdb.json
 * 3. Embedding client initialized with provider-specific settings
 * 4. Search client initialized with connection pool
 * 5. Tools registered: memory_search, memory_get
 * 6. CLI registered: shadowdb {ping,search,get}
 * 7. Service registered: connection validation + cleanup
 * 8. Startup hook registered: inject DB context before agent start
 */
const memoryShadowdbPlugin = {
  id: "memory-shadowdb",
  name: "Memory (ShadowDB)",
  description:
    "PostgreSQL + pgvector memory search. Replaces memory-core with hybrid semantic + full-text search over ShadowDB.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig || {}) as PluginConfig;

    // ========================================================================
    // Configuration Resolution
    // ========================================================================

    // SECURITY: Connection string may contain credentials — never log in full
    const connectionString = resolveConnectionString(pluginCfg);
    
    const embeddingCfg = resolveEmbeddingConfig(pluginCfg);
    const tableName = pluginCfg.table || "memories";
    const maxResultsDefault = pluginCfg.search?.maxResults ?? 6;
    const minScoreDefault = pluginCfg.search?.minScore ?? 0.15;
    const vectorWeight = pluginCfg.search?.vectorWeight ?? 0.7;
    const textWeight = pluginCfg.search?.textWeight ?? 0.3;
    const startupCfg = resolveStartupInjectionConfig(pluginCfg);

    // ========================================================================
    // Write Operations Configuration
    // ========================================================================
    
    // SECURITY: Write config resolution — all gates default to safe values.
    // writes.enabled defaults to false (no writes unless explicitly enabled).
    // writes.autoEmbed defaults to true (new records are immediately searchable).
    // writes.allowDelete defaults to false (only soft-delete permitted).
    const writesCfg = {
      enabled: pluginCfg.writes?.enabled === true,         // Must be explicitly true
      autoEmbed: pluginCfg.writes?.autoEmbed !== false,    // Default true
      allowDelete: pluginCfg.writes?.allowDelete === true, // Must be explicitly true
    };
    
    // SECURITY: Startup injection cache bounded at 5000 entries (prevents memory exhaustion)
    const startupInjectState = new Map<string, { digest: string; at: number }>();

    // Warn about missing API keys for cloud providers
    if (
      ["openai", "openai-compatible", "voyage", "gemini"].includes(embeddingCfg.provider) &&
      !embeddingCfg.apiKey
    ) {
      api.logger.warn(
        `memory-shadowdb: provider=${embeddingCfg.provider} selected but no API key found. Set embedding.apiKey or provider env var.`,
      );
    }

    // Warn about missing command for command-based provider
    if (embeddingCfg.provider === "command" && !embeddingCfg.command) {
      api.logger.warn(
        "memory-shadowdb: provider=command selected but embedding.command is missing.",
      );
    }

    // ========================================================================
    // Initialize Embedding Client and Search Service
    // ========================================================================

    // SECURITY: API keys passed to constructor, never logged
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

    // SECURITY: Connection pool capped at 3 connections (in ShadowSearch constructor)
    const search = new ShadowSearch({
      connectionString,
      table: tableName,
      embedder,
      vectorWeight,
      textWeight,
    });

    // Initialize writer lazily (uses shared pool from search to avoid duplicate connections).
    // Lazy init ensures the pool is created before the writer tries to use it.
    // SECURITY: Tools are only registered when writesCfg.enabled is true (primary gate).
    // Writer also checks config internally (defense-in-depth).
    let writer: ShadowWriter | null = null;

    /**
     * Lazy-initialize and return the ShadowWriter instance.
     *
     * Created on first write tool call rather than at plugin load time because:
     * 1. The pool must be initialized (search.getSharedPool() creates it lazily)
     * 2. Avoids unnecessary object creation when writes are disabled
     *
     * @returns ShadowWriter instance (singleton per plugin lifecycle)
     * @throws Error if writes are not enabled (should never happen — tool gate prevents this)
     */
    function getWriter(): ShadowWriter {
      if (!writer) {
        writer = new ShadowWriter({
          pool: search.getSharedPool(),
          table: tableName,
          embedder,
          autoEmbed: writesCfg.autoEmbed,
          allowDelete: writesCfg.allowDelete,
          logger: api.logger,
        });
      }
      return writer;
    }

    api.logger.info(
      `memory-shadowdb: registered (table: ${tableName}, provider: ${embeddingCfg.provider}, model: ${embeddingCfg.model}, dims: ${embeddingCfg.dimensions}, startup: ${startupCfg.enabled ? startupCfg.mode : "disabled"}, writes: ${writesCfg.enabled ? "enabled" : "disabled"})`,
    );

    // ========================================================================
    // Startup Hydration Hook (identity/rules front-load)
    // ========================================================================

    if (startupCfg.enabled) {
      api.on("before_agent_start", async (_event, ctx) => {
        try {
          // Resolve model-aware maxChars (e.g., small-context models get less)
          const currentModel = (ctx as Record<string, unknown>)?.model as string | undefined;
          const effectiveMaxChars = resolveMaxCharsForModel(startupCfg, currentModel);

          // Fetch startup context from DB
          const startup = await search.getStartupContext(effectiveMaxChars);
          if (!startup?.text) {
            return;
          }

          // Check if we should inject based on mode + cache state
          const sessionKey = (ctx?.sessionKey || "__global__").trim();
          const now = Date.now();
          const prev = startupInjectState.get(sessionKey);

          let shouldInject = false;
          if (startupCfg.mode === "always") {
            // Always inject on every start (highest overhead, strictest parity)
            shouldInject = true;
          } else if (startupCfg.mode === "first-run") {
            // Inject only on first session start (lowest overhead)
            shouldInject = !prev;
          } else {
            // digest mode: inject when content changes or cache expires
            shouldInject =
              !prev ||
              prev.digest !== startup.digest ||
              (startupCfg.cacheTtlMs > 0 && now - prev.at >= startupCfg.cacheTtlMs);
          }

          if (!shouldInject) {
            return;
          }

          // Update cache state
          startupInjectState.set(sessionKey, { digest: startup.digest, at: now });

          // SECURITY: Bound cache map size to prevent memory exhaustion
          // If map exceeds 5000 entries, evict 1000 oldest entries
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

          // Return context for injection into agent prompt
          return {
            prependContext:
              `<startup-identity source="shadowdb" digest="${startup.digest}"${truncatedAttr}>\n` +
              `${startup.text}\n` +
              `</startup-identity>`,
          };
        } catch (err) {
          api.logger.warn(`memory-shadowdb startup hydration failed: ${String(err)}`);
          return;
        }
      });
    }

    // ========================================================================
    // Tool Registration: memory_search and memory_get
    // ========================================================================

    api.registerTool(
      (_ctx) => {
        // TOOL 1: memory_search
        // Hybrid semantic + FTS + trigram search over ShadowDB
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

              // Attach citations to snippets for easy reference
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

        // TOOL 2: memory_get
        // Read specific record by path (follow-up after memory_search)
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
    // Tool Registration: memory_write, memory_update, memory_delete
    // ========================================================================
    //
    // SECURITY: Write tools are only registered when writes.enabled is true.
    // When disabled, these tools simply don't exist — the agent cannot call them
    // and they don't appear in tool listings. This is the primary access gate.
    //
    // Defense-in-depth: ShadowWriter also checks config internally, so even if
    // tool registration were bypassed, writes would still be rejected.
    //

    if (writesCfg.enabled) {
      api.registerTool(
        (_ctx) => {
          // TOOL 3: memory_write — create new memory record
          const memoryWriteTool = {
            label: "Memory Write",
            name: "memory_write",
            description:
              "Create a new memory record in ShadowDB. Requires writes.enabled in plugin config. " +
              "Auto-embeds for vector search if writes.autoEmbed is true.",
            parameters: Type.Object({
              content: Type.String({ description: "Record content (required, max 100K chars)" }),
              category: Type.Optional(
                Type.String({ description: 'Category (default: "general")' }),
              ),
              title: Type.Optional(Type.String({ description: "Human-readable title" })),
              tags: Type.Optional(
                Type.Array(Type.String(), { description: "Searchable tags (max 50)" }),
              ),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              try {
                const w = getWriter();
                const result = await w.write({
                  content: params.content as string,
                  category: params.category as string | undefined,
                  title: params.title as string | undefined,
                  tags: params.tags as string[] | undefined,
                });
                return jsonResult(result as unknown as Record<string, unknown>);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                api.logger.warn(`memory-shadowdb write error: ${message}`);
                return jsonResult({ ok: false, error: message });
              }
            },
          };

          // TOOL 4: memory_update — update existing memory record
          const memoryUpdateTool = {
            label: "Memory Update",
            name: "memory_update",
            description:
              "Update an existing memory record in ShadowDB. Partial update: only modifies provided fields. " +
              "Re-embeds automatically if content changes.",
            parameters: Type.Object({
              id: Type.Number({ description: "Record ID to update" }),
              content: Type.Optional(
                Type.String({ description: "New content (triggers re-embedding)" }),
              ),
              title: Type.Optional(Type.String({ description: "New title" })),
              category: Type.Optional(Type.String({ description: "New category" })),
              tags: Type.Optional(
                Type.Array(Type.String(), { description: "New tags (replaces existing)" }),
              ),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              try {
                const w = getWriter();
                const result = await w.update({
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

          // TOOL 5: memory_delete — soft-delete or hard-delete a memory record
          const memoryDeleteTool = {
            label: "Memory Delete",
            name: "memory_delete",
            description:
              "Delete a memory record from ShadowDB. Default: soft-delete (sets contradicted=true, reversible). " +
              "Hard-delete (permanent) requires writes.allowDelete in config.",
            parameters: Type.Object({
              id: Type.Number({ description: "Record ID to delete" }),
              hard: Type.Optional(
                Type.Boolean({
                  description:
                    "Hard-delete (permanent). Default: false (soft-delete). Requires writes.allowDelete config.",
                }),
              ),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              try {
                const w = getWriter();
                const result = await w.delete({
                  id: params.id as number,
                  hard: params.hard as boolean | undefined,
                });
                return jsonResult(result as unknown as Record<string, unknown>);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                api.logger.warn(`memory-shadowdb delete error: ${message}`);
                return jsonResult({ ok: false, error: message });
              }
            },
          };

          return [memoryWriteTool, memoryUpdateTool, memoryDeleteTool];
        },
        { names: ["memory_write", "memory_update", "memory_delete"] },
      );
    }

    // ========================================================================
    // CLI Registration: shadowdb commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const cmd = program
          .command("shadowdb")
          .description("ShadowDB memory plugin commands");

        // shadowdb ping — test database connection
        cmd
          .command("ping")
          .description("Test PostgreSQL connection")
          .action(async () => {
            const ok = await search.ping();
            console.log(ok ? "✓ Connected" : "✗ Connection failed");
            process.exit(ok ? 0 : 1);
          });

        // shadowdb search <query> — CLI search interface
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

        // shadowdb get <id> — fetch specific record by ID
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
    // Service Registration (connection lifecycle)
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

/**
 * Format tool result as JSON content
 *
 * Wraps data object in OpenClaw tool result format:
 * { content: [{ type: "text", text: JSON.stringify(data) }] }
 *
 * @param data - Result data object
 * @returns Formatted tool result
 */
function jsonResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Test-only exports for internal functions
 *
 * Enables unit testing of config resolution without exposing internals
 * to plugin consumers.
 */
export const __test__ = {
  normalizeEmbeddingProvider,
  resolveEmbeddingConfig,
  resolveStartupInjectionConfig,
  validateEmbeddingDimensions,
  ShadowWriter,
};

export default memoryShadowdbPlugin;
