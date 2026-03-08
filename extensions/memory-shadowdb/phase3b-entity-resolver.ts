/**
 * phase3b-entity-resolver.ts — Cross-source entity resolution
 *
 * The EntityResolver is the identity layer of the graph. It answers:
 * "Is this candidate the same entity as something we already know?"
 *
 * Without it, amy@acme.com (Gmail) and "Amy Chen at Acme" (LinkedIn) are
 * two nodes. With it, they are one. Every graph query depends on this
 * being correct.
 *
 * Resolution priority (highest → lowest confidence):
 *   Person:
 *     1. linkedinUrl match        → 1.00  (globally unique identifier)
 *     2. email match              → 0.99  (near-unique in practice)
 *     3. name + company + title   → 0.85
 *     4. name + company           → 0.70
 *     5. name fuzzy only          → 0.50  (often below minConfidence threshold)
 *   Company:
 *     6. domain match             → 0.90
 *     7. name fuzzy               → 0.60
 *
 * Design decisions:
 *   - EntityStore is injected — fully testable with mock, no DB in unit tests
 *   - resolve() is idempotent — same candidate twice = same entity, no duplicate
 *   - resolve() enriches existing entities with new data (adds emails, linkedinUrl)
 *   - merge() re-points all edges and removes the absorbed entity
 *   - addEdge() is idempotent — re-registration updates confidence + lastVerifiedAt
 *   - Never throws — returns null on unresolvable candidates
 *
 * See: ARCHITECTURE.md § 7.4
 */

import type { EntityNodeType, EdgeType, EntityCandidate } from "./phase4-profile-linkedin.js";

// ============================================================================
// EntityStore interface — injectable, DB-agnostic
// ============================================================================

/** A resolved entity node as stored in ShadowDB */
export interface StoredEntity {
  id: number;
  category: string;
  title: string;
  metadata: {
    canonicalName?: string;
    aliases?: string[];
    emails: string[];
    phones: string[];
    linkedinUrl?: string | null;
    domain?: string | null;
    companies: string[];
    sourceBitmask: number;
    [key: string]: unknown;
  };
}

/** A stored directed edge between two entities */
export interface StoredEdge {
  fromId: number;
  toId: number;
  type: EdgeType;
  confidence: number;
  sourceId: string;
  evidenceText?: string;
  firstSeenAt: Date;
  lastVerifiedAt: Date;
}

/**
 * Persistence interface for entity resolution.
 * Inject a real PostgresEntityStore for production,
 * or a MockStore for tests.
 */
export interface EntityStore {
  findByLinkedinUrl(url: string): Promise<StoredEntity | null>;
  findByEmail(email: string): Promise<StoredEntity | null>;
  findByNameAndCompany(name: string, company: string): Promise<StoredEntity[]>;
  findByName(name: string): Promise<StoredEntity[]>;
  findByDomain(domain: string): Promise<StoredEntity | null>;
  findByCompanyName(name: string): Promise<StoredEntity[]>;
  createEntity(candidate: EntityCandidate): Promise<StoredEntity>;
  updateEntity(id: number, patch: Partial<StoredEntity>): Promise<StoredEntity>;
  mergeEntities(survivorId: number, absorbedId: number): Promise<void>;
  findEdge(fromId: number, toId: number, type: EdgeType): Promise<StoredEdge | null>;
  createEdge(edge: Omit<StoredEdge, "firstSeenAt" | "lastVerifiedAt">): Promise<void>;
  updateEdge(
    fromId: number,
    toId: number,
    type: EdgeType,
    patch: Partial<StoredEdge>,
  ): Promise<void>;
}

// ============================================================================
// ResolvedEntity — public return type
// ============================================================================

/** A resolved entity returned by EntityResolver.resolve() */
export interface ResolvedEntity {
  id: number;
  type: EntityNodeType;
  canonicalName: string;
  aliases: string[];
  emails: string[];
  phones: string[];
  linkedinUrl?: string | null;
  sourceBitmask: number;
}

// ============================================================================
// EntityResolverOptions
// ============================================================================

export interface EntityResolverOptions {
  /**
   * Minimum confidence required to return a match.
   * Candidates with resolution confidence below this are returned as null.
   * Default: 0.55 (accepts name+company but rejects fuzzy-name-only)
   */
  minConfidence?: number;
}

