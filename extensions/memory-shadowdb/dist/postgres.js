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
/**
 * Build additional WHERE conditions from SearchFilters.
 * Returns { clauses: string[], values: unknown[], nextIdx: number }.
 * All user values are parameterized — no SQL injection risk.
 */
function buildFilterClauses(filters, startIdx) {
    if (!filters)
        return { clauses: [], values: [], nextIdx: startIdx };
    const clauses = [];
    const values = [];
    let idx = startIdx;
    if (filters.category) {
        clauses.push(`category = $${idx++}`);
        values.push(filters.category);
    }
    if (filters.record_type) {
        clauses.push(`record_type = $${idx++}`);
        values.push(filters.record_type);
    }
    if (filters.tags_include && filters.tags_include.length > 0) {
        clauses.push(`tags @> $${idx++}::text[]`);
        values.push(filters.tags_include);
    }
    if (filters.tags_any && filters.tags_any.length > 0) {
        clauses.push(`tags && $${idx++}::text[]`);
        values.push(filters.tags_any);
    }
    if (filters.priority_min !== undefined) {
        clauses.push(`priority >= $${idx++}`);
        values.push(filters.priority_min);
    }
    if (filters.priority_max !== undefined) {
        clauses.push(`priority <= $${idx++}`);
        values.push(filters.priority_max);
    }
    if (filters.created_after) {
        clauses.push(`created_at >= $${idx++}`);
        values.push(filters.created_after);
    }
    if (filters.created_before) {
        clauses.push(`created_at <= $${idx++}`);
        values.push(filters.created_before);
    }
    if (filters.parent_id !== undefined) {
        clauses.push(`parent_id = $${idx++}`);
        values.push(filters.parent_id);
    }
    return { clauses, values, nextIdx: idx };
}
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
      VALUES ($1, $2, $3, $4, 'fact', $5::jsonb, $6, $7)
      RETURNING id
    `;
        const result = await this.getPool().query(sql, [
            params.content, params.category, params.title, params.tags,
            JSON.stringify(params.metadata), params.parent_id, params.priority,
        ]);
        return result.rows[0].id;
    }
    async list(params) {
        const conditions = ["deleted_at IS NULL"];
        const values = [];
        let idx = 1;
        if (params.category) {
            conditions.push(`category = $${idx++}`);
            values.push(params.category);
        }
        if (params.record_type) {
            conditions.push(`record_type = $${idx++}`);
            values.push(params.record_type);
        }
        if (params.parent_id !== undefined) {
            conditions.push(`parent_id = $${idx++}`);
            values.push(params.parent_id);
        }
        if (params.priority_min !== undefined) {
            conditions.push(`priority >= $${idx++}`);
            values.push(params.priority_min);
        }
        if (params.priority_max !== undefined) {
            conditions.push(`priority <= $${idx++}`);
            values.push(params.priority_max);
        }
        if (params.created_after) {
            conditions.push(`created_at >= $${idx++}`);
            values.push(params.created_after);
        }
        if (params.created_before) {
            conditions.push(`created_at <= $${idx++}`);
            values.push(params.created_before);
        }
        if (params.tags && params.tags.length > 0) {
            conditions.push(`tags @> $${idx++}::text[]`);
            values.push(params.tags);
        }
        if (params.tags_include && params.tags_include.length > 0) {
            conditions.push(`tags @> $${idx++}::text[]`);
            values.push(params.tags_include);
        }
        if (params.tags_any && params.tags_any.length > 0) {
            conditions.push(`tags && $${idx++}::text[]`);
            values.push(params.tags_any);
        }
        if (params.metadata && Object.keys(params.metadata).length > 0) {
            conditions.push(`metadata @> $${idx++}::jsonb`);
            values.push(JSON.stringify(params.metadata));
        }
        const where = conditions.join(" AND ");
        const lim = Math.min(params.limit ?? 50, 200);
        const off = params.offset ?? 0;
        const contentCol = params.detail_level === "full" || params.detail_level === "snippet"
            ? ", content" : "";
        // Sort — validate column name to prevent SQL injection
        const allowedSorts = ["created_at", "updated_at", "priority", "title"];
        const sortDir = params.sort_order === "asc" ? "ASC" : "DESC";
        let orderClause;
        if (params.sort && params.sort.startsWith("metadata.")) {
            // Metadata field sort: metadata.fieldName
            // Sanitize: only allow alphanumeric + underscore in field names
            const fieldName = params.sort.slice("metadata.".length);
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fieldName)) {
                throw new Error(`Invalid metadata sort field: ${fieldName}`);
            }
            // Try numeric cast; fall back to text sort on cast failure
            // Use a CASE expression: if the value parses as numeric, sort numerically; otherwise sort as text
            orderClause = `ORDER BY
        CASE WHEN metadata->>'${fieldName}' ~ '^-?[0-9]+(\\.[0-9]+)?$'
             THEN (metadata->>'${fieldName}')::numeric ELSE NULL END ${sortDir} NULLS LAST,
        metadata->>'${fieldName}' ${sortDir} NULLS LAST`;
        }
        else {
            const sortCol = allowedSorts.includes(params.sort) ? params.sort : "created_at";
            orderClause = `ORDER BY ${sortCol} ${sortDir}`;
        }
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
}
//# sourceMappingURL=postgres.js.map