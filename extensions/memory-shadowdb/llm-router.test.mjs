/**
 * llm-router.test.mjs — TDD test suite for LlmRouter
 *
 * Tests the tiered model routing system described in ARCHITECTURE.md and
 * INTELLIGENCE_ROADMAP.md § "llm-router — Full TDD Spec".
 *
 * Design philosophy under test:
 *   - Tasks declare what they need (tier + format). Router decides which model.
 *   - Tier is a MINIMUM. Upward promotion (FLASH task on STANDARD model) is OK.
 *     Downward demotion (DEEP task on FLASH model) is FORBIDDEN — it silently truncates.
 *   - Fallback chain: if the preferred model fails, try next in priority order.
 *     If all fail, throw LlmRoutingError (typed, catchable).
 *   - complete(prompt) is FLASH tier — backward compat with all existing callers.
 *   - No global state. No hardcoded model names in business logic. All I/O injectable.
 *
 * Test groups:
 *   A — LlmTier enum shape
 *   B — Model selection logic (pure, no HTTP)
 *   C — HTTP call construction (mock HTTP)
 *   D — Response parsing
 *   E — Fallback chain behavior
 *   F — complete() backward compat
 *   G — Timeout handling
 *   H — Logging
 *
 * All HTTP calls go through an injectable HttpClient. Tests never hit real endpoints.
 * All assertions use node:assert/strict — no third-party test framework.
 *
 * Run: node --test llm-router.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmTier,
  LlmRoutingError,
  LlmRouter,
} from './dist/llm-router.js';

// ============================================================================
// Test Fixtures & Helpers
// ============================================================================

/**
 * Build a minimal ModelConfig for a given tier.
 * Overrides allow per-test customization without repetition.
 *
 * @param {Partial<import('./dist/llm-router.js').ModelConfig>} overrides
 * @returns {import('./dist/llm-router.js').ModelConfig}
 */
function model(overrides = {}) {
  return {
    id: 'test-model',
    label: 'Test Model',
    baseUrl: 'http://localhost:9999/v1',
    apiKey: 'test-key',
    contextWindow: 32_000,
    outputLimit: 4_096,
    tier: LlmTier.FLASH,
    supportsJsonMode: true,
    isQwen3: false,
    priority: 0,
    ...overrides,
  };
}

/**
 * Build a router config with a single model.
 * The default model is FLASH tier with a mock base URL.
 *
 * @param {import('./dist/llm-router.js').ModelConfig[]} models
 * @param {number} [timeoutMs]
 */
function routerConfig(models, timeoutMs = 5_000) {
  return { models, timeoutMs };
}

/**
 * Build a minimal LlmTask.
 * Defaults to FLASH tier, text output, short prompt.
 *
 * @param {Partial<import('./dist/llm-router.js').LlmTask>} overrides
 */
function task(overrides = {}) {
  return {
    prompt: 'Test prompt',
    tier: LlmTier.FLASH,
    ...overrides,
  };
}

/**
 * Build a mock HttpClient that always succeeds.
 * Records every call so tests can assert on request shape.
 *
 * @param {string} [content] - The completion text to return
 * @returns {{ client: import('./dist/llm-router.js').HttpClient, calls: object[] }}
 */
function mockHttp(content = 'mock response') {
  const calls = [];
  const client = {
    post: async (url, body, headers) => {
      calls.push({ url, body, headers });
      return {
        text: JSON.stringify({
          choices: [{ message: { content } }],
        }),
      };
    },
  };
  return { client, calls };
}

/**
 * Build an HttpClient that always rejects with the given error.
 * Used to test fallback chain behavior.
 *
 * @param {Error|string} [err]
 */
function failingHttp(err = new Error('HTTP failure')) {
  const error = typeof err === 'string' ? new Error(err) : err;
  return {
    post: async () => { throw error; },
  };
}

