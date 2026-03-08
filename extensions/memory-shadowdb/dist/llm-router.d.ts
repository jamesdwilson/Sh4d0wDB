/**
 * llm-router.ts — Tiered LLM model routing
 *
 * Replaces the flat LlmClient interface with a tier-aware router that:
 *   1. Selects the highest-priority eligible model for the requested tier
 *   2. Builds the correct OpenAI-compatible request body (JSON mode, Qwen3
 *      thinking suppression, maxTokens clamping)
 *   3. Walks the fallback chain on any failure (HTTP error, timeout, bad response)
 *   4. Throws LlmRoutingError (typed, catchable) when all models fail
 *
 * Design rules:
 *   - Tasks declare requirements (tier, format). Router picks the model.
 *   - Tier is a MINIMUM. Upward promotion is OK (STANDARD serving FLASH).
 *     Downward demotion is FORBIDDEN — silently truncates input.
 *   - complete(prompt) is always FLASH tier — backward compat with all callers.
 *   - No global state. All dependencies injected. Tests never hit real endpoints.
 *
 * See: ARCHITECTURE.md § 2, INTELLIGENCE_ROADMAP.md § llm-router TDD Spec
 */
import type { LlmClient } from "./phase1-scoring.js";
/**
 * Context window tiers — ordered smallest to largest.
 * A task at tier T may run on any model whose contextWindow covers T.
 *
 * Approximate window sizes (informational — actual selection uses contextWindow field):
 *   FLASH    ≤  4K tokens  — scoring, classification, single-fact extraction
 *   STANDARD ≤ 32K tokens  — behavioral analysis, summarization, entity extraction
 *   DEEP     ≤ 128K tokens — cross-reference, dossier synthesis, network analysis
 *   MASSIVE  ≤ 1M  tokens  — full corpus analysis (future use)
 */
export declare enum LlmTier {
    FLASH = "flash",
    STANDARD = "standard",
    DEEP = "deep",
    MASSIVE = "massive"
}
/**
 * A task submitted to the router.
 * The caller declares what it needs; the router decides which model to use.
 */
export interface LlmTask {
    /** The full prompt to send. */
    prompt: string;
    /**
     * Minimum context tier required. Router will never use a model whose
     * context window is smaller than this tier's minimum.
     */
    tier: LlmTier;
    /**
     * Expected output format.
     * "text"   — free-form text (default)
     * "json"   — structured JSON; enables response_format if model supports it
     * "number" — single number; currently treated the same as "text"
     */
    outputFormat?: "text" | "json" | "number";
    /**
     * Maximum completion tokens. Clamped to model's outputLimit if exceeded.
     * Omit to use the model's full outputLimit.
     */
    maxTokens?: number;
    /**
     * If true and the model is a Qwen3 family model, suppresses chain-of-thought
     * via chat_template_kwargs: { enable_thinking: false }.
     * Has no effect on non-Qwen3 models.
     */
    disableThinking?: boolean;
}
/**
 * Configuration for one model in the router's pool.
 * Each model entry defines capability, routing weight, and API access.
 */
export interface ModelConfig {
    /** OpenAI-compatible model name sent in the `model` field of every request. */
    id: string;
    /** Human-readable label used in log messages. */
    label: string;
    /** Base URL of the OpenAI-compatible API endpoint (e.g. "http://localhost:8000/v1"). */
    baseUrl: string;
    /** API key sent as Bearer token in Authorization header. */
    apiKey: string;
    /**
     * Maximum tokens this model can process in a single request (input + output).
     * Used to determine tier eligibility: model qualifies for a tier if
     * contextWindow >= TIER_MIN_CONTEXT[tier].
     */
    contextWindow: number;
    /**
     * Maximum completion tokens this model will generate.
     * task.maxTokens is clamped to this value before sending.
     */
    outputLimit: number;
    /**
     * The tier this model is optimized for.
     * Used for model selection preference — a STANDARD model is preferred over
     * a DEEP model for STANDARD tasks even if both are eligible.
     */
    tier: LlmTier;
    /**
     * Whether this model supports response_format: { type: "json_object" }.
     * If false, the router suppresses response_format even when outputFormat is "json".
     */
    supportsJsonMode: boolean;
    /**
     * Whether this is a Qwen3-family model.
     * If true and disableThinking is set, the router adds:
     *   chat_template_kwargs: { enable_thinking: false }
     */
    isQwen3: boolean;
    /**
     * Selection priority within eligible models. Lower = preferred.
     * Models with equal priority are sorted by position in config array (stable).
     */
    priority: number;
}
/** The full pool configuration passed to LlmRouter constructor. */
export interface LlmRouterConfig {
    /** All available models. Router selects from this pool per task. */
    models: ModelConfig[];
    /**
     * Per-request timeout in milliseconds.
     * A hanging model triggers fallback after this duration.
     * Default: 30000.
     */
    timeoutMs?: number;
}
/**
 * Injectable HTTP client — real implementation uses fetch; tests use mocks.
 * Keeps all network I/O out of the router's core logic.
 */