// ============================================================================
// EntityResolver interface
// ============================================================================

export interface EntityResolver {
  /**
   * Find or create a canonical entity for a candidate.
   *
   * Resolution order:
   *   1. linkedinUrl  → exact match → 1.00
   *   2. email        → exact match → 0.99
   *   3. name+company → fuzzy      → 0.70–0.85
   *   4. name only    → fuzzy      → 0.50
   *   5. domain       → exact      → 0.90 (company)
   *   6. companyName  → fuzzy      → 0.60 (company)
   *
   * Enriches existing entity with any new data from candidate.
   * Returns null if confidence < minConfidence or candidate has no identifiers.
   * Never throws.
   */
  resolve(candidate: EntityCandidate): Promise<ResolvedEntity | null>;

  /**
   * Merge two entities — survivor absorbs the absorbed entity.
   * All edges pointing to/from absorbed are re-pointed to survivor.
   * Absorbed entity is deleted.
   * Never throws.
   */
  merge(survivorId: number, absorbedId: number, confidence: number): Promise<void>;

  /**
   * Register a directed edge between two entities.
   * Idempotent: if the same (fromId, toId, type) already exists,
   * updates confidence (to max) and lastVerifiedAt.
   * Never throws.
   */
  addEdge(edge: Omit<StoredEdge, "firstSeenAt" | "lastVerifiedAt">): Promise<void>;
}

// ============================================================================
// createEntityResolver — factory function
// ============================================================================

/**
 * Create an EntityResolver backed by the provided EntityStore.
 *
 * @param store    - Persistence layer (real DB or mock for tests)
 * @param options  - Resolution options
 */
