/**
 * tag-validator.ts — Tag namespace validation for memory writes
 *
 * Sprint v0.5.0: enforce tag prefixes on write.
 *
 * Valid namespaces:
 * - entity:    Who/what is involved (entity:james-wilson, entity:tmm-program)
 * - domain:    Subject matter (domain:ma, domain:investment, domain:civic)
 * - loc:       Geography (loc:tyler-tx, loc:national)
 * - sector:    Industry/topic (sector:broadband, sector:crypto)
 * - status:    Time-sensitive state (status:fundraising, status:closed)
 * - interest:  Expressed interests (interest:capital-formation)
 */
/** All valid tag namespace prefixes (without the trailing colon). */
export const VALID_NAMESPACES = new Set([
    "entity",
    "domain",
    "loc",
    "sector",
    "status",
    "interest",
]);
/**
 * Validate an array of tags against namespace rules.
 *
 * Rules:
 * - Tags with a namespace prefix (e.g. "entity:james") must use a valid namespace
 * - Tags without a colon are allowed by default (set strict: true to reject)
 * - Empty namespace ("entity:") is invalid
 * - Whitespace in namespace is invalid
 * - Tags are normalized to lowercase and trimmed
 *
 * @param tags    - Array of tags to validate
 * @param options - Validation options
 * @returns       { valid, invalid[], normalized[] }
 */
export function validateTags(tags, options = {}) {
    const { strict = false } = options;
    const invalid = [];
    const normalized = [];
    for (const rawTag of tags) {
        const tag = rawTag.trim().toLowerCase();
        normalized.push(tag);
        // Empty tag — let sanitizeTags handle it (this validator just checks namespace)
        if (!tag)
            continue;
        // Check for namespace prefix
        const colonIdx = tag.indexOf(":");
        if (colonIdx === -1) {
            // No namespace
            if (strict) {
                invalid.push({
                    tag,
                    reason: `Tag "${tag}" has no namespace prefix (strict mode)`,
                });
            }
            continue;
        }
        const namespace = tag.slice(0, colonIdx);
        const value = tag.slice(colonIdx + 1);
        // Empty namespace
        if (namespace === "") {
            invalid.push({
                tag,
                reason: `Tag "${tag}" has empty namespace before colon`,
            });
            continue;
        }
        // Whitespace in namespace
        if (/\s/.test(namespace)) {
            invalid.push({
                tag,
                reason: `Tag "${tag}" has whitespace in namespace`,
            });
            continue;
        }
        // Unknown namespace
        if (!VALID_NAMESPACES.has(namespace)) {
            invalid.push({
                tag,
                reason: `Tag "${tag}" has unknown namespace "${namespace}". Valid: ${[...VALID_NAMESPACES].join(", ")}`,
            });
            continue;
        }
        // Empty value after namespace
        if (value === "") {
            invalid.push({
                tag,
                reason: `Tag "${tag}" has empty value after namespace`,
            });
            continue;
        }
    }
    return {
        valid: invalid.length === 0,
        invalid,
        normalized,
    };
}
//# sourceMappingURL=tag-validator.js.map