/**
 * Build an HttpClient that rejects on the first N calls, then succeeds.
 * Used to test partial-fallback scenarios.
 *
 * @param {number} failCount - How many calls to fail before succeeding
 * @param {string} [content] - Completion text for the successful call
 */
function failThenSucceedHttp(failCount, content = 'recovered response') {
  let callCount = 0;
  const calls = [];
  const client = {
    post: async (url, body, headers) => {
      calls.push({ url, body, headers });
      callCount++;
      if (callCount <= failCount) {
        throw new Error(`Simulated failure on call ${callCount}`);
      }
      return {
        text: JSON.stringify({
          choices: [{ message: { content } }],
        }),
      };
    },
  };
  return { client, calls };
}

/**
 * Capture logger calls for Group H tests.
 * Returns { logger, logs } where logs accumulates { level, message } entries.
 */
function captureLogger() {
  const logs = [];
  const logger = {
    info:  (msg) => logs.push({ level: 'info', message: msg }),
    warn:  (msg) => logs.push({ level: 'warn', message: msg }),
    error: (msg) => logs.push({ level: 'error', message: msg }),
  };
  return { logger, logs };
}

// ============================================================================
// Group A — LlmTier enum shape
// ============================================================================

test('A1: LlmTier has exactly FLASH, STANDARD, DEEP, MASSIVE values', () => {
  // Guards against accidental removal or rename of tiers.
  // The enum order matters — tiers are ranked FLASH < STANDARD < DEEP < MASSIVE.
  assert.equal(LlmTier.FLASH,    'flash');
  assert.equal(LlmTier.STANDARD, 'standard');
  assert.equal(LlmTier.DEEP,     'deep');
  assert.equal(LlmTier.MASSIVE,  'massive');
});

test('A2: LlmTier values are stable strings, not numbers', () => {
  // If tiers were numeric enums, runtime comparison bugs would be silent.
  // String values make mismatches immediately visible in logs and errors.
  for (const value of Object.values(LlmTier)) {
    assert.equal(typeof value, 'string', `LlmTier.${value} should be a string`);
  }
});

// ============================================================================
// Group B — Model selection (pure, no HTTP required)
// ============================================================================

test('B1: Single FLASH model is selected for a FLASH task', async () => {
  // Simplest case — one model, one tier, exact match.
  const { client, calls } = mockHttp('result');
  const router = new LlmRouter(routerConfig([model({ tier: LlmTier.FLASH })]), client);
  await router.run(task({ tier: LlmTier.FLASH }));
  assert.equal(calls.length, 1, 'should have made exactly one HTTP call');
  const body = calls[0].body;
  assert.equal(body.model, 'test-model');
});

test('B2: Single STANDARD model is selected for a STANDARD task', async () => {
  const { client, calls } = mockHttp('result');
  const router = new LlmRouter(routerConfig([model({ id: 'std-model', tier: LlmTier.STANDARD })]), client);
  await router.run(task({ tier: LlmTier.STANDARD }));
  assert.equal(calls[0].body.model, 'std-model');
});

test('B3: STANDARD model satisfies DEEP task when no DEEP model is configured (upward promotion)', async () => {
  // A model with a larger context window than the tier minimum can serve higher-tier tasks.
  // This is the "upward promotion" rule — bigger is OK.
  const { client, calls } = mockHttp('result');
  const largeStandard = model({
    id: 'large-standard',
    tier: LlmTier.STANDARD,
    contextWindow: 200_000, // large enough to handle DEEP tasks
  });
  const router = new LlmRouter(routerConfig([largeStandard]), client);
  await router.run(task({ tier: LlmTier.DEEP }));
  // Should succeed — upward promotion allowed
  assert.equal(calls[0].body.model, 'large-standard');
});

