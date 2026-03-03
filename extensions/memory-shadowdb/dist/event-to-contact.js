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
export function extractEntities(tags) {
    return tags
        .filter(t => t.startsWith('entity:'))
        .map(t => t.replace('entity:', ''));
}
/** Extract entity slugs from content text (basic pattern matching). */
export function extractEntitiesFromText(content, knownEntities) {
    const found = [];
    const lower = content.toLowerCase();
    for (const entity of knownEntities) {
        // Simple substring match — entity slug converted to human-readable
        const humanForm = entity.replace(/-/g, ' ');
        if (lower.includes(entity) || lower.includes(humanForm)) {
            found.push(entity);
        }
    }
    return [...new Set(found)]; // dedupe
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
export async function mapEventToContacts(eventTags, eventContent, knownEntities, queryContactsFn) {
    // Extract entities from tags
    const tagEntities = extractEntities(eventTags);
    // Extract entities from content
    const textEntities = extractEntitiesFromText(eventContent, knownEntities);
    // Combine and dedupe
    const allEntities = [...new Set([...tagEntities, ...textEntities])];
    // Find contacts for each entity
    const matches = [];
    for (const entity of allEntities) {
        const contacts = await queryContactsFn(entity);
        for (const contact of contacts) {
            // Avoid duplicates
            if (!matches.some(m => m.contactId === contact.id)) {
                matches.push({ contactId: contact.id, entitySlug: entity });
            }
        }
    }
    return matches;
}
