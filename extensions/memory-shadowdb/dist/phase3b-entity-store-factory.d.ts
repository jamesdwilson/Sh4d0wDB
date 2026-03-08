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
import type { EntityStore } from "./phase3b-entity-resolver.js";
export interface EntityStoreOptions {
    /** Database connection string — passed to backend */
    connectionString?: string;
    /** Optional logger — defaults to console */
    logger?: {
        warn: (msg: string) => void;
        info: (msg: string) => void;
    };
}
/**
 * Create an EntityStore for the given backend.
 *
 * @param backend           - "postgres" | "sqlite" | "mysql"
 * @param options           - Connection options
 * @returns                 - EntityStore (real or stub)
 *
 * Never throws — returns NullEntityStore on unknown backend.
 */
export declare function createEntityStore(backend: string, options?: EntityStoreOptions): Promise<EntityStore>;
