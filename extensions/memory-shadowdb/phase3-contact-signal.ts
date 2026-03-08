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

// ============================================================================
// Types
// ============================================================================

/**
 * Psychographic profile extracted from a contact dossier.
 * All fields optional — dossiers may have partial profiles.
 */
export interface PsychProfile {
  disc?: string;           // "D" | "I" | "S" | "C"
  mbti?: string;           // "INTJ" | "ENFP" | etc.
  vossType?: string;       // "Analyst" | "Accommodator" | "Assertive"
  enneagram?: string;      // "1"-"9"
  warmthLevel?: string;    // "low" | "medium" | "high"
  dominantStyle?: string;  // free text — primary behavioral style
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
  before: Partial<PsychProfile & { warmthLevel: string; dominantStyle: string }>;
  /** New values detected from behavioral signals */
  after: Partial<PsychProfile & { warmthLevel: string; dominantStyle: string }>;
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

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum confidence for a psychographic delta to be considered meaningful.
 * Below this threshold, computePsychographicDelta returns null.
 * Set conservatively — one message is weak signal.
 */
export const DELTA_THRESHOLD = 0.35;

/** Style transition confidence scores — how significant is the shift? */
const STYLE_SHIFT_CONFIDENCE: Record<string, number> = {
  "Analyst→Accommodator":  0.70,
  "Analyst→Assertive":     0.65,
  "Accommodator→Assertive": 0.65,
  "Accommodator→Analyst":  0.70,
  "Assertive→Accommodator": 0.75,
  "Assertive→Analyst":     0.60,
};

/** Warmth level numeric values for comparison */
const WARMTH_VALUES: Record<string, number> = {
  low: 0, medium: 1, high: 2,
};

// ============================================================================
// Public API
// ============================================================================

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
export async function onNewContactSignal(
  contactId: number,
  content: ExtractedContent,
  dossier: DossierRecord | null,
  llm: LlmClient,
): Promise<ContactDelta | null> {
  try {
    // No dossier = no baseline to compare against
    if (!dossier) return null;

    // Extract behavioral signals from new message
    const signals = await extractBehavioralSignals(content.text, [], llm);
    if (!signals) return null;

    // Extract existing psychographic profile from dossier metadata
    const existingProfile = extractProfileFromDossier(dossier);

    // Compute delta
    const delta = computePsychographicDelta(existingProfile, signals);

    // Build summary
    const summary = buildDeltaSummary(dossier.title, signals, delta);
    const confidence = delta?.confidence ?? computeSignalConfidence(signals);

    return {
      contactId,
      sourceId: content.sourceId,
      summary,
      delta,
      signals,
      confidence,
    };
  } catch {
    return null;
  }
}

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
export async function extractBehavioralSignals(
  text: string,
  context: string[],
  llm: LlmClient,
): Promise<BehavioralSignals | null> {
  try {
    const contextBlock = context.length > 0
      ? `\nPrior messages for context (most recent last):\n${context.slice(-3).map((m, i) => `[${i + 1}] ${m.slice(0, 200)}`).join("\n")}\n`
      : "";

    const prompt = `You are analyzing a message for behavioral signals that reveal communication style, personality, and relationship dynamics.

Analyze the following message and return a JSON object with these fields:
- deferenceSignals: string[] — phrases or patterns showing deference to others (e.g., "as you mentioned", agreeing without pushback)
- commitmentLanguage: string[] — explicit commitment phrases (shall, agree, will, must, commit)
- toneShifts: string[] — points where tone changed (e.g., "became more formal", "opened up personally")
- unexpectedTopics: string[] — topics raised unexpectedly given context
- silenceOn: string[] — topics conspicuously absent that you'd expect given context
- dominantStyle: string — one of: "Analyst" (data-focused, precise), "Accommodator" (warm, relationship-focused), "Assertive" (direct, results-focused), "Mixed"
- warmthLevel: string — one of: "low", "medium", "high"
- urgencyLevel: string — one of: "low", "medium", "high"
${contextBlock}
Message to analyze:
${text.slice(0, 1500)}

Respond with ONLY a valid JSON object. No explanation.`;

    const response = await llm.complete(prompt);

    // Strip thinking blocks if present
    const cleaned = response
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();

    // Extract JSON — find first { ... } block
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<BehavioralSignals>;

    return {
      deferenceSignals:    Array.isArray(parsed.deferenceSignals)    ? parsed.deferenceSignals    : [],
      commitmentLanguage:  Array.isArray(parsed.commitmentLanguage)  ? parsed.commitmentLanguage  : [],
      toneShifts:          Array.isArray(parsed.toneShifts)          ? parsed.toneShifts          : [],
      unexpectedTopics:    Array.isArray(parsed.unexpectedTopics)    ? parsed.unexpectedTopics    : [],
      silenceOn:           Array.isArray(parsed.silenceOn)           ? parsed.silenceOn           : [],
      dominantStyle:  typeof parsed.dominantStyle  === "string" ? parsed.dominantStyle  : "Mixed",
      warmthLevel:    typeof parsed.warmthLevel    === "string" ? parsed.warmthLevel    : "medium",
      urgencyLevel:   typeof parsed.urgencyLevel   === "string" ? parsed.urgencyLevel   : "medium",
    };
  } catch {
    return null;
  }
}

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
export function computePsychographicDelta(
  existing: PsychProfile,
  signals: BehavioralSignals,
): PsychDelta | null {
  const changedDimensions: string[] = [];
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  let maxConfidence = 0;

  // Check dominant style shift
  const existingStyle = existing.dominantStyle ?? existing.vossType;
  const newStyle = signals.dominantStyle;

  if (existingStyle && newStyle && existingStyle !== newStyle && newStyle !== "Mixed") {
    const key = `${existingStyle}→${newStyle}`;
    const confidence = STYLE_SHIFT_CONFIDENCE[key] ?? 0.40;
    if (confidence >= DELTA_THRESHOLD) {
      changedDimensions.push("dominantStyle");
      before["dominantStyle"] = existingStyle;
      after["dominantStyle"] = newStyle;
      maxConfidence = Math.max(maxConfidence, confidence);
    }
  }

  // Check warmth level shift
  const existingWarmth = existing.warmthLevel ?? deriveWarmthFromDisc(existing.disc);
  const newWarmth = signals.warmthLevel;

  if (existingWarmth && newWarmth) {
    const existingVal = WARMTH_VALUES[existingWarmth.toLowerCase()] ?? 1;
    const newVal = WARMTH_VALUES[newWarmth.toLowerCase()] ?? 1;
    const delta = Math.abs(newVal - existingVal);

    if (delta >= 2) {
      // Jump of 2 (low→high or high→low) = meaningful
      const confidence = 0.55;
      changedDimensions.push("warmthLevel");
      before["warmthLevel"] = existingWarmth;
      after["warmthLevel"] = newWarmth;
      maxConfidence = Math.max(maxConfidence, confidence);
    } else if (delta === 1) {
      // Adjacent shift (low→medium, etc.) = minor, lower confidence
      const confidence = 0.30;
      if (confidence >= DELTA_THRESHOLD) {
        changedDimensions.push("warmthLevel");
        before["warmthLevel"] = existingWarmth;
        after["warmthLevel"] = newWarmth;
        maxConfidence = Math.max(maxConfidence, confidence);
      }
    }
  }

  if (changedDimensions.length === 0 || maxConfidence < DELTA_THRESHOLD) return null;

  const summary = buildShiftSummary(changedDimensions, before, after);

  return {
    summary,
    changedDimensions,
    confidence: maxConfidence,
    before,
    after,
  };
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Extract psychographic profile from dossier metadata.
 * Falls back to parsing content text if metadata is sparse.
 */
function extractProfileFromDossier(dossier: DossierRecord): PsychProfile {
  const meta = dossier.metadata ?? {};
  return {
    disc:          typeof meta.disc          === "string" ? meta.disc          : undefined,
    mbti:          typeof meta.mbti          === "string" ? meta.mbti          : undefined,
    vossType:      typeof meta.voss_type     === "string" ? meta.voss_type     : undefined,
    enneagram:     typeof meta.enneagram     === "string" ? meta.enneagram     : undefined,
    warmthLevel:   typeof meta.warmth_level  === "string" ? meta.warmth_level  : undefined,
    dominantStyle: typeof meta.dominantStyle === "string" ? meta.dominantStyle : undefined,
  };
}

/**
 * Derive rough warmth level from DISC type when not explicitly set.
 * D/C = analytical = low warmth; I/S = relational = high warmth
 */
function deriveWarmthFromDisc(disc?: string): string | undefined {
  if (!disc) return undefined;
  if (disc === "I" || disc === "S") return "high";
  if (disc === "D" || disc === "C") return "low";
  return "medium";
}

/**
 * Build a human-readable summary of detected dimension shifts.
 */
function buildShiftSummary(
  dimensions: string[],
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const parts = dimensions.map((dim) => `${dim}: ${before[dim]} → ${after[dim]}`);
  return `Profile shift detected: ${parts.join("; ")}`;
}

/**
 * Build a ContactDelta summary line from available signals and delta.
 */
function buildDeltaSummary(
  contactTitle: string,
  signals: BehavioralSignals,
  delta: PsychDelta | null,
): string {
  const name = contactTitle.split(/\s+[—–-]\s+/)[0].trim();
  if (delta) return `${name}: ${delta.summary}`;
  const highlights: string[] = [];
  if (signals.commitmentLanguage.length > 0) highlights.push("new commitment language");
  if (signals.toneShifts.length > 0) highlights.push("tone shift");
  if (signals.unexpectedTopics.length > 0) highlights.push("unexpected topic");
  return highlights.length > 0
    ? `${name}: behavioral signals — ${highlights.join(", ")}`
    : `${name}: new message signal recorded`;
}

/**
 * Compute a confidence score from behavioral signals alone (no profile shift).
 * Used when signals exist but don't cross the delta threshold.
 */
function computeSignalConfidence(signals: BehavioralSignals): number {
  let score = 0.1;
  if (signals.commitmentLanguage.length > 0) score += 0.15 * Math.min(signals.commitmentLanguage.length, 3);
  if (signals.toneShifts.length > 0) score += 0.10;
  if (signals.unexpectedTopics.length > 0) score += 0.10;
  if (signals.deferenceSignals.length > 0) score += 0.05;
  return Math.min(score, 0.90);
}
