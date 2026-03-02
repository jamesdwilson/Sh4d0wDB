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
import { Type } from "@sinclair/typebox";
import { resolveConnectionString, resolveEmbeddingConfig, resolvePrimerConfig, resolveMaxCharsForModel, normalizeEmbeddingProvider, validateEmbeddingDimensions, computeEmbeddingFingerprint, } from "./config.js";
import { EmbeddingClient } from "./embedder.js";
// ============================================================================
// Backend factory — picks the right store based on config
// ============================================================================
/**
 * Create the appropriate MemoryStore backend based on config.
 *
 * Dynamically imports backend modules so unused backends don't add
 * to the dependency tree (e.g., SQLite users don't need pg).
 */
async function createStore(backend, connectionString, embedder, storeConfig, logger) {
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
            throw new Error(`memory-shadowdb: unknown backend "${backend}". Supported: postgres, sqlite, mysql`);
    }
}
// ============================================================================
// Plugin Definition
// ============================================================================
const memoryShadowdbPlugin = {
    id: "memory-shadowdb",
    name: "Memory (ShadowDB)",
    description: "Database-backed agent memory with hybrid semantic + full-text search. Supports PostgreSQL, SQLite, and MySQL.",
    kind: "memory",
    register(api) {
        const pluginCfg = (api.pluginConfig || {});
        // ========================================================================
        // Configuration Resolution
        // ========================================================================
        const backend = pluginCfg.backend || "postgres";
        const connectionString = resolveConnectionString(pluginCfg);
        const embeddingCfg = resolveEmbeddingConfig(pluginCfg);
        const tableName = pluginCfg.table || "memories";
        const maxResultsDefault = pluginCfg.search?.maxResults ?? 6;
        // RRF scores are much smaller than raw similarity scores.
        // With k=60 and weights summing to ~1.35, the theoretical max RRF score
        // for a rank-1 result across all signals is ~0.022. A threshold of 0.15
        // would filter out everything. Default 0.005 = "appeared in at least one
        // signal with reasonable rank."
        const minScoreDefault = pluginCfg.search?.minScore ?? 0.005;
        const vectorWeight = pluginCfg.search?.vectorWeight ?? 0.7;
        const textWeight = pluginCfg.search?.textWeight ?? 0.3;
        const recencyWeight = pluginCfg.search?.recencyWeight ?? 0.15;
        const primerCfg = resolvePrimerConfig(pluginCfg);
        const writesCfg = {
            enabled: pluginCfg.writes?.enabled === true,
            autoEmbed: pluginCfg.writes?.autoEmbed !== false,
            purgeAfterDays: typeof pluginCfg.writes?.retention?.purgeAfterDays === "number"
                ? Math.max(0, Math.floor(pluginCfg.writes.retention.purgeAfterDays))
                : 30,
        };
        const storeConfig = {
            table: tableName,
            vectorWeight,
            textWeight,
            recencyWeight,
            autoEmbed: writesCfg.autoEmbed,
            purgeAfterDays: writesCfg.purgeAfterDays,
        };
        // Primer injection cache (bounded at 5000 entries)
        const primerState = new Map();
        // Warn about missing API keys
        if (["openai", "openai-compatible", "voyage", "gemini"].includes(embeddingCfg.provider) &&
            !embeddingCfg.apiKey) {
            api.logger.warn(`memory-shadowdb: provider=${embeddingCfg.provider} selected but no API key found.`);
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
        let store = null;
        /**
         * Get or create the store instance.
         * Store is created lazily on first use and fully initialized in service.start().
         */
        async function getStore() {
            if (!store) {
                store = await createStore(backend, connectionString, embedder, storeConfig, api.logger);
            }
            return store;
        }
        api.logger.info(`memory-shadowdb: registered (backend: ${backend}, table: ${tableName}, provider: ${embeddingCfg.provider}, model: ${embeddingCfg.model}, dims: ${embeddingCfg.dimensions}, primer: ${primerCfg.enabled ? primerCfg.mode : "disabled"}, writes: ${writesCfg.enabled ? "enabled" : "disabled"})`);
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
                    const currentModel = ctx?.model ||
                        api.config?.agents?.defaults?.model?.primary;
                    const effectiveMaxChars = resolveMaxCharsForModel(primerCfg, currentModel);
                    const primer = await s.getPrimerContext(effectiveMaxChars);
                    if (!primer?.text)
                        return;
                    const sessionKey = (ctx?.sessionKey || "__global__").trim();
                    const now = Date.now();
                    // Detect session reset (/new): if message history is empty, evict cache
                    // so the primer is re-injected on the first turn of the new session.
                    // Without this, /new clears history but the primerState cache still has
                    // the session key, causing the hook to skip injection (mode=digest/first-run).
                    const eventMessages = _event?.messages;
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
                    }
                    else if (primerCfg.mode === "first-run") {
                        // Inject once per session, never refresh
                        shouldInject = !prev;
                    }
                    else {
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
                        for (const key of stale)
                            primerState.delete(key);
                    }
                    const injectedChars = primer.text.length;
                    api.logger.info(`memory-shadowdb: primer injected (${injectedChars} chars, ${primer.includedCount}/${primer.rowCount} sections, model=${currentModel || "default"}, maxChars=${effectiveMaxChars}, session=${sessionKey})`);
                    if (primer.truncated) {
                        api.logger.warn(`memory-shadowdb: primer budget exceeded — skipped ${primer.skippedKeys.length} section(s): [${primer.skippedKeys.join(", ")}]. Total DB content: ${primer.totalChars} chars, budget: ${effectiveMaxChars}. Model: ${currentModel || "default"}`);
                    }
                    return {
                        prependContext: `init:\n` +
                            `${primer.text}\n` +
                            `/init`,
                    };
                }
                catch (err) {
                    api.logger.warn(`memory-shadowdb primer hydration failed: ${String(err)}`);
                    return;
                }
            });
        }
        // ========================================================================
        // Tool Registration: memory_search and memory_get
        // ========================================================================
        api.registerTool((_ctx) => {
            const memorySearchTool = {
                label: "Memory Search",
                name: "memory_search",
                description: "Mandatory recall step: semantically search the ShadowDB knowledge base before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
                parameters: Type.Object({
                    query: Type.String(),
                    maxResults: Type.Optional(Type.Number()),
                    minScore: Type.Optional(Type.Number()),
                }),
                execute: async (_toolCallId, params) => {
                    const query = params.query?.trim();
                    if (!query)
                        return jsonResult({ results: [], error: "empty query" });
                    const max = params.maxResults ?? maxResultsDefault;
                    const min = params.minScore ?? minScoreDefault;
                    api.logger.info(`memory-shadowdb: tool memory_search called — query="${query.slice(0, 80)}", max=${max}, min=${min}`);
                    try {
                        const s = await getStore();
                        const results = await s.search(query, max, min);
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
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        api.logger.warn(`memory-shadowdb search error: ${message}`);
                        return jsonResult({ results: [], error: message });
                    }
                },
            };
            const memoryGetTool = {
                label: "Memory Get",
                name: "memory_get",
                description: "Read a specific ShadowDB record by path (shadowdb/{category}/{id}); use after memory_search to pull full content.",
                parameters: Type.Object({
                    path: Type.String(),
                    from: Type.Optional(Type.Number()),
                    lines: Type.Optional(Type.Number()),
                }),
                execute: async (_toolCallId, params) => {
                    const reqPath = params.path?.trim();
                    if (!reqPath)
                        return jsonResult({ path: "", text: "", error: "path required" });
                    try {
                        const s = await getStore();
                        const result = await s.getByPath(reqPath, params.from, params.lines);
                        return jsonResult(result);
                    }
                    catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        return jsonResult({ path: reqPath, text: "", error: message });
                    }
                },
            };
            return [memorySearchTool, memoryGetTool];
        }, { names: ["memory_search", "memory_get"] });
        // ========================================================================
        // Tool Registration: Write tools (config-gated)
        // ========================================================================
        if (writesCfg.enabled) {
            api.registerTool((_ctx) => {
                const memoryWriteTool = {
                    label: "Memory Write",
                    name: "memory_write",
                    description: "Create a new memory record in ShadowDB. Requires writes.enabled in plugin config. " +
                        "Auto-embeds for vector search if writes.autoEmbed is true.",
                    parameters: Type.Object({
                        content: Type.String({ description: "Record content (required, max 100K chars)" }),
                        category: Type.Optional(Type.String({ description: 'Category (default: "general")' })),
                        title: Type.Optional(Type.String({ description: "Human-readable title" })),
                        tags: Type.Optional(Type.Array(Type.String(), { description: "Searchable tags (max 50)" })),
                    }),
                    execute: async (_toolCallId, params) => {
                        try {
                            const s = await getStore();
                            const result = await s.write({
                                content: params.content,
                                category: params.category,
                                title: params.title,
                                tags: params.tags,
                            });
                            return jsonResult(result);
                        }
                        catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            api.logger.warn(`memory-shadowdb write error: ${message}`);
                            return jsonResult({ ok: false, error: message });
                        }
                    },
                };
                const memoryUpdateTool = {
                    label: "Memory Update",
                    name: "memory_update",
                    description: "Update an existing memory record in ShadowDB. Partial update: only modifies provided fields. " +
                        "Re-embeds automatically if content changes.",
                    parameters: Type.Object({
                        id: Type.Number({ description: "Record ID to update" }),
                        content: Type.Optional(Type.String({ description: "New content (triggers re-embedding)" })),
                        title: Type.Optional(Type.String({ description: "New title" })),
                        category: Type.Optional(Type.String({ description: "New category" })),
                        tags: Type.Optional(Type.Array(Type.String(), { description: "New tags (replaces existing)" })),
                    }),
                    execute: async (_toolCallId, params) => {
                        try {
                            const s = await getStore();
                            const result = await s.update({
                                id: params.id,
                                content: params.content,
                                title: params.title,
                                category: params.category,
                                tags: params.tags,
                            });
                            return jsonResult(result);
                        }
                        catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            api.logger.warn(`memory-shadowdb update error: ${message}`);
                            return jsonResult({ ok: false, error: message });
                        }
                    },
                };
                const memoryDeleteTool = {
                    label: "Memory Delete",
                    name: "memory_delete",
                    description: "Soft-delete a memory record from ShadowDB (sets deleted_at, excluded from search). " +
                        "Reversible via memory_undelete. Permanent removal happens only via retention policy.",
                    parameters: Type.Object({
                        id: Type.Number({ description: "Record ID to soft-delete" }),
                    }),
                    execute: async (_toolCallId, params) => {
                        try {
                            const s = await getStore();
                            const result = await s.delete({ id: params.id });
                            return jsonResult(result);
                        }
                        catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            api.logger.warn(`memory-shadowdb delete error: ${message}`);
                            return jsonResult({ ok: false, error: message });
                        }
                    },
                };
                const memoryUndeleteTool = {
                    label: "Memory Undelete",
                    name: "memory_undelete",
                    description: "Restore a soft-deleted memory record (clears deleted_at). " +
                        "Only works if the record hasn't been permanently purged by retention policy.",
                    parameters: Type.Object({
                        id: Type.Number({ description: "Record ID to restore" }),
                    }),
                    execute: async (_toolCallId, params) => {
                        try {
                            const s = await getStore();
                            const result = await s.undelete({ id: params.id });
                            return jsonResult(result);
                        }
                        catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            api.logger.warn(`memory-shadowdb undelete error: ${message}`);
                            return jsonResult({ ok: false, error: message });
                        }
                    },
                };
                return [memoryWriteTool, memoryUpdateTool, memoryDeleteTool, memoryUndeleteTool];
            }, { names: ["memory_write", "memory_update", "memory_delete", "memory_undelete"] });
            // memory_list — filter/browse records by metadata
            api.registerTool(() => {
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
                        sort: Type.Optional(Type.Union([Type.Literal("created_at"), Type.Literal("updated_at"), Type.Literal("priority"), Type.Literal("title")], { description: "Sort column (default: created_at)" })),
                        sort_order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "Sort direction (default: desc)" })),
                        limit: Type.Optional(Type.Number({ description: "Max results (default 50, max 200)" })),
                        offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
                    }),
                    execute: async (_toolCallId, params) => {
                        try {
                            const store = await getStore();
                            const results = await store.list({
                                category: params.category,
                                tags: params.tags,
                                tags_include: params.tags_include,
                                tags_any: params.tags_any,
                                record_type: params.record_type,
                                parent_id: params.parent_id,
                                priority_min: params.priority_min,
                                priority_max: params.priority_max,
                                created_after: params.created_after,
                                created_before: params.created_before,
                                metadata: params.metadata,
                                detail_level: params.detail_level,
                                sort: params.sort,
                                sort_order: params.sort_order,
                                limit: params.limit,
                                offset: params.offset,
                            });
                            return jsonResult({ count: results.length, results });
                        }
                        catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            api.logger.warn(`memory-shadowdb memory_list error: ${message}`);
                            return jsonResult({ ok: false, error: message });
                        }
                    },
                };
                return [memoryListTool];
            }, { names: ["memory_list"] });
        }
        // ========================================================================
        // CLI Registration
        // ========================================================================
        api.registerCli(({ program }) => {
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
                .action(async (query, opts) => {
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
                .action(async (id) => {
                const s = await getStore();
                const record = await s.get(parseInt(id, 10));
                if (record) {
                    console.log(record.text);
                }
                else {
                    console.log(`Record ${id} not found`);
                }
            });
        }, { commands: ["shadowdb"] });
        // ========================================================================
        // Service Registration
        // ========================================================================
        api.registerService({
            id: "memory-shadowdb",
            start: async () => {
                const s = await getStore();
                // Initialize backend (create tables for SQLite/MySQL, no-op for Postgres)
                await s.initialize();
                const ok = await s.ping();
                if (ok) {
                    api.logger.info(`memory-shadowdb: ${backend} connection verified`);
                    // Run retention purge on start
                    if (writesCfg.enabled && writesCfg.purgeAfterDays > 0) {
                        try {
                            await s.runRetentionPurge();
                        }
                        catch (err) {
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
                                    api.logger.info(`memory-shadowdb: re-embed complete — ${result.success} success, ${result.errors} errors, ${elapsed}s`);
                                    await s.setMetaValue("embedding_fingerprint", fingerprint);
                                }
                                catch (err) {
                                    api.logger.warn(`memory-shadowdb: background re-embed failed: ${String(err)}`);
                                }
                            })();
                        }
                        else {
                            api.logger.info(`memory-shadowdb: embedding fingerprint matches (${fingerprint}) — no re-embed needed`);
                        }
                    }
                    catch (err) {
                        api.logger.warn(`memory-shadowdb: fingerprint check failed: ${String(err)}`);
                    }
                }
                else {
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
function jsonResult(data) {
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
};
export default memoryShadowdbPlugin;
//# sourceMappingURL=index.js.map