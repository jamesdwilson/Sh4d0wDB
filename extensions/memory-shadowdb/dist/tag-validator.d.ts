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
export declare const VALID_NAMESPACES: Set<string>;
export interface InvalidTag {
    tag: string;
    reason: string;
}
export interface ValidateTagsResult {
    valid: boolean;
    invalid: InvalidTag[];
    normalized: string[];
}
export interface ValidateTagsOptions {
    /** If true, tags without a namespace prefix are rejected. Default: false. */
    strict?: boolean;
}
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
export declare function validateTags(tags: string[], options?: ValidateTagsOptions): ValidateTagsResult;
