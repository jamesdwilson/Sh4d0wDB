/**
 * phase3-contact-signal.ts — Contact re-scoring on new signal
 *
 * Implements the onNewContactSignal hook for Phase 3. When a new message
 * is ingested from a known contact, this module:
 *
 *   1. Extracts behavioral signals from the message (tone, deference,
 *      commitment language, unexpected topics, silences)
 *   2. Compares against existing psychographic profile in the contact dossier
 *   3. Computes a delta — does this message shift the DISC/MBTI/Voss profile?
 *   4. Returns a ContactDelta if the change is above threshold, or null if noise
 *
 * Design principles:
 * - NEVER throws — all errors return null
 * - LLM client is injected (mockable, no global state)
 * - Pure functions where possible (extractBehavioralSignals is LLM-backed;
 *   computePsychographicDelta is pure)
 * - Designed to be called from the ingestion runner post-write hook
 *
 * Integration point:
 *   phase1-runner.ts::runIngestion() → after store.write() succeeds for
 *   a message where resolveParties() returned a non-null memoryId →
 *   call onNewContactSignal(memoryId, content, existingDossier, llm)
 */
import type { ExtractedContent } from "./phase1-gmail.js";
import type { LlmClient } from "./phase1-scoring.js";
/**
 * Psychographic profile extracted from a contact dossier.
 * All fields optional — dossiers may have partial profiles.
 */
export interface PsychProfile {
    disc?: string;
    mbti?: string;
    vossType?: string;
    enneagram?: string;
    warmthLevel?: string;
    dominantStyle?: string;
}
/**
 * Behavioral signals extracted from a single message.
 * Returned by extractBehavioralSignals().
 */
export interface BehavioralSignals {
    /** Phrases or patterns indicating deference to others */
    deferenceSignals: string[];
    /** Explicit commitment language (shall, agree, will, must) */
    commitmentLanguage: string[];
    /** Points where tone shifted (e.g., "became formal", "opened up") */
    toneShifts: string[];
    /** Topics raised unexpectedly given context */
    unexpectedTopics: string[];
    /** Topics conspicuously absent given context */
    silenceOn: string[];
    /** Dominant communication style detected in this message */
    dominantStyle: string;
    /** Apparent warmth level: "low" | "medium" | "high" */
    warmthLevel: string;
    /** Apparent urgency: "low" | "medium" | "high" */
    urgencyLevel: string;
}
/**
 * A detected psychographic shift — returned by computePsychographicDelta().
 * Null means no meaningful change.
 */
export interface PsychDelta {
    /** One-line human-readable summary of the change */
    summary: string;
    /** Which profile dimensions changed */
    changedDimensions: string[];
    /** Confidence in the delta [0, 1] */
    confidence: number;
    /** Previous values for changed dimensions */
    before: Partial<PsychProfile & {
        warmthLevel: string;
        dominantStyle: string;
    }>;
    /** New values detected from behavioral signals */
    after: Partial<PsychProfile & {
        warmthLevel: string;
        dominantStyle: string;
    }>;
}
/**
 * Result of onNewContactSignal — the full re-scoring output.
 * Stored as a pattern_event and optionally used to update the dossier.
 */
export interface ContactDelta {
    /** ShadowDB memory id of the contact */
    contactId: number;
    /** Source message that triggered this re-scoring */
    sourceId: string;
    /** One-line summary suitable for a pattern_event */
    summary: string;
    /** The psychographic delta (may be null if only behavioral signals, no profile shift) */
    delta: PsychDelta | null;
    /** Behavioral signals from the new message */
    signals: BehavioralSignals;
    /** Overall confidence in the re-scoring [0, 1] */
    confidence: number;
}
/** A contact dossier record from ShadowDB */
export interface DossierRecord {
    id: number;
    title: string;
    content: string;
    category: string;
    record_type: string;
    created_at: Date | string | null;
    metadata: Record<string, unknown>;
}
/**
 * Minimum confidence for a psychographic delta to be considered meaningful.
 * Below this threshold, computePsychographicDelta returns null.
 * Set conservatively — one message is weak signal.
 */
export declare const DELTA_THRESHOLD = 0.35;
/**
 * Hook called after a message from a known contact is successfully ingested.
 *
 * Orchestrates the full re-scoring pipeline:
 *   1. If no existing dossier → return null (nothing to compare against)
 *   2. Extract behavioral signals from the new message
 *   3. Extract psychographic profile from existing dossier metadata
 *   4. Compute delta between existing profile and new signals
 *   5. Return ContactDelta if meaningful, null if noise or below threshold
 *
 * NEVER throws. All errors return null.
 *
 * @param contactId - ShadowDB memory id of the resolved contact
 * @param content   - The newly ingested message content
 * @param dossier   - Existing dossier record for this contact (null if not found)
 * @param llm       - LLM client for behavioral signal extraction
 * @returns         - ContactDelta if meaningful change detected, null otherwise
 */
export declare function onNewContactSignal(contactId: number, content: ExtractedContent, dossier: DossierRecord | null, llm: LlmClient): Promise<ContactDelta | null>;
/**
 * Extract behavioral signals from a message using an LLM.
 *
 * Sends the message text + optional prior context to the LLM and asks it
 * to identify: deference patterns, commitment language, tone shifts,
 * unexpected topics, notable silences, dominant style, warmth, urgency.
 *
 * Returns null on any LLM error or JSON parse failure.
 * NEVER throws.
 *
 * @param text    - Message plain text to analyze
 * @param context - Prior messages in thread for context (most recent last)
 * @param llm     - LLM client
 * @returns       - Behavioral signals, or null on failure
 */
export declare function extractBehavioralSignals(text: string, context: string[], llm: LlmClient): Promise<BehavioralSignals | null>;
/**
 * Compute psychographic delta between existing profile and new behavioral signals.
 *
 * Pure function — no LLM, no async. Compares:
 *   - dominantStyle (Analyst/Accommodator/Assertive shifts)
 *   - warmthLevel (low/medium/high — meaningful if jumps by 2)
 *
 * Returns null if no dimension changed meaningfully (below DELTA_THRESHOLD).
 *
 * @param existing  - Current psychographic profile from dossier
 * @param signals   - Behavioral signals from new message
 * @returns         - PsychDelta if meaningful change, null otherwise
 */
export declare function computePsychographicDelta(existing: PsychProfile, signals: BehavioralSignals): PsychDelta | null;
