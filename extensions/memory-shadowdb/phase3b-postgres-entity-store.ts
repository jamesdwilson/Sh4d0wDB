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
import type { EntityStore, StoredEntity, StoredEdge } from "./phase3b-entity-resolver.js";
import type { EntityCandidate, EdgeType } from "./phase4-profile-linkedin.js";

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a PostgresEntityStore backed by the provided connection pool.
 *
 * @param pool - pg.Pool connected to the `shadow` database
 * @returns    - EntityStore implementation
 */
export function createPostgresEntityStore(pool: Pool): EntityStore {
  return {
    findByLinkedinUrl,
    findByEmail,
    findByNameAndCompany,
    findByName,
    findByDomain,
    findByCompanyName,
    createEntity,
    updateEntity,
    mergeEntities,
    findEdge,
    createEdge,
    updateEdge,
  };

  // --------------------------------------------------------------------------
  async function findByLinkedinUrl(url: string): Promise<StoredEntity | null> {
    try {
      const res = await pool.query(
        `SELECT id, title, category, metadata
           FROM memories
          WHERE deleted_at IS NULL
            AND metadata->>'linkedinUrl' = $1
          LIMIT 1`,
        [url],
      );
      return res.rows[0] ? rowToEntity(res.rows[0]) : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  async function findByEmail(email: string): Promise<StoredEntity | null> {
    try {
      const res = await pool.query(
        `SELECT id, title, category, metadata
           FROM memories
          WHERE deleted_at IS NULL
            AND metadata->'emails' @> $1::jsonb
          LIMIT 1`,
        [JSON.stringify([email])],
      );
      return res.rows[0] ? rowToEntity(res.rows[0]) : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  async function findByNameAndCompany(
    name: string,
    company: string,
  ): Promise<StoredEntity[]> {
    try {
      const res = await pool.query(
        `SELECT id, title, category, metadata
           FROM memories
          WHERE deleted_at IS NULL
            AND metadata->>'canonicalName' ILIKE $1
            AND metadata->'companies' @> $2::jsonb
          LIMIT 10`,
        [name, JSON.stringify([company])],
      );
      return res.rows.map(rowToEntity);
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  async function findByName(name: string): Promise<StoredEntity[]> {
    try {
      const res = await pool.query(
        `SELECT id, title, category, metadata
           FROM memories
          WHERE deleted_at IS NULL
            AND metadata->>'canonicalName' ILIKE $1
          LIMIT 10`,
        [name],
      );
      return res.rows.map(rowToEntity);
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  async function findByDomain(domain: string): Promise<StoredEntity | null> {
    try {
      const res = await pool.query(
        `SELECT id, title, category, metadata
           FROM memories
          WHERE deleted_at IS NULL
            AND metadata->>'domain' = $1
          LIMIT 1`,
        [domain],
      );
      return res.rows[0] ? rowToEntity(res.rows[0]) : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  async function findByCompanyName(name: string): Promise<StoredEntity[]> {
    try {
      const res = await pool.query(
        `SELECT id, title, category, metadata
           FROM memories
          WHERE deleted_at IS NULL
            AND category IN ('company', 'fund', 'school')
            AND metadata->>'canonicalName' ILIKE $1
          LIMIT 10`,
        [name],
      );
      return res.rows.map(rowToEntity);
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  async function createEntity(candidate: EntityCandidate): Promise<StoredEntity> {
    const canonicalName = candidate.name ?? candidate.companyName ?? "Unknown";
    const metadata = {
      canonicalName,
      aliases: [] as string[],
      emails: candidate.email ? [candidate.email] : [],
      phones: candidate.phone ? [candidate.phone] : [],
      linkedinUrl: candidate.linkedinUrl ?? null,
      domain: candidate.domain ?? null,
      companies: candidate.companyName ? [candidate.companyName] : [],
      sourceBitmask: 0,
    };

    const content = buildEntityContent(candidate, metadata);

    const res = await pool.query(
      `INSERT INTO memories
         (title, content, category, metadata, source, source_id, record_type, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, title, category, metadata`,
      [
        canonicalName,
        content,
        candidate.type,
        JSON.stringify(metadata),
        "entity_resolver",
        candidate.sourceRecordId,
        "fact",
        candidate.confidence,
      ],
    );

    return rowToEntity(res.rows[0]);
  }

  // --------------------------------------------------------------------------
  async function updateEntity(
    id: number,
    patch: Partial<StoredEntity>,
  ): Promise<StoredEntity> {
    // Only update metadata and title — never overwrite category or id
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (patch.metadata !== undefined) {
      sets.push(`metadata = $${idx++}`);
      params.push(JSON.stringify(patch.metadata));
    }
    if (patch.title !== undefined) {
      sets.push(`title = $${idx++}`);
      params.push(patch.title);
    }
    sets.push(`updated_at = NOW()`);
    params.push(id);

    const res = await pool.query(
      `UPDATE memories SET ${sets.join(", ")} WHERE id = $${idx} RETURNING id, title, category, metadata`,
      params,
    );
    return rowToEntity(res.rows[0]);
  }

  // --------------------------------------------------------------------------
  async function mergeEntities(
    survivorId: number,
    absorbedId: number,
  ): Promise<void> {
    try {
      // Re-point edges
      await pool.query(
        `UPDATE memory_edges SET from_id = $1 WHERE from_id = $2`,
        [survivorId, absorbedId],
      );
      await pool.query(
        `UPDATE memory_edges SET to_id = $1 WHERE to_id = $2`,
        [survivorId, absorbedId],
      );
      // Hard delete absorbed entity (merge is permanent)
      await pool.query(`DELETE FROM memories WHERE id = $1`, [absorbedId]);
    } catch {
      // Never throw
    }
  }

  // --------------------------------------------------------------------------
  async function findEdge(
    fromId: number,
    toId: number,
    type: EdgeType,
  ): Promise<StoredEdge | null> {
    try {
      const res = await pool.query(
        `SELECT from_id, to_id, type, confidence, source_id, evidence_text,
                first_seen_at, last_verified_at
           FROM memory_edges
          WHERE from_id = $1 AND to_id = $2 AND type = $3
          LIMIT 1`,
        [fromId, toId, type],
      );
      if (!res.rows[0]) return null;
      const r = res.rows[0];
      return {
        fromId: r.from_id,
        toId: r.to_id,
        type: r.type,
        confidence: r.confidence,
        sourceId: r.source_id,
        evidenceText: r.evidence_text,
        firstSeenAt: r.first_seen_at,
        lastVerifiedAt: r.last_verified_at,
      };
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  async function createEdge(
    edge: Omit<StoredEdge, "firstSeenAt" | "lastVerifiedAt">,
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO memory_edges
           (from_id, to_id, type, confidence, source_id, evidence_text)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (from_id, to_id, type) DO NOTHING`,
        [edge.fromId, edge.toId, edge.type, edge.confidence, edge.sourceId, edge.evidenceText ?? null],
      );
    } catch {
      // Never throw
    }
  }

  // --------------------------------------------------------------------------
  async function updateEdge(
    fromId: number,
    toId: number,
    type: EdgeType,
    patch: Partial<StoredEdge>,
  ): Promise<void> {
    try {
      const sets: string[] = ["last_verified_at = NOW()"];
      const params: unknown[] = [];
      let idx = 1;

      if (patch.confidence !== undefined) {
        sets.push(`confidence = $${idx++}`);
        params.push(patch.confidence);
      }
      if (patch.sourceId !== undefined) {
        sets.push(`source_id = $${idx++}`);
        params.push(patch.sourceId);
      }
      if (patch.evidenceText !== undefined) {
        sets.push(`evidence_text = $${idx++}`);
        params.push(patch.evidenceText);
      }

      params.push(fromId, toId, type);
      await pool.query(
        `UPDATE memory_edges
            SET ${sets.join(", ")}
          WHERE from_id = $${idx} AND to_id = $${idx + 1} AND type = $${idx + 2}`,
        params,
      );
    } catch {
      // Never throw
    }
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function rowToEntity(row: {
  id: number;
  title: string;
  category: string;
  metadata: Record<string, unknown>;
}): StoredEntity {
  const meta = row.metadata ?? {};
  return {
    id: row.id,
    category: row.category ?? "person",
    title: row.title ?? "",
    metadata: {
      canonicalName: (meta.canonicalName as string) ?? row.title,
      aliases: (meta.aliases as string[]) ?? [],
      emails: (meta.emails as string[]) ?? [],
      phones: (meta.phones as string[]) ?? [],
      linkedinUrl: (meta.linkedinUrl as string | null) ?? null,
      domain: (meta.domain as string | null) ?? null,
      companies: (meta.companies as string[]) ?? [],
      sourceBitmask: (meta.sourceBitmask as number) ?? 0,
    },
  };
}

function buildEntityContent(
  candidate: EntityCandidate,
  meta: { canonicalName: string; companies: string[] },
): string {
  const parts: string[] = [`Name: ${meta.canonicalName}`];
  if (candidate.title) parts.push(`Title: ${candidate.title}`);
  if (meta.companies.length > 0) parts.push(`Company: ${meta.companies.join(", ")}`);
  if (candidate.email) parts.push(`Email: ${candidate.email}`);
  if (candidate.linkedinUrl) parts.push(`LinkedIn: ${candidate.linkedinUrl}`);
  return parts.join("\n");
}
