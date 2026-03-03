/**
 * event-to-contact.ts — Auto-map events to related contacts
 *
 * v0.7.0: When an event record is written with category=event,
 * extract entity tags and find contacts to link.
 *
 * Heuristic:
 * - Extract entities from event content and tags
 * - Query for contacts tagged with those entities
 * - Return contact IDs that should be updated
 */
/** Extract entity slugs from tags array. */
export declare function extractEntities(tags: string[]): string[];
/** Extract entity slugs from content text (basic pattern matching). */
export declare function extractEntitiesFromText(content: string, knownEntities: string[]): string[];
export interface ContactMatch {
    contactId: number;
    entitySlug: string;
}
/**
 * Find contacts that should be linked to an event.
 *
 * @param eventTags       - Tags from the event record
 * @param eventContent    - Event content text
 * @param knownEntities   - Known entity slugs to search for in content
 * @param queryContactsFn - Function to query contacts by entity tag
 * @returns Contact IDs that match the event entities
 */
export declare function mapEventToContacts(eventTags: string[], eventContent: string, knownEntities: string[], queryContactsFn: (entitySlug: string) => Promise<Array<{
    id: number;
}>>): Promise<ContactMatch[]>;
