/**
 * postgres.ts — PostgreSQL backend for MemoryStore
 *
 * Implements all abstract methods from MemoryStore using:
 * - pgvector for vector similarity search (cosine distance)
 * - tsvector + tsquery for full-text search with BM25-style ranking
 * - pg_trgm for fuzzy/typo-tolerant matching
 * - Standard SQL for CRUD, soft-delete, and retention purge
 *
 * SECURITY:
 * - All queries use parameterized SQL ($1, $2, ...) — no user input interpolation
 * - Table name interpolation is safe: comes from plugin config only (not user input)
 * - Connection pool capped at 3 to prevent resource exhaustion
 * - Connection string may contain credentials — never logged
 */
import pg from "pg";
import { MemoryStore } from "./store.js";
import { buildFilterClauses } from "./filters.js";
import { buildListConditions, buildSortClause } from "./list-filters.js";
import { buildEdgeQuery, extractConnectedEntity, normalizeEntitySlug } from "./graph-queries.js";
/**
 * PostgreSQL-backed memory store.
 *
 * The richest backend: full vector search, FTS, trigram fuzzy matching.
 * Requires pgvector and pg_trgm extensions.
 */
export class PostgresStore extends MemoryStore {
    pool = null;
    connectionString;
    constructor(params) {
        super(params.embedder, params.config, params.logger);
        this.connectionString = params.connectionString;
    }
    // ==========================================================================
    // Connection pool — lazy init, capped at 3
    // ==========================================================================
    getPool() {
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
     * Expose pool for legacy compatibility (index.ts shared pool pattern).
     * TODO: Remove once index.ts is fully migrated to use MemoryStore directly.
     */
    getSharedPool() {
        return this.getPool();
    }
    // ==========================================================================
    // Health check — validate connections during idle periods
    // ==========================================================================
    /**
     * Periodic health check to validate the connection pool is responsive.
     * Call `SELECT 1` to catch stale connections before they cause write failures.
     */
    async healthCheck() {
        try {
            await this.getPool().query('SELECT 1');
            this.logger.info('memory-shadowdb: health check: OK');
            return true;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`memory-shadowdb: health check FAILED - ${message}`);
            return false;
        }
    }
    /**
     * Start periodic health checks (every 5 minutes).
     * Helps catch stale connections during idle periods.
     */
    startHealthChecks() {
        setInterval(() => {
            this.healthCheck().catch(err => {
                this.logger.warn(`memory-shadowdb: health check error: ${err}`);
            });
        }, 300_000); // 5 minutes
    }
    // ==========================================================================
    // Search legs
    // ==========================================================================
    async vectorSearch(query, embedding, limit, filters) {
        const vecLiteral = `[${embedding.join(",")}]`;
        const baseConds = ["embedding IS NOT NULL", "deleted_at IS NULL"];
        const { clauses, values, nextIdx } = buildFilterClauses(filters, 3);
        const allConds = [...baseConds, ...clauses].join(" AND ");
        const sql = `
      SELECT id, content, category, title, record_type, created_at,
             1 - (embedding <=> $1::vector) AS score,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM ${this.config.table}
      WHERE ${allConds}
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `;
        const result = await this.getPool().query(sql, [vecLiteral, limit, ...values]);
        const minVec = this.config.minVectorScore || 0;
        const rows = result.rows.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            title: r.title,
            record_type: r.record_type,
            created_at: r.created_at,
            rank: parseInt(r.rank, 10),
            rawScore: parseFloat(r.score),
        }));
        // Filter out vector hits below minVectorScore (cosine similarity threshold)
        if (minVec > 0) {
            const filtered = rows.filter((r) => (r.rawScore ?? 0) >= minVec);
            // Re-rank after filtering to maintain contiguous 1-based ranks
            filtered.forEach((r, i) => { r.rank = i + 1; });
            return filtered;
        }
        return rows;
    }
    async textSearch(query, limit, filters) {
        const baseConds = ["fts IS NOT NULL", "fts @@ plainto_tsquery('english', $1)", "deleted_at IS NULL"];
        const { clauses, values, nextIdx } = buildFilterClauses(filters, 3);
        const allConds = [...baseConds, ...clauses].join(" AND ");
        const sql = `
      SELECT id, content, category, title, record_type, created_at,
             ts_rank_cd(fts, plainto_tsquery('english', $1)) AS score,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts, plainto_tsquery('english', $1)) DESC) AS rank
      FROM ${this.config.table}
      WHERE ${allConds}
      ORDER BY score DESC
      LIMIT $2
    `;
        const result = await this.getPool().query(sql, [query, limit, ...values]);
        return result.rows.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            title: r.title,
            record_type: r.record_type,
            created_at: r.created_at,
            rank: parseInt(r.rank, 10),
            rawScore: parseFloat(r.score),
        }));
    }
    async fuzzySearch(query, limit, filters) {
        const baseConds = ["(content % $1 OR content ILIKE '%' || $1 || '%')", "deleted_at IS NULL"];
        const { clauses, values, nextIdx } = buildFilterClauses(filters, 3);
        const allConds = [...baseConds, ...clauses].join(" AND ");
        const sql = `
      SELECT id, content, category, title, record_type, created_at,
             similarity(content, $1) AS score,
             ROW_NUMBER() OVER (ORDER BY content <-> $1) AS rank
      FROM ${this.config.table}
      WHERE ${allConds}
      ORDER BY content <-> $1
      LIMIT $2
    `;
        const result = await this.getPool().query(sql, [query, limit, ...values]);
        return result.rows.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            title: r.title,
            record_type: r.record_type,
            created_at: r.created_at,
            rank: parseInt(r.rank, 10),
            rawScore: parseFloat(r.score),
        }));
    }
    // ==========================================================================
    // Read operations
    // ==========================================================================
    async get(id, opts) {
        const sql = `SELECT id, content, category, title, record_type FROM ${this.config.table} WHERE id = $1 AND deleted_at IS NULL`;
        const result = await this.getPool().query(sql, [id]);
        if (result.rows.length === 0)
            return null;
        const row = result.rows[0];
        let text = this.formatFullRecord(row);
        const path = `shadowdb/${row.category || "general"}/${row.id}`;
        // section: return only the child whose metadata->>'section_name' matches
        if (opts?.section) {
            const sectionSql = `
        SELECT id, content, category, title, record_type
        FROM ${this.config.table}
        WHERE parent_id = $1 AND deleted_at IS NULL AND metadata->>'section_name' = $2
        LIMIT 1
      `;
            const sectionResult = await this.getPool().query(sectionSql, [id, opts.section]);
            if (sectionResult.rows.length > 0) {
                text = this.formatFullRecord(sectionResult.rows[0]);
            }
            else {
                text += `\n\n[section "${opts.section}" not found]`;
            }
            return { text, path };
        }
        // include_children: append all child records
        if (opts?.include_children) {
            const childSql = `
        SELECT id, content, category, title, record_type
        FROM ${this.config.table}
        WHERE parent_id = $1 AND deleted_at IS NULL
        ORDER BY priority ASC, id ASC
      `;
            const childResult = await this.getPool().query(childSql, [id]);
            if (childResult.rows.length > 0) {
                text += "\n\n---\n## Children\n";
                for (const child of childResult.rows) {
                    text += `\n### [${child.id}] ${child.title || child.record_type || "child"}\n${child.content}\n`;
                }
            }
        }
        return { text, path };
    }
    async getByPath(pathQuery, from, lines, opts) {
        const parts = pathQuery.replace(/^shadowdb\//, "").split("/");
        // Specific record by ID
        if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
            const id = parseInt(parts[parts.length - 1], 10);
            const record = await this.get(id, opts);
            if (!record)
                return { text: `Record ${id} not found`, path: pathQuery };
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
            ? `SELECT id, left(content, 200) as content, category, title FROM ${this.config.table} WHERE category = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`
            : `SELECT id, left(content, 200) as content, category, title FROM ${this.config.table} WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`;
        const result = await this.getPool().query(sql, category ? [category] : []);
        const text = result.rows
            .map((r) => `[${r.id}] ${r.title || r.category || "—"}: ${(r.content || "").slice(0, 120)}`)
            .join("\n");
        return { text: text || "No records found", path: pathQuery };
    }
    async getPrimerRows() {
        // Try queries with decreasing schema assumptions (graceful degradation)
        const queries = [
            `SELECT key, content FROM primer WHERE (enabled IS NULL OR enabled IS TRUE) ORDER BY priority ASC NULLS LAST, key ASC`,
            `SELECT key, content FROM primer ORDER BY priority ASC NULLS LAST, key ASC`,
            `SELECT key, content FROM primer ORDER BY key ASC`,
        ];
        for (const sql of queries) {
            try {
                const result = await this.getPool().query(sql);
                return result.rows;
            }
            catch (err) {
                const code = err.code;
                if (code === "42P01")
                    return []; // table doesn't exist
                continue;
            }
        }
        return [];
    }
    // ==========================================================================
    // Write operations
    // ==========================================================================
    async insertRecord(params) {
        const sql = `
      INSERT INTO ${this.config.table} (content, category, title, tags, record_type, metadata, parent_id, priority)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      RETURNING id
    `;
        const result = await this.getPool().query(sql, [
            params.content, params.category, params.title, params.tags, params.record_type,
            JSON.stringify(params.metadata), params.parent_id, params.priority,
        ]);
        return result.rows[0].id;
    }
    async list(params) {
        const { conditions, values, nextIdx } = buildListConditions(params);
        let idx = nextIdx;
        const where = conditions.join(" AND ");
        const lim = Math.min(params.limit ?? 50, 200);
        const off = params.offset ?? 0;
        const contentCol = params.detail_level === "full" || params.detail_level === "snippet"
            ? ", content" : "";
        const orderClause = buildSortClause(params.sort, params.sort_order);
        const sql = `
      SELECT id, category, title, record_type, priority, parent_id,
             COALESCE(metadata, '{}') as metadata, created_at, COALESCE(tags, '{}') as tags${contentCol}
      FROM ${this.config.table}
      WHERE ${where}
      ${orderClause}
      LIMIT $${idx++} OFFSET $${idx++}
    `;
        values.push(lim, off);
        const result = await this.getPool().query(sql, values);
        return result.rows.map((row) => ({
            id: row.id,
            path: `shadowdb/${row.category || "general"}/${row.id}`,
            category: row.category,
            title: row.title,
            record_type: row.record_type,
            priority: row.priority,
            parent_id: row.parent_id,
            metadata: row.metadata,
            created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
            tags: row.tags,
            ...(contentCol ? { content: row.content } : {}),
        }));
    }
    async updateRecord(id, patch) {
        const setClauses = [];
        const values = [];
        let paramIdx = 1;
        for (const [key, value] of Object.entries(patch)) {
            setClauses.push(`${key} = $${paramIdx++}`);
            values.push(value);
        }
        setClauses.push(`updated_at = NOW()`);
        values.push(id);
        const sql = `UPDATE ${this.config.table} SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`;
        await this.getPool().query(sql, values);
    }
    async softDeleteRecord(id) {
        await this.getPool().query(`UPDATE ${this.config.table} SET deleted_at = NOW() WHERE id = $1`, [id]);
    }
    async restoreRecord(id) {
        await this.getPool().query(`UPDATE ${this.config.table} SET deleted_at = NULL WHERE id = $1`, [id]);
    }
    async fetchExpiredRecords(days) {
        const result = await this.getPool().query(`SELECT id, content, category, title, deleted_at FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '${days} days'`);
        return result.rows;
    }
    async purgeExpiredRecords(days) {
        const result = await this.getPool().query(`DELETE FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '${days} days' RETURNING id`);
        return result.rowCount ?? 0;
    }
    async storeEmbedding(id, embedding) {
        const vecLiteral = `[${embedding.join(",")}]`;
        await this.getPool().query(`UPDATE ${this.config.table} SET embedding = $1::vector WHERE id = $2`, [vecLiteral, id]);
    }
    async getRecordMeta(id) {
        const result = await this.getPool().query(`SELECT id, content, category, deleted_at FROM ${this.config.table} WHERE id = $1`, [id]);
        return result.rows[0] || null;
    }
    // ==========================================================================
    // Lifecycle
    // ==========================================================================
    async ping() {
        try {
            await this.getPool().query("SELECT 1");
            return true;
        }
        catch {
            return false;
        }
    }
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
    async initialize() {
        // Create meta table for embedding fingerprint tracking
        await this.getPool().query(`
      CREATE TABLE IF NOT EXISTS ${this.config.table}_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    }
    async getMetaValue(key) {
        try {
            const result = await this.getPool().query(`SELECT value FROM ${this.config.table}_meta WHERE key = $1`, [key]);
            return result.rows[0]?.value ?? null;
        }
        catch (err) {
            // Table might not exist yet
            const code = err.code;
            if (code === "42P01")
                return null; // undefined_table
            throw err;
        }
    }
    async setMetaValue(key, value) {
        await this.getPool().query(`
      INSERT INTO ${this.config.table}_meta (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, value]);
    }
    async getRecordBatch(afterId, limit) {
        const result = await this.getPool().query(`SELECT id, content FROM ${this.config.table} WHERE deleted_at IS NULL AND id > $1 ORDER BY id ASC LIMIT $2`, [afterId, limit]);
        return result.rows;
    }
    /**
     * Traverse the entity graph from a starting slug.
     *
     * Returns all edges touching the entity (1-hop), and optionally recurses
     * to N hops. Each hop collects the connected entity slugs, then fetches
     * their edges in turn. Visited set prevents infinite loops.
     *
     * @param entitySlug     - Starting entity slug (e.g. "james-wilson")
     * @param hops           - Number of hops to traverse (default 1, max 3)
     * @param min_confidence - Minimum edge confidence to include (0-100)
     * @param relationship_type - Optional filter to specific relationship type
     * @returns edges[], connected entity slugs[], and raw edge records
     */
    async graph(params) {
        const startSlug = normalizeEntitySlug(params.entity);
        const hops = Math.min(params.hops ?? 1, 3);
        const opts = {
            min_confidence: params.min_confidence,
            relationship_type: params.relationship_type,
            table: this.config.table,
        };
        const visited = new Set([startSlug]);
        const allEdges = [];
        const hopResults = [];
        let currentSlugs = [startSlug];
        for (let hop = 0; hop < hops; hop++) {
            const nextSlugs = [];
            for (const slug of currentSlugs) {
                const { sql, values } = buildEdgeQuery(slug, opts);
                const result = await this.getPool().query(sql, values);
                const edges = result.rows.map((row) => ({
                    id: row.id,
                    content: row.content,
                    tags: row.tags,
                    metadata: row.metadata,
                }));
                hopResults.push({ entity: slug, edges });
                for (const edge of edges) {
                    if (!allEdges.find(e => e.id === edge.id)) {
                        allEdges.push(edge);
                    }
                    const connected = extractConnectedEntity(edge, slug);
                    if (connected && !visited.has(connected)) {
                        visited.add(connected);
                        nextSlugs.push(connected);
                    }
                }
            }
            currentSlugs = nextSlugs;
            if (currentSlugs.length === 0)
                break;
        }
        const connected = [...visited].filter(s => s !== startSlug);
        return { entity: startSlug, edges: allEdges, connected, hopResults };
    }
    /**
     * Query all graph edges (for conflict detection, decay preview).
     * Public method for tool handlers.
     */
    async queryAllGraphEdges(opts) {
        const conditions = ["category = 'graph'", "record_type = 'atom'"];
        const params = [];
        let paramIdx = 1;
        if (opts?.domain) {
            conditions.push(`$${paramIdx} = ANY(tags)`);
            params.push(`domain:${opts.domain}`);
            paramIdx++;
        }
        if (opts?.min_confidence !== undefined) {
            conditions.push(`(metadata->>'confidence')::int >= $${paramIdx}`);
            params.push(opts.min_confidence);
            paramIdx++;
        }
        const result = await this.getPool().query(`SELECT id, content, tags, metadata, created_at, updated_at
       FROM memories
       WHERE ${conditions.join(" AND ")}
       ORDER BY id`, params);
        return result.rows.map((row) => ({
            id: row.id,
            content: row.content,
            tags: row.tags,
            metadata: row.metadata,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }));
    }
}
//# sourceMappingURL=postgres.js.map