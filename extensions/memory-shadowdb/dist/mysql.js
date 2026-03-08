/**
 * mysql.ts — MySQL backend for MemoryStore
 *
 * Implements all abstract methods from MemoryStore using:
 * - Native VECTOR type for similarity search (MySQL 9.2+)
 * - FULLTEXT indexes with MATCH AGAINST for text search
 * - FULLTEXT ngram parser for substring/fuzzy search (built-in since MySQL 5.7)
 * - Standard SQL for CRUD, soft-delete, and retention purge
 *
 * Dependencies:
 * - mysql2: MySQL driver with prepared statement support
 *
 * REQUIREMENTS:
 * - MySQL 5.7+ for ngram parser, MySQL 9.2.1+ for native VECTOR type
 * - Server variable ngram_token_size=3 recommended (default is 2)
 * - FULLTEXT index on (title, content) for text search
 * - FULLTEXT index WITH PARSER ngram on (title, content) for fuzzy search
 *
 * SECURITY:
 * - All queries use parameterized SQL (? placeholders)
 * - Table name comes from config only (not user input)
 * - Connection pool capped at 3 to prevent resource exhaustion
 * - Connection string may contain credentials — never logged
 *
 * DESIGN NOTES:
 * - Tags stored as JSON array (MySQL JSON type)
 * - VECTOR type stores embeddings natively (no extension needed in 9.2+)
 * - LAST_INSERT_ID() instead of RETURNING (MySQL doesn't support RETURNING)
 * - deleted_at uses DATETIME type (MySQL's TIMESTAMP has 2038 limitation)
 */
import { MemoryStore } from "./store.js";
/**
 * MySQL-backed memory store.
 *
 * Requires MySQL 9.2+ for native VECTOR support.
 * FULLTEXT search built-in. ngram parser provides substring/fuzzy matching.
 */
