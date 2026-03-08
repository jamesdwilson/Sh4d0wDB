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
    updateEdge(fromId: number, toId: number, type: EdgeType, patch: Partial<StoredEdge>): Promise<void>;
}
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
export interface EntityResolverOptions {
    /**
     * Minimum confidence required to return a match.
     * Candidates with resolution confidence below this are returned as null.
     * Default: 0.55 (accepts name+company but rejects fuzzy-name-only)
     */
    minConfidence?: number;
}
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
/**
 * Create an EntityResolver backed by the provided EntityStore.
 *
 * @param store    - Persistence layer (real DB or mock for tests)
 * @param options  - Resolution options
 */
export declare function createEntityResolver(store: EntityStore, options?: EntityResolverOptions): EntityResolver;