export function createEntityResolver(
  store: EntityStore,
  options: EntityResolverOptions = {},
): EntityResolver {
  const minConfidence = options.minConfidence ?? 0.55;

  return { resolve, merge, addEdge };

  // --------------------------------------------------------------------------
  async function resolve(candidate: EntityCandidate): Promise<ResolvedEntity | null> {
    try {
      // Reject empty candidates immediately
      if (!hasIdentifier(candidate)) return null;

      const isCompany =
        candidate.type === "company" ||
        candidate.type === "fund" ||
        candidate.type === "school";

      if (isCompany) {
        return resolveCompanyLike(candidate);
      } else {
        return resolvePerson(candidate);
      }
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  async function resolvePerson(candidate: EntityCandidate): Promise<ResolvedEntity | null> {
    let match: StoredEntity | null = null;
    let matchConfidence = 0;

    // Priority 1: linkedinUrl — 1.00
    if (candidate.linkedinUrl) {
      match = await store.findByLinkedinUrl(candidate.linkedinUrl).catch(() => null);
      if (match) matchConfidence = 1.00;
    }

    // Priority 2: email — 0.99
    if (!match && candidate.email) {
      match = await store.findByEmail(candidate.email).catch(() => null);
      if (match) matchConfidence = 0.99;
    }

    // Priority 3: name + company — 0.70–0.85
    if (!match && candidate.name && candidate.companyName) {
      const candidates = await store
        .findByNameAndCompany(candidate.name, candidate.companyName)
        .catch(() => []);
      if (candidates.length > 0) {
        match = candidates[0];
        matchConfidence = candidate.title ? 0.85 : 0.70;
      }
    }

    // Priority 4: name fuzzy only — 0.50
    // Also used as fallback when name+company search found nothing
    // (existing entity may predate company data being added)
    if (!match && candidate.name) {
      const candidates = await store.findByName(candidate.name).catch(() => []);
      if (candidates.length === 1) {
        // Only match if unique — multiple matches = ambiguous, skip
        match = candidates[0];
        // Boost confidence slightly if candidate also has a company (corroboration)
        matchConfidence = candidate.companyName ? 0.55 : 0.50;
      }
    }

    if (matchConfidence > 0 && matchConfidence < minConfidence) {
      // Found a match but confidence too low — return null rather than
      // risk a bad merge. Don't create a new entity either (ambiguous).
      return null;
    }

    if (match) {
      // Enrich existing entity with new data
      await enrichEntity(match, candidate);
      return toResolvedEntity(match, candidate.type);
    }

    // No match — create new
    if (!candidate.name && !candidate.email && !candidate.phone) return null;
    const created = await store.createEntity(candidate);
    return toResolvedEntity(created, candidate.type);
  }

  // --------------------------------------------------------------------------
  async function resolveCompanyLike(candidate: EntityCandidate): Promise<ResolvedEntity | null> {
    let match: StoredEntity | null = null;
    let matchConfidence = 0;

    // Priority 1: domain — 0.90
    if (candidate.domain) {
      match = await store.findByDomain(candidate.domain).catch(() => null);
      if (match) matchConfidence = 0.90;
    }

    // Priority 2: company name fuzzy — 0.60
    if (!match && candidate.companyName) {
      const candidates = await store.findByCompanyName(candidate.companyName).catch(() => []);
      if (candidates.length === 1) {
        match = candidates[0];
        matchConfidence = 0.60;
      }
    }

    if (matchConfidence < minConfidence && matchConfidence > 0) {
      match = null; // below threshold → new entity
    }

    if (match) {
      await enrichEntity(match, candidate);
      return toResolvedEntity(match, candidate.type);
    }

    if (!candidate.companyName && !candidate.name) return null;
    const created = await store.createEntity(candidate);
    return toResolvedEntity(created, candidate.type);
  }

  // --------------------------------------------------------------------------
  async function enrichEntity(entity: StoredEntity, candidate: EntityCandidate): Promise<void> {
    try {
      const patch: Partial<StoredEntity["metadata"]> = {};
      let changed = false;

      // Add new email
      if (candidate.email && !entity.metadata.emails.includes(candidate.email)) {
        patch.emails = [...entity.metadata.emails, candidate.email];
        changed = true;
      }

      // Add linkedin URL
      if (candidate.linkedinUrl && !entity.metadata.linkedinUrl) {
        patch.linkedinUrl = candidate.linkedinUrl;
        changed = true;
      }

      // Add phone
      if (candidate.phone && !entity.metadata.phones.includes(candidate.phone)) {
        patch.phones = [...entity.metadata.phones, candidate.phone];
        changed = true;
      }

      // Add company
      if (candidate.companyName && !entity.metadata.companies.includes(candidate.companyName)) {
        patch.companies = [...entity.metadata.companies, candidate.companyName];
        changed = true;
      }

      if (changed) {
        await store.updateEntity(entity.id, { metadata: { ...entity.metadata, ...patch } });
        // Mutate local copy so callers see the enriched state
        Object.assign(entity.metadata, patch);
      }
    } catch {
      // Enrichment failure never blocks resolution
    }
  }

  // --------------------------------------------------------------------------
  async function merge(
    survivorId: number,
    absorbedId: number,
    _confidence: number,
  ): Promise<void> {
    try {
      await store.mergeEntities(survivorId, absorbedId);
    } catch {
      // Never throws
    }
  }

  // --------------------------------------------------------------------------
  async function addEdge(
    edge: Omit<StoredEdge, "firstSeenAt" | "lastVerifiedAt">,
  ): Promise<void> {
    try {
      const existing = await store.findEdge(edge.fromId, edge.toId, edge.type);
      if (existing) {
        // Idempotent — update confidence to max, bump lastVerifiedAt
        await store.updateEdge(edge.fromId, edge.toId, edge.type, {
          confidence: Math.max(existing.confidence, edge.confidence),
          sourceId: edge.sourceId,
          evidenceText: edge.evidenceText ?? existing.evidenceText,
        });
      } else {
        await store.createEdge(edge);
      }
    } catch {
      // Never throws
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function hasIdentifier(candidate: EntityCandidate): boolean {
  return !!(
    candidate.linkedinUrl ||
    candidate.email ||
    candidate.phone ||
    candidate.name ||
    candidate.companyName
  );
}

function toResolvedEntity(entity: StoredEntity, type: EntityNodeType): ResolvedEntity {
  return {
    id: entity.id,
    type,
    canonicalName: entity.metadata.canonicalName ?? entity.title,
    aliases: entity.metadata.aliases ?? [],
    emails: entity.metadata.emails ?? [],
    phones: entity.metadata.phones ?? [],
    linkedinUrl: entity.metadata.linkedinUrl,
    sourceBitmask: entity.metadata.sourceBitmask ?? 0,
  };
}