export class MySQLStore extends MemoryStore {
    pool = null;
    connectionString;
    hasVector = false;
    constructor(params) {
        super(params.embedder, params.config, params.logger);
        this.connectionString = params.connectionString;
    }
    // ==========================================================================
    // Connection pool
    // ==========================================================================
    async getPool() {
        if (!this.pool) {
            const mysql = await import("mysql2/promise");
            this.pool = mysql.createPool({
                uri: this.connectionString,
                connectionLimit: 3,
                waitForConnections: true,
                connectTimeout: 5_000,
            });
        }
        return this.pool;
    }
    /** Execute a query and return rows. */
    async query(sql, params = []) {
        const pool = await this.getPool();
        const [rows] = await pool.execute(sql, params);
        return rows;
    }
    /** Execute a statement (INSERT/UPDATE/DELETE) and return result metadata. */
    async exec(sql, params = []) {
        const pool = await this.getPool();
        const [result] = await pool.execute(sql, params);
        return result;
    }
    // ==========================================================================
    // Initialization
    // ==========================================================================
    async initialize() {
        // Create memories table
        await this.exec(`
      CREATE TABLE IF NOT EXISTS ${this.config.table} (
        id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        content     TEXT NOT NULL,
        title       VARCHAR(500),
        category    VARCHAR(100) DEFAULT 'general',
        record_type VARCHAR(50) DEFAULT 'fact',
        tags        JSON DEFAULT ('[]'),
        embedding   VECTOR(${this.embedder.getDimensions?.() ?? 768}),
        created_at  DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
        updated_at  DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        deleted_at  DATETIME(3) NULL,
        FULLTEXT INDEX idx_ft_content (title, content),
        FULLTEXT INDEX idx_ft_ngram (title, content) WITH PARSER ngram,
        INDEX idx_category (category),
        INDEX idx_deleted (deleted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
        // Check if VECTOR type is available (MySQL 9.2+)
        try {
            await this.query(`SELECT VECTOR_DIM(embedding) FROM ${this.config.table} LIMIT 0`);
            this.hasVector = true;
            this.logger.info("memory-shadowdb: MySQL VECTOR type available");
        }
        catch {
            this.logger.warn("memory-shadowdb: MySQL VECTOR type not available — vector search disabled. Requires MySQL 9.2+");
        }
        // Primer table
        await this.exec(`
      CREATE TABLE IF NOT EXISTS primer (
        \`key\`      VARCHAR(255) PRIMARY KEY,
        content    TEXT NOT NULL,
        priority   INT DEFAULT 50,
        \`always\`   TINYINT(1) DEFAULT 0,
        enabled    TINYINT(1) DEFAULT 1,
        updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
        // Meta table for embedding fingerprint tracking
        await this.exec(`
      CREATE TABLE IF NOT EXISTS ${this.config.table}_meta (
        \`key\`      VARCHAR(255) PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    }
    // ==========================================================================
    // Search legs
    // ==========================================================================
    async vectorSearch(query, embedding, limit) {
        if (!this.hasVector)
            return [];
        // MySQL 9.2+ vector search using cosine distance
        const vecString = `[${embedding.join(",")}]`;
        const sql = `
      SELECT id, content, category, title, record_type, created_at,
             1 - DISTANCE(embedding, STRING_TO_VECTOR(?), 'COSINE') AS score
      FROM ${this.config.table}
      WHERE embedding IS NOT NULL AND deleted_at IS NULL
      ORDER BY DISTANCE(embedding, STRING_TO_VECTOR(?), 'COSINE') ASC
      LIMIT ?
    `;
        const rows = await this.query(sql, [vecString, vecString, limit]);
        return rows.map((r, idx) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            title: r.title,
            record_type: r.record_type,
            created_at: r.created_at,
            rank: idx + 1,
            rawScore: parseFloat(r.score),
        }));
    }
    async textSearch(query, limit) {
        // MySQL FULLTEXT with MATCH AGAINST in natural language mode
        const sql = `
      SELECT id, content, category, title, record_type, created_at,
             MATCH(title, content) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
      FROM ${this.config.table}
      WHERE MATCH(title, content) AGAINST(? IN NATURAL LANGUAGE MODE)
        AND deleted_at IS NULL
      ORDER BY score DESC
      LIMIT ?
    `;
        const rows = await this.query(sql, [query, query, limit]);
        return rows.map((r, idx) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            title: r.title,
            record_type: r.record_type,
            created_at: r.created_at,
            rank: idx + 1,
            rawScore: parseFloat(r.score),
        }));
    }
    async fuzzySearch(query, limit) {
        // MySQL ngram parser — FULLTEXT index WITH PARSER ngram enables substring matching.
        // Uses BOOLEAN MODE so short substrings work (natural language mode has length limits).
        // FORCE INDEX ensures MySQL uses the ngram index, not the default FULLTEXT index.
        // The ngram index tokenizes text into n-character sequences (default ngram_token_size=2,
        // recommended: SET GLOBAL ngram_token_size=3 for trigram behavior).
        if (query.length < 2)
            return [];
        const sql = `
      SELECT id, content, category, title, record_type, created_at,
             MATCH(title, content) AGAINST(? IN BOOLEAN MODE) AS score
      FROM ${this.config.table} FORCE INDEX(idx_ft_ngram)
      WHERE MATCH(title, content) AGAINST(? IN BOOLEAN MODE)
        AND deleted_at IS NULL
      ORDER BY score DESC
      LIMIT ?
    `;
        try {
            const rows = await this.query(sql, [query, query, limit]);
            return rows.map((r, idx) => ({
                id: r.id,
                content: r.content,
                category: r.category,
                title: r.title,
                record_type: r.record_type,
                created_at: r.created_at,
                rank: idx + 1,
                rawScore: parseFloat(r.score),
            }));
        }
        catch {
            // ngram parser may not be available on older MySQL — degrade gracefully
            return [];
        }
    }
    // ==========================================================================
    // Read operations
    // ==========================================================================
    async get(id) {
        const rows = await this.query(`SELECT id, content, category, title, record_type FROM ${this.config.table} WHERE id = ? AND deleted_at IS NULL`, [id]);
        if (rows.length === 0)
            return null;
        const row = rows[0];
        return {
            text: this.formatFullRecord(row),
            path: `shadowdb/${row.category || "general"}/${row.id}`,
        };
    }
    async getByPath(pathQuery, from, lines) {
        const parts = pathQuery.replace(/^shadowdb\//, "").split("/");
        if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
            const id = parseInt(parts[parts.length - 1], 10);
            const record = await this.get(id);
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
        const category = parts[0] || null;
        const sql = category
            ? `SELECT id, LEFT(content, 200) as content, category, title FROM ${this.config.table} WHERE category = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`
            : `SELECT id, LEFT(content, 200) as content, category, title FROM ${this.config.table} WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`;
        const rows = category
            ? await this.query(sql, [category])
            : await this.query(sql);
        const text = rows
            .map((r) => `[${r.id}] ${r.title || r.category || "—"}: ${(r.content || "").slice(0, 120)}`)
            .join("\n");
        return { text: text || "No records found", path: pathQuery };
    }
    async getPrimerRows() {
        try {
            return await this.query("SELECT `key`, content FROM primer WHERE enabled = 1 OR enabled IS NULL ORDER BY priority ASC, `key` ASC");
        }
        catch {
            return [];
        }
    }
    // ==========================================================================
    // Write operations
    // ==========================================================================
    async insertRecord(params) {
        const result = await this.exec(`INSERT INTO ${this.config.table} (content, category, title, tags, record_type, metadata, parent_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [params.content, params.category, params.title, JSON.stringify(params.tags), params.record_type,
            JSON.stringify(params.metadata), params.parent_id, params.priority]);
        return result.insertId;
    }
    async list(params) {
        const conditions = ["deleted_at IS NULL"];
        const values = [];
        if (params.category) {
            conditions.push("category = ?");
            values.push(params.category);
        }
        if (params.record_type) {
            conditions.push("record_type = ?");
            values.push(params.record_type);
        }
        if (params.parent_id !== undefined) {
            conditions.push("parent_id = ?");
            values.push(params.parent_id);
        }
        if (params.priority_min !== undefined) {
            conditions.push("priority >= ?");
            values.push(params.priority_min);
        }
        if (params.priority_max !== undefined) {
            conditions.push("priority <= ?");
            values.push(params.priority_max);
        }
        if (params.created_after) {
            conditions.push("created_at >= ?");
            values.push(params.created_after);
        }
        if (params.created_before) {
            conditions.push("created_at <= ?");
            values.push(params.created_before);
        }
        const where = conditions.join(" AND ");
        const lim = Math.min(params.limit ?? 50, 200);
        const off = params.offset ?? 0;
        const contentCol = params.detail_level === "full" || params.detail_level === "snippet" ? ", content" : "";
        const rows = await this.query(`SELECT id, category, title, record_type, priority, parent_id,
              COALESCE(metadata, '{}') as metadata, created_at, COALESCE(tags, '[]') as tags${contentCol}
       FROM ${this.config.table}
       WHERE ${where}
       ORDER BY priority ASC, created_at DESC
       LIMIT ? OFFSET ?`, [...values, lim, off]);
        return rows.map((row) => ({
            id: row.id,
            path: `shadowdb/${row.category || "general"}/${row.id}`,
            category: row.category,
            title: row.title,
            record_type: row.record_type,
            priority: row.priority ?? 5,
            parent_id: row.parent_id,
            metadata: JSON.parse(typeof row.metadata === "string" ? row.metadata : "{}"),
            created_at: String(row.created_at),
            tags: JSON.parse(typeof row.tags === "string" ? row.tags : "[]"),
            ...(contentCol ? { content: row.content } : {}),
        }));
    }
    async updateRecord(id, patch) {
        const setClauses = [];
        const values = [];
        for (const [key, value] of Object.entries(patch)) {
            setClauses.push(`${key} = ?`);
            values.push(key === "tags" ? JSON.stringify(value) : value);
        }
        // updated_at auto-updates via ON UPDATE CURRENT_TIMESTAMP
        values.push(id);
        await this.exec(`UPDATE ${this.config.table} SET ${setClauses.join(", ")} WHERE id = ?`, values);
    }
    async softDeleteRecord(id) {
        await this.exec(`UPDATE ${this.config.table} SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [id]);
    }
    async restoreRecord(id) {
        await this.exec(`UPDATE ${this.config.table} SET deleted_at = NULL WHERE id = ?`, [id]);
    }
    async fetchExpiredRecords(days) {
        const rows = await this.query(`SELECT id, content, category, title, deleted_at FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [days]);
        return rows;
    }
    async purgeExpiredRecords(days) {
        const result = await this.exec(`DELETE FROM ${this.config.table} WHERE deleted_at IS NOT NULL AND deleted_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [days]);
        return result.affectedRows ?? 0;
    }
    async storeEmbedding(id, embedding) {
        if (!this.hasVector)
            return;
        const vecString = `[${embedding.join(",")}]`;
        await this.exec(`UPDATE ${this.config.table} SET embedding = STRING_TO_VECTOR(?) WHERE id = ?`, [vecString, id]);
    }
    async getRecordMeta(id) {
        const rows = await this.query(`SELECT id, content, category, deleted_at FROM ${this.config.table} WHERE id = ?`, [id]);
        return rows[0] || null;
    }
    // ==========================================================================
    // Lifecycle
    // ==========================================================================
    async ping() {
        try {
            await this.query("SELECT 1");
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
    async getMetaValue(key) {
        try {
            const rows = await this.query(`SELECT value FROM ${this.config.table}_meta WHERE \`key\` = ?`, [key]);
            return rows[0]?.value ?? null;
        }
        catch {
            return null; // table doesn't exist yet
        }
    }
    async setMetaValue(key, value) {
        await this.exec(`
      INSERT INTO ${this.config.table}_meta (\`key\`, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP(3)
    `, [key, value]);
    }
    async getRecordBatch(afterId, limit) {
        return await this.query(`SELECT id, content FROM ${this.config.table} WHERE deleted_at IS NULL AND id > ? ORDER BY id ASC LIMIT ?`, [afterId, limit]);
    }
}
//# sourceMappingURL=mysql.js.map