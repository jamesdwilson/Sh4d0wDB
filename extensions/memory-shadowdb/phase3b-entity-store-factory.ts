/**
 * phase3b-entity-store-factory.ts — EntityStore factory
 *
 * Creates the correct EntityStore implementation based on the plugin's
 * configured backend ("postgres" | "sqlite" | "mysql").
 *
 * Only PostgreSQL is fully implemented. SQLite and MySQL return a
 * NullEntityStore stub that satisfies the interface but no-ops all writes
 * and returns empty results — so the pipeline degrades gracefully rather
 * than crashing on those backends.
 *
 * Usage:
 *   const store = createEntityStore(backend, { connectionString });
 *   const resolver = createEntityResolver(store);
 *
 * When SQLite/MySQL EntityStore implementations are ready, swap out the
 * stub returns here — callers don't change.
 *
 * See: ARCHITECTURE.md § 7, phase3b-entity-resolver.ts
 */

import type { EntityStore, StoredEntity, StoredEdge } from "./phase3b-entity-resolver.js";

// ============================================================================
// Options
// ============================================================================

export interface EntityStoreOptions {
  /** Database connection string — passed to backend */
  connectionString?: string;
  /** Optional logger — defaults to console */
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

// ============================================================================
// NullEntityStore — stub for unimplemented backends
// ============================================================================

/**
 * No-op EntityStore for SQLite and MySQL backends.
 *
 * Returns empty/null for all reads, silently discards all writes.
 * Logs a one-time warning at construction so it's visible but not spammy.
 *
 * Replace this with real implementations when those backends are built.
 */
class NullEntityStore implements EntityStore {
  constructor(
    private readonly backend: string,
    private readonly logger: { warn: (msg: string) => void },
  ) {
    this.logger.warn(
      `[entity-store] Backend "${backend}" does not yet support EntityStore — ` +
      `entity resolution will be skipped. Only PostgreSQL is currently supported.`,
    );
  }

  async findByLinkedinUrl(_url: string): Promise<null> { return null; }
  async findByEmail(_email: string): Promise<null> { return null; }
  async findByNameAndCompany(_name: string, _company: string): Promise<StoredEntity[]> { return []; }
  async findByName(_name: string): Promise<StoredEntity[]> { return []; }
  async findByDomain(_domain: string): Promise<null> { return null; }
  async findByCompanyName(_name: string): Promise<StoredEntity[]> { return []; }
  async createEntity(_candidate: unknown): Promise<StoredEntity> {
    return { id: -1, category: "person", title: "", metadata: { emails: [], phones: [], companies: [], sourceBitmask: 0 } };
  }
  async updateEntity(_id: number, _patch: Partial<StoredEntity>): Promise<StoredEntity> {
    return { id: -1, category: "person", title: "", metadata: { emails: [], phones: [], companies: [], sourceBitmask: 0 } };
  }
  async mergeEntities(_survivorId: number, _absorbedId: number): Promise<void> {}
  async findEdge(_fromId: number, _toId: number, _type: string): Promise<null> { return null; }
  async createEdge(_edge: Omit<StoredEdge, "firstSeenAt" | "lastVerifiedAt">): Promise<void> {}
  async updateEdge(_fromId: number, _toId: number, _type: string, _patch: Partial<StoredEdge>): Promise<void> {}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an EntityStore for the given backend.
 *
 * @param backend           - "postgres" | "sqlite" | "mysql"
 * @param options           - Connection options
 * @returns                 - EntityStore (real or stub)
 *
 * Never throws — returns NullEntityStore on unknown backend.
 */
export async function createEntityStore(
  backend: string,
  options: EntityStoreOptions = {},
): Promise<EntityStore> {
  const logger = options.logger ?? { warn: console.warn, info: console.info };

  switch (backend) {
    case "postgres": {
      // Real implementation — uses pg pool + memory_edges table
      const { createPostgresEntityStore } = await import(
        "./phase3b-postgres-entity-store.js"
      );
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: options.connectionString, max: 3 });
      return createPostgresEntityStore(pool);
    }

    case "sqlite":
      // TODO: implement SQLiteEntityStore when SQLiteStore is extended
      // Will need: better-sqlite3, a local entities table, a local edges table
      return new NullEntityStore("sqlite", logger);

    case "mysql":
      // TODO: implement MySQLEntityStore when MySQLStore is extended
      // Will need: mysql2, entities + edges tables with appropriate types
      return new NullEntityStore("mysql", logger);

    default:
      logger.warn(
        `[entity-store] Unknown backend "${backend}" — entity resolution disabled.`,
      );
      return new NullEntityStore(backend, logger);
  }
}