test('B4: FLASH model must NOT satisfy a DEEP task (downward demotion forbidden)', async () => {
  // A FLASH model (small context) cannot serve a DEEP task without silently truncating.
  // The router must reject this — throw LlmRoutingError, not silently call a tiny model.
  const { client } = mockHttp('result');
  const flashOnly = model({
    id: 'flash-only',
    tier: LlmTier.FLASH,
    contextWindow: 4_000, // too small for DEEP
  });
  const router = new LlmRouter(routerConfig([flashOnly]), client);
  await assert.rejects(
    () => router.run(task({ tier: LlmTier.DEEP })),
    (err) => {
      assert.ok(err instanceof LlmRoutingError, 'should throw LlmRoutingError');
      assert.equal(err.tier, LlmTier.DEEP);
      return true;
    },
  );
});

test('B5: Two FLASH models — lower priority number wins', async () => {
  // Priority 0 is preferred over priority 1.
  // This allows deploying a fast local model (priority 0) with a cloud fallback (priority 1).
  const { client, calls } = mockHttp('result');
  const preferred = model({ id: 'preferred', tier: LlmTier.FLASH, priority: 0 });
  const fallback  = model({ id: 'fallback',  tier: LlmTier.FLASH, priority: 1 });
  const router = new LlmRouter(routerConfig([fallback, preferred]), client); // intentionally out of order
  await router.run(task({ tier: LlmTier.FLASH }));
  assert.equal(calls[0].body.model, 'preferred', 'priority 0 should be tried first');
});

test('B6: Two FLASH models with same priority — first in config array wins (stable ordering)', async () => {
  // Deterministic selection — same config always produces same model choice.
  const { client, calls } = mockHttp('result');
  const first  = model({ id: 'first-model',  tier: LlmTier.FLASH, priority: 0 });
  const second = model({ id: 'second-model', tier: LlmTier.FLASH, priority: 0 });
  const router = new LlmRouter(routerConfig([first, second]), client);
  await router.run(task({ tier: LlmTier.FLASH }));
  assert.equal(calls[0].body.model, 'first-model');
});

test('B7: No model covers the requested tier — throws LlmRoutingError before HTTP call', async () => {
  // When no eligible model exists, the router should fail fast — no HTTP calls made.
  const { client, calls } = mockHttp('result');
  const flashOnly = model({ tier: LlmTier.FLASH, contextWindow: 4_000 });
  const router = new LlmRouter(routerConfig([flashOnly]), client);
  await assert.rejects(
    () => router.run(task({ tier: LlmTier.MASSIVE })),
    LlmRoutingError,
  );
  assert.equal(calls.length, 0, 'no HTTP calls should be made when no eligible model exists');
});

test('B8: LlmRoutingError carries tier and empty attempted list when no model was eligible', async () => {
  const { client } = mockHttp();
  const flashOnly = model({ tier: LlmTier.FLASH, contextWindow: 4_000 });
  const router = new LlmRouter(routerConfig([flashOnly]), client);
  let caught;
  try {
    await router.run(task({ tier: LlmTier.MASSIVE }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LlmRoutingError);
  assert.equal(caught.tier, LlmTier.MASSIVE);
  // No models were attempted — error is pre-flight
  assert.equal(caught.attempted.length, 0, 'attempted list should be empty when no eligible model');
});

// ============================================================================
// Group C — HTTP call construction (mock HTTP)
// ============================================================================

test('C1: Prompt is sent as user message in the messages array', async () => {
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model()]), client);
  await router.run(task({ prompt: 'Hello world' }));
  const messages = calls[0].body.messages;
  assert.ok(Array.isArray(messages), 'messages should be an array');
  const userMsg = messages.find(m => m.role === 'user');
  assert.ok(userMsg, 'should have a user message');
  assert.equal(userMsg.content, 'Hello world');
});

test('C2: Model id is sent as the model field', async () => {
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model({ id: 'my-model-name' })]), client);
  await router.run(task());
  assert.equal(calls[0].body.model, 'my-model-name');
});