export interface HttpClient {
    /**
     * POST a JSON body to the given URL with the provided headers.
     * Returns { text } where text is the raw response body string.
     * Should throw on non-2xx responses or network failures.
     *
     * @param url     - Full endpoint URL
     * @param body    - Request body (will be JSON.stringify'd by caller)
     * @param headers - HTTP headers including Authorization and Content-Type
     */
    post(url: string, body: unknown, headers: Record<string, string>): Promise<{
        text: string;
    }>;
}
/**
 * Optional logger injected into LlmRouter for diagnostics.
 * Omitting the logger is safe — the router checks before calling.
 */
export interface RouterLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/**
 * Extended LLM client interface with tier-aware routing.
 * Extends LlmClient so any code that accepts LlmClient also accepts TieredLlmClient.
 * complete() is preserved for backward compatibility — routes to FLASH tier.
 */
export interface TieredLlmClient extends LlmClient {
    /**
     * Execute an LLM task with automatic model selection based on tier.
     * Returns raw completion text. Throws LlmRoutingError if all models fail.
     */
    run(task: LlmTask): Promise<string>;
    /**
     * Backward-compatible shorthand. Equivalent to:
     *   run({ prompt, tier: LlmTier.FLASH, outputFormat: "text" })
     * All existing callers that use complete() automatically get FLASH-tier routing.
     */
    complete(prompt: string): Promise<string>;
}
/**
 * Thrown when all eligible models for the requested tier have failed.
 * Callers can catch this to implement their own fallback (e.g., skip scoring,
 * return a default value, or surface an error to the user).
 */
export declare class LlmRoutingError extends Error {
    readonly tier: LlmTier;
    readonly attempted: string[];
    readonly lastError: Error;
    /**
     * @param tier      - The tier that was requested
     * @param attempted - Model ids that were tried (empty if no eligible model existed)
     * @param lastError - The error from the last attempted model (or a pre-flight error)
     */
    constructor(tier: LlmTier, attempted: string[], lastError: Error);
}
/**
 * Tiered LLM router — implements TieredLlmClient.
 *
 * Usage:
 *   const router = new LlmRouter({
 *     models: [
 *       { id: "qwen3.5-35b-a3b-4bit", tier: LlmTier.FLASH, priority: 0, ... },
 *     ],
 *   });
 *   const score = await router.run({ prompt: "Rate this...", tier: LlmTier.FLASH, disableThinking: true });
 *   const analysis = await router.run({ prompt: "Analyze...", tier: LlmTier.DEEP, outputFormat: "json" });
 */
export declare class LlmRouter implements TieredLlmClient {
    private readonly http;
    private readonly logger?;
    private readonly models;
    readonly timeoutMs: number;
    constructor(config: LlmRouterConfig, http?: HttpClient, logger?: RouterLogger | undefined);
    /**
     * Execute an LLM task with automatic model selection.
     *
     * Selection algorithm:
     *   1. Filter to models whose contextWindow >= TIER_MIN_CONTEXT[task.tier]
     *   2. Sort by priority asc, then by position in config array (stable)
     *   3. If empty → throw LlmRoutingError with empty attempted list
     *   4. Try models in order; on failure add to attempted and continue
     *   5. If all fail → throw LlmRoutingError with full attempted list
     *
     * @param task - Task spec with prompt, tier, and optional formatting hints
     * @returns    - Raw completion text from the first successful model
     * @throws     - LlmRoutingError if no eligible model or all attempts fail
     */
    run(task: LlmTask): Promise<string>;
    /**
     * Backward-compatible shorthand for FLASH-tier text completion.
     * All existing callers that use complete() get correct FLASH-tier routing
     * without any changes.
     *
     * @param prompt - Full prompt string
     * @returns      - Raw completion text
     * @throws       - LlmRoutingError if no FLASH-eligible model
     */
    complete(prompt: string): Promise<string>;
    /**
     * Return all models eligible for the given tier, sorted by priority then
     * by original config position (stable sort).
     *
     * A model is eligible if its contextWindow >= TIER_MIN_CONTEXT[tier].
     * This enforces the "no downward demotion" rule — a 4K model cannot serve
     * a DEEP task even if it's the only model in the pool.
     *
     * @param tier - Minimum tier required
     * @returns    - Sorted eligible models (may be empty)
     */
    private selectModels;
    /**
     * Call a single model with the given task.
     * Applies timeout, builds request body, sends HTTP request, parses response.
     *
     * @param model - The model to call
     * @param task  - Task spec
     * @returns     - Raw completion text
     * @throws      - On HTTP error, timeout, or malformed response
     */
    private callModel;
    /**
     * Build the OpenAI-compatible request body for a model + task combination.
     *
     * Applies:
     *   - maxTokens clamping to model.outputLimit
     *   - response_format: json_object only when model.supportsJsonMode
     *   - chat_template_kwargs only for Qwen3 models when disableThinking is set
     *
     * @param model - Selected model config
     * @param task  - Task spec
     * @returns     - Request body object (will be JSON.stringify'd by HttpClient)
     */
    private buildRequestBody;
    /**
     * Build HTTP request headers for a model.
     *
     * @param model - Model config with apiKey
     * @returns     - Headers object with Authorization and Content-Type
     */
    private buildHeaders;
    /**
     * Parse the raw JSON response text from an OpenAI-compatible API.
     * Throws on missing/null content so the caller can trigger fallback.
     *
     * @param text - Raw response body string
     * @returns    - Completion text from choices[0].message.content
     * @throws     - If response is malformed or content is missing/null
     */
    private parseResponse;
}
