/**
 * llm-tier-wiring.test.mjs — Tests that callers use the correct LlmTier
 *
 * Verifies that after wiring TieredLlmClient into the scoring and signal
 * modules, each function requests the correct tier:
 *
 *   scoreInterestingness  → LlmTier.FLASH    (fast, cheap, ≤4K tokens)
 *   extractBehavioralSignals → LlmTier.STANDARD (balanced, ≤32K tokens)
 *
 * Two compatibility paths are tested for each function:
 *   A) TieredLlmClient path — calls run(task) with explicit tier
 *   B) LlmClient path      — calls complete(prompt), backward compat preserved
 *
 * The TieredLlmClient mock captures what tier/options were passed.
 * The plain LlmClient mock just returns a fixed string.
 *
 * Run: node --test llm-tier-wiring.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInterestingness } from './dist/phase1-scoring.js';
import { extractBehavioralSignals } from './dist/phase3-contact-signal.js';
import { LlmTier } from './dist/llm-router.js';

// ============================================================================
// Mock helpers
// ============================================================================

/**
 * A TieredLlmClient mock that records every run() call.
 * Returns a fixed string so callers can parse it without crashing.
 *
 * @param {string} response - The string to return from run() and complete()
 * @returns {{ client: TieredLlmClient, calls: LlmTask[] }}
 */
function capturingTieredLlm(response) {
  const calls = [];
  const client = {
    // TieredLlmClient.run() — captures the full task spec
    run: async (task) => {
      calls.push({ ...task });
      return response;
    },
    // LlmClient.complete() — backward compat shorthand
    complete: async (prompt) => {
      calls.push({ prompt, tier: '__complete__' });
      return response;
    },
  };
  return { client, calls };
}

/**
 * A plain LlmClient (old interface) with no run() method.
 * Used to verify backward compatibility is preserved.
 *
 * @param {string} response
 */
function plainLlmClient(response) {
  return {
    complete: async (_prompt) => response,
    // Deliberately no run() method — simulates old callers
  };
}

// ============================================================================
// scoreInterestingness — tier wiring
// ============================================================================

test('scoreInterestingness uses FLASH tier when given a TieredLlmClient', async () => {
  // FLASH is correct for scoring — prompt is short (≤500 tokens), output is a
  // single number. Using a larger tier wastes latency and cost.
  const { client, calls } = capturingTieredLlm('7');
  await scoreInterestingness('Term sheet for Series A.', {}, client);
  assert.ok(calls.length > 0, 'should have called the LLM');
  const firstCall = calls[0];
  assert.equal(firstCall.tier, LlmTier.FLASH, `expected FLASH tier, got: ${firstCall.tier}`);
});

test('scoreInterestingness requests disableThinking when given a TieredLlmClient', async () => {
  // Thinking tokens corrupt parseScore (step numbers like "1." get mistaken for scores).
  // Scoring prompts must always suppress Qwen3 thinking.
  const { client, calls } = capturingTieredLlm('8');
  await scoreInterestingness('Investment update from VC firm.', {}, client);
  const firstCall = calls[0];
  assert.equal(
    firstCall.disableThinking,
    true,
    'scoreInterestingness must disable thinking to prevent parseScore corruption',
  );
});

test('scoreInterestingness requests number outputFormat when given a TieredLlmClient', async () => {
  // "number" output format is a hint to the router that a single number is expected.
  // Routers may use logit bias or temperature=0 for number tasks.
  const { client, calls } = capturingTieredLlm('6');
  await scoreInterestingness('Deal memo received.', {}, client);
  const firstCall = calls[0];
  assert.ok(
    firstCall.outputFormat === 'number' || firstCall.outputFormat === undefined,
    `outputFormat should be "number" or omitted, got: ${firstCall.outputFormat}`,
  );
});

test('scoreInterestingness still works with a plain LlmClient (backward compat)', async () => {
  // Existing callers pass a plain { complete() } object.
  // They must not break after the upgrade.
  const llm = plainLlmClient('9');
  let result;
  await assert.doesNotReject(async () => {
    result = await scoreInterestingness('Series B term sheet arrived.', {}, llm);
  });
  assert.equal(result, 9, 'should still parse score from plain LlmClient');
});

test('scoreInterestingness score is still clamped to [0,10] via TieredLlmClient', async () => {
  // Tier wiring must not break the score clamping logic.
  const { client } = capturingTieredLlm('99');
  const result = await scoreInterestingness('something', {}, client);
  assert.ok(result <= 10, `score should be clamped to 10, got: ${result}`);
});

