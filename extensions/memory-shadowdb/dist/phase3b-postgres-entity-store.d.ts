/**
 * phase3b-postgres-entity-store.ts — PostgreSQL implementation of EntityStore
 *
 * The real database backend for EntityResolver. Reads from and writes to:
 *   - `memories` table  — entity nodes (person, company, group, fund, school, event)
 *   - `memory_edges`    — directed edges between entities (migration 004)
 *
 * Entity nodes use the `memories` table with:
 *   - category = EntityNodeType ("person", "company", etc.)
 *   - title = canonicalName (for display + FTS)
 *   - content = human-readable description (for embedding + search)
 *   - metadata = { canonicalName, emails, phones, linkedinUrl, domain, companies, sourceBitmask }
 *   - source = "entity_resolver"
 *
 * Lookup strategy for each find* method:
 *   - findByLinkedinUrl:    metadata->>'linkedinUrl' = $1
 *   - findByEmail:          metadata->'emails' @> $1::jsonb
 *   - findByName:           metadata->>'canonicalName' ILIKE $1
 *   - findByNameAndCompany: metadata->>'canonicalName' ILIKE $1 AND metadata->'companies' @> $2::jsonb
 *   - findByDomain:         metadata->>'domain' = $1
 *   - findByCompanyName:    category = 'company'/'school'/'fund' AND metadata->>'canonicalName' ILIKE $1
 *
 * All methods: never throw (catch internally, return null/[]).
 *
 * See: ARCHITECTURE.md § 7.4, migration 004_entity_edges.sql
 */
import type { Pool } from "pg";
import type { EntityStore } from "./phase3b-entity-resolver.js";
/**
 * Create a PostgresEntityStore backed by the provided connection pool.
 *
 * @param pool - pg.Pool connected to the `shadow` database
 * @returns    - EntityStore implementation
 */
export declare function createPostgresEntityStore(pool: Pool): EntityStore;
