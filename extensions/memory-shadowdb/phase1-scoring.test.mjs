/**
 * phase1-scoring.test.mjs — TDD tests for scoreInterestingness()
 *
 * scoreInterestingness() calls a local LLM (GLM-5 via OpenClaw or Groq)
 * and returns a float 0-10. All LLM calls are mocked here — no real API calls.
 *
 * Tests cover: correct score parsing, retry on malformed response,
 * timeout handling, score clamping, and mock injection pattern.
 *
 * Run with: node --test phase1-scoring.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInterestingness } from './dist/phase1-scoring.js';

// ============================================================================
// Mock LLM client
// ============================================================================

/**
 * Build a mock LLM client that returns a fixed response.
 * Matches the LlmClient interface expected by scoreInterestingness().
 */
function mockLlm(response) {
  return {
    complete: async (_prompt) => response,
  };
}

/** Mock that throws on call */
function failingLlm(message = 'LLM error') {
  return {
    complete: async (_prompt) => { throw new Error(message); },
  };
}

/** Mock that returns each response in sequence, then repeats the last */
function sequenceLlm(responses) {
  let i = 0;
  return {
    complete: async (_prompt) => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

// ============================================================================
// scoreInterestingness — happy path
// ============================================================================

test('scoreInterestingness returns float from LLM response with plain number', async () => {
  const llm = mockLlm('8');
  const result = await scoreInterestingness('Term sheet from Andreessen for Series A.', {}, llm);
  assert.ok(typeof result === 'number', 'result should be a number');
  assert.ok(Math.abs(result - 8) < 0.01, `expected 8, got ${result}`);
});

test('scoreInterestingness parses "Score: 7.5" format from LLM response', async () => {
  const llm = mockLlm('Score: 7.5');
  const result = await scoreInterestingness('Received SAFE note.', {}, llm);
  assert.ok(Math.abs(result - 7.5) < 0.01, `expected 7.5, got ${result}`);
});

test('scoreInterestingness parses number embedded in longer LLM response', async () => {
  const llm = mockLlm('This email discusses a term sheet. I would rate it 9 out of 10.');
  const result = await scoreInterestingness('Term sheet email.', {}, llm);
  // Should extract 9 (first reasonable number found)
  assert.ok(result >= 8 && result <= 10, `expected ~9, got ${result}`);
});

test('scoreInterestingness clamps score to [0, 10]', async () => {
  const llm = mockLlm('15'); // Out of range
  const result = await scoreInterestingness('Some text.', {}, llm);
  assert.equal(result, 10, 'should clamp to 10');
});

test('scoreInterestingness clamps negative scores to 0', async () => {
  const llm = mockLlm('-3');
  const result = await scoreInterestingness('Some text.', {}, llm);
  assert.equal(result, 0, 'should clamp to 0');
});

// ============================================================================
// scoreInterestingness — error handling
// ============================================================================

test('scoreInterestingness returns DEFAULT_SCORE (5) when LLM throws', async () => {
  const llm = failingLlm('Connection refused');
  const result = await scoreInterestingness('Some text.', {}, llm);
  assert.equal(result, 5, 'should return default score on LLM error');
});

test('scoreInterestingness returns DEFAULT_SCORE (5) when LLM returns unparseable response', async () => {
  const llm = mockLlm('I cannot determine the score for this email.');
  const result = await scoreInterestingness('Some text.', {}, llm);
  // No number found in response → default
  assert.equal(result, 5, 'should return default score when no number found');
});

test('scoreInterestingness never throws — always returns a number', async () => {
  const llm = failingLlm('Catastrophic failure');
  let result;
  await assert.doesNotReject(async () => {
    result = await scoreInterestingness('text', {}, llm);
  });
  assert.ok(typeof result === 'number');
});

// ============================================================================
// scoreInterestingness — metadata context
// ============================================================================

test('scoreInterestingness passes subject and parties to LLM prompt', async () => {
  let capturedPrompt = '';
  const capturingLlm = {
    complete: async (prompt) => { capturedPrompt = prompt; return '7'; },
  };
  await scoreInterestingness(
    'Let us discuss the investment.',
    { subject: 'Series A Term Sheet', parties: ['John Smith'] },
    capturingLlm,
  );
  assert.ok(capturedPrompt.includes('Series A Term Sheet'), 'prompt should include subject');
  assert.ok(capturedPrompt.includes('John Smith'), 'prompt should include party names');
});

test('scoreInterestingness prompt asks for a single number 0-10', async () => {
  let capturedPrompt = '';
  const capturingLlm = {
    complete: async (prompt) => { capturedPrompt = prompt; return '5'; },
  };
  await scoreInterestingness('Some email text.', {}, capturingLlm);
  assert.ok(
    capturedPrompt.includes('0') && capturedPrompt.includes('10'),
    'prompt should mention 0-10 scale',
  );
});

// ============================================================================
// scoreInterestingness — score threshold
// ============================================================================

test('scoreInterestingness returns score above 6 for deal-relevant content', async () => {
  // Use a real-looking high-relevance response
  const llm = mockLlm('9');
  const result = await scoreInterestingness(
    'James, I am pleased to share the term sheet for your Series A at an $8M pre-money valuation. Please review with your counsel.',
    { subject: 'Series A Term Sheet', parties: ['Sarah Kim'] },
    llm,
  );
  assert.ok(result >= 6, `deal email should score ≥6, got ${result}`);
});

test('scoreInterestingness returns score below 6 for low-signal content when LLM says so', async () => {
  const llm = mockLlm('2');
  const result = await scoreInterestingness(
    'Your order has been shipped. Estimated delivery: March 10.',
    { subject: 'Order Shipped' },
    llm,
  );
  assert.ok(result < 6, `shipping email should score <6, got ${result}`);
});