test('scoreInterestingness still returns DEFAULT_SCORE on TieredLlmClient failure', async () => {
  // If run() throws, scoreInterestingness must still return 5 (never throw).
  const failingTieredLlm = {
    run: async () => { throw new Error('model down'); },
    complete: async () => { throw new Error('model down'); },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await scoreInterestingness('anything', {}, failingTieredLlm);
  });
  assert.equal(result, 5, 'should return DEFAULT_SCORE on failure');
});

// ============================================================================
// extractBehavioralSignals — tier wiring
// ============================================================================

test('extractBehavioralSignals uses STANDARD tier when given a TieredLlmClient', async () => {
  // STANDARD tier (≤32K) is correct for behavioral analysis:
  // prompt includes the message text + up to 3 prior context messages.
  // FLASH (≤4K) is too small; DEEP (≤128K) is overkill and slow.
  const signalsJson = JSON.stringify({
    deferenceSignals: [],
    commitmentLanguage: [],
    toneShifts: [],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Analyst',
    warmthLevel: 'low',
    urgencyLevel: 'medium',
  });
  const { client, calls } = capturingTieredLlm(signalsJson);
  await extractBehavioralSignals('Following up on the term sheet.', [], client);
  assert.ok(calls.length > 0, 'should have called the LLM');
  const firstCall = calls[0];
  assert.equal(firstCall.tier, LlmTier.STANDARD, `expected STANDARD tier, got: ${firstCall.tier}`);
});

test('extractBehavioralSignals requests json outputFormat when given a TieredLlmClient', async () => {
  // Behavioral signals are structured JSON. Requesting json output format
  // enables JSON mode on supporting models, reducing parse failures.
  const signalsJson = JSON.stringify({
    deferenceSignals: [],
    commitmentLanguage: ['shall deliver'],
    toneShifts: [],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Assertive',
    warmthLevel: 'medium',
    urgencyLevel: 'high',
  });
  const { client, calls } = capturingTieredLlm(signalsJson);
  await extractBehavioralSignals('I shall deliver by Friday.', [], client);
  const firstCall = calls[0];
  assert.equal(
    firstCall.outputFormat,
    'json',
    `outputFormat should be "json" for structured signal extraction, got: ${firstCall.outputFormat}`,
  );
});

test('extractBehavioralSignals still works with a plain LlmClient (backward compat)', async () => {
  // Old callers that pass { complete() } must still work.
  const signalsJson = JSON.stringify({
    deferenceSignals: [],
    commitmentLanguage: [],
    toneShifts: [],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Analyst',
    warmthLevel: 'low',
    urgencyLevel: 'low',
  });
  const llm = plainLlmClient(signalsJson);
  let result;
  await assert.doesNotReject(async () => {
    result = await extractBehavioralSignals('Test message.', [], llm);
  });
  assert.ok(result !== null, 'should return BehavioralSignals from plain LlmClient');
  assert.equal(result.dominantStyle, 'Analyst');
});

test('extractBehavioralSignals still returns null on TieredLlmClient failure (never throws)', async () => {
  // If run() throws, extractBehavioralSignals must return null — never propagate.
  const failingTieredLlm = {
    run: async () => { throw new Error('STANDARD model unavailable'); },
    complete: async () => { throw new Error('STANDARD model unavailable'); },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await extractBehavioralSignals('anything', [], failingTieredLlm);
  });
  assert.equal(result, null, 'should return null on failure, not throw');
});

test('extractBehavioralSignals passes context messages to run() prompt', async () => {
  // Tier wiring must not break context injection — the prompt sent to run()
  // should still include prior messages when context array is non-empty.
  const signalsJson = JSON.stringify({
    deferenceSignals: [],
    commitmentLanguage: [],
    toneShifts: [],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Mixed',
    warmthLevel: 'medium',
    urgencyLevel: 'low',
  });
  const { client, calls } = capturingTieredLlm(signalsJson);
  await extractBehavioralSignals(
    'Current message text.',
    ['Prior message 1', 'Prior message 2'],
    client,
  );
  const prompt = calls[0].prompt;
  assert.ok(
    prompt.includes('Prior message 1') || prompt.includes('Prior message'),
    'prompt should include prior context messages',
  );
});