test('C3: maxTokens maps to max_tokens in request body', async () => {
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model()]), client);
  await router.run(task({ maxTokens: 256 }));
  assert.equal(calls[0].body.max_tokens, 256);
});

test('C4: maxTokens omitted — request uses model outputLimit', async () => {
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model({ outputLimit: 2_048 })]), client);
  await router.run(task()); // no maxTokens
  assert.equal(calls[0].body.max_tokens, 2_048);
});

test('C5: maxTokens exceeding outputLimit is clamped to outputLimit', async () => {
  // Prevents sending a max_tokens value the model will reject.
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model({ outputLimit: 1_024 })]), client);
  await router.run(task({ maxTokens: 99_999 }));
  assert.equal(calls[0].body.max_tokens, 1_024, 'should be clamped to outputLimit');
});

test('C6: outputFormat "json" + supportsJsonMode true → response_format sent', async () => {
  // JSON mode tells the model to guarantee valid JSON output.
  // Only request it when the model actually supports it.
  const { client, calls } = mockHttp('{"key":"value"}');
  const router = new LlmRouter(routerConfig([model({ supportsJsonMode: true })]), client);
  await router.run(task({ outputFormat: 'json' }));
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('C7: outputFormat "json" + supportsJsonMode false → NO response_format field', async () => {
  // Sending response_format to a model that doesn't support it causes an API error.
  // The router must suppress it silently.
  const { client, calls } = mockHttp('{"key":"value"}');
  const router = new LlmRouter(routerConfig([model({ supportsJsonMode: false })]), client);
  await router.run(task({ outputFormat: 'json' }));
  assert.equal(
    calls[0].body.response_format,
    undefined,
    'response_format should not be sent when model does not support JSON mode',
  );
});

test('C8: disableThinking true + isQwen3 true → chat_template_kwargs sent', async () => {
  // Qwen3 models emit <think>...</think> blocks by default.
  // For scoring tasks, thinking tokens waste budget and corrupt parseScore.
  // Suppress via chat_template_kwargs: { enable_thinking: false }.
  const { client, calls } = mockHttp('8');
  const router = new LlmRouter(routerConfig([model({ isQwen3: true })]), client);
  await router.run(task({ disableThinking: true }));
  assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: false });
});

test('C9: disableThinking true + isQwen3 false → NO chat_template_kwargs field', async () => {
  // Non-Qwen3 models don't understand chat_template_kwargs — sending it may cause errors.
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model({ isQwen3: false })]), client);
  await router.run(task({ disableThinking: true }));
  assert.equal(
    calls[0].body.chat_template_kwargs,
    undefined,
    'chat_template_kwargs should not be sent for non-Qwen3 models',
  );
});

test('C10: disableThinking omitted → no chat_template_kwargs regardless of isQwen3', async () => {
  // Only suppress thinking when explicitly requested — don't assume the caller wants it.
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model({ isQwen3: true })]), client);
  await router.run(task()); // no disableThinking
  assert.equal(calls[0].body.chat_template_kwargs, undefined);
});

test('C11: Authorization header is sent as Bearer token', async () => {
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model({ apiKey: 'secret-key-123' })]), client);
  await router.run(task());
  assert.equal(calls[0].headers['Authorization'], 'Bearer secret-key-123');
});

