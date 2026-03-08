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
// ============================================================================
// Tier enum
// ============================================================================
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
export var LlmTier;
(function (LlmTier) {
    LlmTier["FLASH"] = "flash";
    LlmTier["STANDARD"] = "standard";
    LlmTier["DEEP"] = "deep";
    LlmTier["MASSIVE"] = "massive";
})(LlmTier || (LlmTier = {}));
/** Minimum context window (tokens) required for each tier. */
const TIER_MIN_CONTEXT = {
    [LlmTier.FLASH]: 1, // any model qualifies for FLASH
    [LlmTier.STANDARD]: 16_000, // must support at least 16K
    [LlmTier.DEEP]: 64_000, // must support at least 64K
    [LlmTier.MASSIVE]: 500_000, // must support at least 500K
};
// ============================================================================
// LlmRoutingError
// ============================================================================
/**
 * Thrown when all eligible models for the requested tier have failed.
 * Callers can catch this to implement their own fallback (e.g., skip scoring,
 * return a default value, or surface an error to the user).
 */
export class LlmRoutingError extends Error {
    tier;
    attempted;
    lastError;
    /**
     * @param tier      - The tier that was requested
     * @param attempted - Model ids that were tried (empty if no eligible model existed)
     * @param lastError - The error from the last attempted model (or a pre-flight error)
     */
    constructor(tier, attempted, lastError) {
        const summary = attempted.length === 0
            ? `No eligible model for tier ${tier}`
            : `All models failed for tier ${tier}: [${attempted.join(", ")}]`;
        super(summary);
        this.tier = tier;
        this.attempted = attempted;
        this.lastError = lastError;
        this.name = "LlmRoutingError";
    }
}
// ============================================================================
// Default HttpClient (fetch-based)
// ============================================================================
/**
 * Production HttpClient implementation using the global fetch API.
 * Throws on non-2xx responses with status code in the error message.
 */
const defaultHttpClient = {
    async post(url, body, headers) {
        const response = await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${url}`);
        }
        const text = await response.text();
        return { text };
    },
};
// ============================================================================
// LlmRouter
// ============================================================================
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
export class LlmRouter {
    http;
    logger;
    models;
    timeoutMs;
    constructor(config, http = defaultHttpClient, logger) {
        this.http = http;
        this.logger = logger;
        this.models = config.models;
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }
    // --------------------------------------------------------------------------
    // Public API
    // --------------------------------------------------------------------------
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
    async run(task) {
        const eligible = this.selectModels(task.tier);
        if (eligible.length === 0) {
            throw new LlmRoutingError(task.tier, [], new Error(`No model covers tier ${task.tier}`));
        }
        const attempted = [];
        let lastError = new Error("unknown");
        for (const model of eligible) {
            try {
                const result = await this.callModel(model, task);
                this.logger?.info(`[llm-router] ${model.label} → ok (tier=${task.tier})`);
                return result;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                attempted.push(model.id);
                this.logger?.warn(`[llm-router] ${model.label} failed: ${lastError.message}${eligible.indexOf(model) < eligible.length - 1 ? " — trying next" : ""}`);
            }
        }
        throw new LlmRoutingError(task.tier, attempted, lastError);
    }
    /**
     * Backward-compatible shorthand for FLASH-tier text completion.
     * All existing callers that use complete() get correct FLASH-tier routing
     * without any changes.
     *
     * @param prompt - Full prompt string
     * @returns      - Raw completion text
     * @throws       - LlmRoutingError if no FLASH-eligible model
     */
    async complete(prompt) {
        return this.run({ prompt, tier: LlmTier.FLASH, outputFormat: "text" });
    }
    // --------------------------------------------------------------------------
    // Private helpers
    // --------------------------------------------------------------------------
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
    selectModels(tier) {
        const minContext = TIER_MIN_CONTEXT[tier];
        return this.models
            .map((m, idx) => ({ m, idx }))
            .filter(({ m }) => m.contextWindow >= minContext)
            .sort((a, b) => a.m.priority - b.m.priority || a.idx - b.idx)
            .map(({ m }) => m);
    }
    /**
     * Call a single model with the given task.
     * Applies timeout, builds request body, sends HTTP request, parses response.
     *
     * @param model - The model to call
     * @param task  - Task spec
     * @returns     - Raw completion text
     * @throws      - On HTTP error, timeout, or malformed response
     */
    async callModel(model, task) {
        const body = this.buildRequestBody(model, task);
        const headers = this.buildHeaders(model);
        const callPromise = this.http.post(model.baseUrl, body, headers);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${this.timeoutMs}ms`)), this.timeoutMs));
        const response = await Promise.race([callPromise, timeoutPromise]);
        return this.parseResponse(response.text);
    }
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
    buildRequestBody(model, task) {
        const maxTokens = Math.min(task.maxTokens ?? model.outputLimit, model.outputLimit);
        const body = {
            model: model.id,
            messages: [{ role: "user", content: task.prompt }],
            max_tokens: maxTokens,
        };
        // JSON mode — only when model supports it
        if (task.outputFormat === "json" && model.supportsJsonMode) {
            body.response_format = { type: "json_object" };
        }
        // Qwen3 thinking suppression — only for Qwen3 models when explicitly requested
        if (task.disableThinking === true && model.isQwen3) {
            body.chat_template_kwargs = { enable_thinking: false };
        }
        return body;
    }
    /**
     * Build HTTP request headers for a model.
     *
     * @param model - Model config with apiKey
     * @returns     - Headers object with Authorization and Content-Type
     */
    buildHeaders(model) {
        return {
            "Authorization": `Bearer ${model.apiKey}`,
            "Content-Type": "application/json",
        };
    }
    /**
     * Parse the raw JSON response text from an OpenAI-compatible API.
     * Throws on missing/null content so the caller can trigger fallback.
     *
     * @param text - Raw response body string
     * @returns    - Completion text from choices[0].message.content
     * @throws     - If response is malformed or content is missing/null
     */
    parseResponse(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new Error(`Invalid JSON response: ${text.slice(0, 100)}`);
        }
        const choices = parsed?.choices;
        if (!Array.isArray(choices) || choices.length === 0) {
            throw new Error("Response missing choices array");
        }
        const content = choices[0]?.message;
        const text2 = content?.content;
        if (text2 === null || text2 === undefined) {
            throw new Error("Response choices[0].message.content is null or missing");
        }
        return String(text2);
    }
}
//# sourceMappingURL=llm-router.js.map