test('C12: Content-Type header is application/json', async () => {
  const { client, calls } = mockHttp('ok');
  const router = new LlmRouter(routerConfig([model()]), client);
  await router.run(task());
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

// ============================================================================
// Group D — Response parsing
// ============================================================================

test('D1: Well-formed response returns choices[0].message.content string', async () => {
  const { client } = mockHttp('The answer is 7');
  const router = new LlmRouter(routerConfig([model()]), client);
  const result = await router.run(task());
  assert.equal(result, 'The answer is 7');
});

test('D2: Empty choices array triggers fallback (treated as model failure)', async () => {
  // An empty choices array means the model returned nothing useful.
  // Router should treat this like a network failure — try the next model.
  const emptyChoicesHttp = {
    post: async () => ({ text: JSON.stringify({ choices: [] }) }),
  };
  const router = new LlmRouter(routerConfig([model()]), emptyChoicesHttp);
  await assert.rejects(() => router.run(task()), LlmRoutingError);
});

test('D3: Missing choices key triggers fallback', async () => {
  const malformedHttp = {
    post: async () => ({ text: JSON.stringify({ id: 'cmpl-123' }) }),
  };
  const router = new LlmRouter(routerConfig([model()]), malformedHttp);
  await assert.rejects(() => router.run(task()), LlmRoutingError);
});

test('D4: Null content in choices[0].message triggers fallback', async () => {
  const nullContentHttp = {
    post: async () => ({ text: JSON.stringify({ choices: [{ message: { content: null } }] }) }),
  };
  const router = new LlmRouter(routerConfig([model()]), nullContentHttp);
  await assert.rejects(() => router.run(task()), LlmRoutingError);
});

test('D5: Extra fields in response are ignored (resilient to API version drift)', async () => {
  // Future API versions may add fields. Router must not crash on unexpected keys.
  const extraFieldsHttp = {
    post: async () => ({
      text: JSON.stringify({
        id: 'cmpl-xyz',
        object: 'chat.completion',
        created: 1234567890,
        model: 'some-model',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        choices: [{ message: { role: 'assistant', content: 'clean result' }, finish_reason: 'stop', index: 0 }],
      }),
    }),
  };
  const router = new LlmRouter(routerConfig([model()]), extraFieldsHttp);
  const result = await router.run(task());
  assert.equal(result, 'clean result');
});

// ============================================================================
// Group E — Fallback chain behavior
// ============================================================================

test('E1: First model returns HTTP 500 → second model tried → success', async () => {
  // This is the core fallback scenario: local model is down, cloud backup succeeds.
  const { client, calls } = failThenSucceedHttp(1, 'fallback succeeded');
  const primary  = model({ id: 'primary',  tier: LlmTier.FLASH, priority: 0 });
  const fallback = model({ id: 'fallback', tier: LlmTier.FLASH, priority: 1 });
  const router = new LlmRouter(routerConfig([primary, fallback]), client);
  const result = await router.run(task());
  assert.equal(result, 'fallback succeeded');
  assert.equal(calls.length, 2, 'should have tried both models');
});

test('E2: First model throws network error → second model tried → success', async () => {
  let callCount = 0;
  const client = {
    post: async (url, body) => {
      callCount++;
      if (callCount === 1) throw new Error('ECONNREFUSED');
      return { text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
    },
  };
  const primary  = model({ id: 'primary',  tier: LlmTier.FLASH, priority: 0 });
  const fallback = model({ id: 'fallback', tier: LlmTier.FLASH, priority: 1 });
  const router = new LlmRouter(routerConfig([primary, fallback]), client);
  const result = await router.run(task());
  assert.equal(result, 'ok');
});

test('E3: All models fail → throws LlmRoutingError with all model ids in attempted', async () => {
  const router = new LlmRouter(
    routerConfig([
      model({ id: 'model-a', priority: 0 }),
      model({ id: 'model-b', priority: 1 }),
      model({ id: 'model-c', priority: 2 }),
    ]),
    failingHttp(),
  );
  let caught;
  try {
    await router.run(task());
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LlmRoutingError, 'should throw LlmRoutingError');
  assert.ok(caught.attempted.includes('model-a'), 'model-a should be in attempted');
  assert.ok(caught.attempted.includes('model-b'), 'model-b should be in attempted');
  assert.ok(caught.attempted.includes('model-c'), 'model-c should be in attempted');
  assert.equal(caught.attempted.length, 3);
});

test('E4: LlmRoutingError.lastError is the error from the last attempted model', async () => {
  // Callers may inspect lastError to distinguish "model rejected it" from "network down".
  let callCount = 0;
  const specificErrors = [new Error('first error'), new Error('last error')];
  const client = {
    post: async () => { throw specificErrors[callCount++ > 0 ? 1 : 0]; },
  };
  const router = new LlmRouter(
    routerConfig([model({ id: 'a', priority: 0 }), model({ id: 'b', priority: 1 })]),
    client,
  );
  let caught;
  try { await router.run(task()); } catch (err) { caught = err; }
  assert.ok(caught instanceof LlmRoutingError);
  assert.equal(caught.lastError.message, 'last error');
});

test('E5: Fallback does not use a model whose context window is too small for the task tier', async () => {
  // DEEP tasks need a large context. If the "fallback" is a tiny FLASH model,
  // the router must skip it — not use it and silently truncate input.
  const { client, calls } = mockHttp('ok');
  const deepModel   = model({ id: 'deep',  tier: LlmTier.DEEP,  contextWindow: 128_000, priority: 0 });
  const flashModel  = model({ id: 'flash', tier: LlmTier.FLASH, contextWindow:   4_000, priority: 1 });

  // Only deepModel is eligible. If deepModel fails, the router should throw
  // (not fall back to flashModel which can't handle DEEP).
  let deepCallCount = 0;
  const failDeepHttp = {
    post: async (url, body) => {
      deepCallCount++;
      throw new Error('deep model failed');
    },
  };
  const router = new LlmRouter(routerConfig([deepModel, flashModel]), failDeepHttp);
  let caught;
  try { await router.run(task({ tier: LlmTier.DEEP })); } catch (err) { caught = err; }
  assert.ok(caught instanceof LlmRoutingError);
  assert.ok(!caught.attempted.includes('flash'), 'flash model should not be attempted for DEEP task');
});

test('E6: Fallback respects priority ordering within the fallback chain', async () => {
  // Priority 0 must be tried before priority 1 before priority 2.
  // This is already covered by E3 but this test makes it explicit via ordering assertion.
  const callOrder = [];
  const client = {
    post: async (url, body) => {
      callOrder.push(body.model);
      throw new Error('fail');
    },
  };
  const router = new LlmRouter(
    routerConfig([
      model({ id: 'p2', priority: 2 }),
      model({ id: 'p0', priority: 0 }),
      model({ id: 'p1', priority: 1 }),
    ]),
    client,
  );
  try { await router.run(task()); } catch {}
  assert.deepEqual(callOrder, ['p0', 'p1', 'p2'], 'models should be tried in priority order');
});

// ============================================================================
// Group F — complete() backward compat
// ============================================================================

test('F1: complete(prompt) routes to FLASH tier', async () => {
  // All existing callers that use complete() get FLASH-tier behavior automatically.
  // They should never be routed to a tiny model that can't handle their prompts.
  const { client, calls } = mockHttp('result');
  const flashModel    = model({ id: 'flash-model',    tier: LlmTier.FLASH,    priority: 0 });
  const standardModel = model({ id: 'standard-model', tier: LlmTier.STANDARD, priority: 0 });
  // Only one eligible FLASH model — ensure it's chosen
  const router = new LlmRouter(routerConfig([flashModel, standardModel]), client);
  await router.complete('Hello from legacy caller');
  // The FLASH model should be preferred for complete()
  assert.equal(calls[0].body.model, 'flash-model');
});

test('F2: complete(prompt) returns raw completion string', async () => {
  const { client } = mockHttp('legacy result');
  const router = new LlmRouter(routerConfig([model()]), client);
  const result = await router.complete('prompt text');
  assert.equal(result, 'legacy result');
});

test('F3: complete(prompt) with only STANDARD model in pool → uses STANDARD (upward promotion)', async () => {
  // STANDARD can serve FLASH tasks (more context than needed, but still correct).
  const { client, calls } = mockHttp('ok');
  const stdModel = model({ id: 'std-model', tier: LlmTier.STANDARD, contextWindow: 32_000 });
  const router = new LlmRouter(routerConfig([stdModel]), client);
  await router.complete('test');
  assert.equal(calls[0].body.model, 'std-model');
});

test('F4: complete(prompt) with no eligible models → throws LlmRoutingError', async () => {
  // Empty pool or no model covers FLASH → typed error, not silent hang.
  const { client } = mockHttp();
  const router = new LlmRouter(routerConfig([]), client);
  await assert.rejects(() => router.complete('anything'), LlmRoutingError);
});

// ============================================================================
// Group G — Timeout handling
// ============================================================================

test('G1: Request exceeding timeoutMs is treated as model failure, triggers fallback', async () => {
  // A hanging model should not block the router indefinitely.
  // The router aborts after timeoutMs and tries the next model.
  let callCount = 0;
  const hangingThenFastHttp = {
    post: async (url, body) => {
      callCount++;
      if (callCount === 1) {
        // Hang for longer than the timeout
        await new Promise(r => setTimeout(r, 10_000));
        return { text: JSON.stringify({ choices: [{ message: { content: 'too late' } }] }) };
      }
      return { text: JSON.stringify({ choices: [{ message: { content: 'fast fallback' } }] }) };
    },
  };
  const slowModel = model({ id: 'slow', priority: 0 });
  const fastModel = model({ id: 'fast', priority: 1 });
  const router = new LlmRouter(
    routerConfig([slowModel, fastModel], 50), // 50ms timeout
    hangingThenFastHttp,
  );
  const result = await router.run(task());
  assert.equal(result, 'fast fallback', 'should fall back to fast model after timeout');
});

test('G2: Default timeout is 30000ms (configured in router defaults)', () => {
  // Verify the default is sane — not too short (drops valid slow requests) or infinite.
  // We test this by inspecting router.timeoutMs after constructing with no timeoutMs.
  const { client } = mockHttp();
  // Pass config without timeoutMs — must NOT use the routerConfig() helper (which sets 5000)
  const router = new LlmRouter({ models: [model()] }, client);
  assert.ok(
    typeof router.timeoutMs === 'number' && router.timeoutMs === 30_000,
    `default timeoutMs should be 30000, got: ${router.timeoutMs}`,
  );
});

// ============================================================================
// Group H — Logging
// ============================================================================

test('H1: Successful call logs selected model label', async () => {
  const { client } = mockHttp('ok');
  const { logger, logs } = captureLogger();
  const router = new LlmRouter(routerConfig([model({ label: 'My Test Model' })]), client, logger);
  await router.run(task());
  const logMessages = logs.map(l => l.message).join(' ');
  assert.ok(logMessages.includes('My Test Model'), 'should log the selected model label');
});

test('H2: Fallback logs which model failed and which is next', async () => {
  const { client } = failThenSucceedHttp(1, 'ok');
  const { logger, logs } = captureLogger();
  const router = new LlmRouter(
    routerConfig([
      model({ id: 'primary-model',  label: 'Primary',  priority: 0 }),
      model({ id: 'fallback-model', label: 'Fallback', priority: 1 }),
    ]),
    client,
    logger,
  );
  await router.run(task());
  const allMessages = logs.map(l => l.message).join('\n');
  // Should mention the failure + the fallback
  assert.ok(
    allMessages.includes('Primary') || allMessages.includes('primary-model'),
    'should log the failing model',
  );
  assert.ok(
    allMessages.includes('Fallback') || allMessages.includes('fallback-model'),
    'should log the fallback model',
  );
});

test('H3: No logger provided — router runs without crashing', async () => {
  // Logger is optional. Passing undefined must not throw a TypeError.
  const { client } = mockHttp('ok');
  // No logger arg at all
  const router = new LlmRouter(routerConfig([model()]), client);
  await assert.doesNotReject(() => router.run(task()));
});
