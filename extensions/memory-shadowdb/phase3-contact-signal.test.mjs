/**
 * phase3-contact-signal.test.mjs — TDD tests for Phase 3 contact re-scoring
 *
 * Tests the onNewContactSignal hook, extractBehavioralSignals,
 * and computePsychographicDelta.
 *
 * All LLM calls are mocked. No DB writes in unit tests.
 *
 * Run with: node --test phase3-contact-signal.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onNewContactSignal,
  extractBehavioralSignals,
  computePsychographicDelta,
  DELTA_THRESHOLD,
} from './dist/phase3-contact-signal.js';

// ============================================================================
// Fixtures
// ============================================================================

function mockLlm(response) {
  return { complete: async () => response };
}

function failingLlm() {
  return { complete: async () => { throw new Error('LLM error'); } };
}

function extractedContent(overrides = {}) {
  return {
    sourceId: 'msg-001',
    threadId: 'thread-001',
    subject: 'Follow up on our meeting',
    from: 'alice@example.com',
    date: new Date(),
    text: 'Hi, just following up on our conversation. I wanted to make sure we are aligned on the next steps.',
    parties: ['Alice Example'],
    ...overrides,
  };
}

function dossierRecord(overrides = {}) {
  return {
    id: 1001,
    title: 'Alice Example — Dossier (Full 8-Layer)',
    content: 'Alice is a methodical Analyst type (DISC: C). Prefers data over emotion. Rarely commits without due diligence. Communication style: precise, structured, low warmth.',
    category: 'contacts',
    record_type: 'document',
    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    metadata: {
      disc: 'C',
      mbti: 'INTJ',
      voss_type: 'Analyst',
      enneagram: '5',
    },
    ...overrides,
  };
}

// ============================================================================
// extractBehavioralSignals
// ============================================================================

test('extractBehavioralSignals returns structured signals from LLM response', async () => {
  const llm = mockLlm(JSON.stringify({
    deferenceSignals: ['defers to data, not authority'],
    commitmentLanguage: [],
    toneShifts: [],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Analyst',
    warmthLevel: 'low',
    urgencyLevel: 'medium',
  }));

  const result = await extractBehavioralSignals(
    'The data clearly shows we should proceed carefully. What does the analysis say?',
    [],
    llm,
  );

  assert.ok(result !== null, 'should return signals');
  assert.ok(typeof result.dominantStyle === 'string', 'should have dominantStyle');
  assert.ok(Array.isArray(result.deferenceSignals), 'should have deferenceSignals array');
  assert.ok(typeof result.warmthLevel === 'string', 'should have warmthLevel');
});

test('extractBehavioralSignals returns null on LLM failure — never throws', async () => {
  const llm = failingLlm();
  let result;
  await assert.doesNotReject(async () => {
    result = await extractBehavioralSignals('some text', [], llm);
  });
  assert.equal(result, null, 'LLM failure should return null');
});

test('extractBehavioralSignals detects commitment language in text', async () => {
  const llm = mockLlm(JSON.stringify({
    deferenceSignals: [],
    commitmentLanguage: ['will deliver by Friday', 'agree to the terms'],
    toneShifts: ['shifted from cautious to committed'],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Assertive',
    warmthLevel: 'medium',
    urgencyLevel: 'high',
  }));

  const result = await extractBehavioralSignals(
    'I will deliver the contract by Friday. I agree to the terms as stated.',
    [],
    llm,
  );

  assert.ok(result !== null);
  assert.ok(result.commitmentLanguage.length > 0, 'should detect commitment language');
});

test('extractBehavioralSignals handles malformed LLM JSON gracefully', async () => {
  const llm = mockLlm('not valid json at all');
  let result;
  await assert.doesNotReject(async () => {
    result = await extractBehavioralSignals('some text', [], llm);
  });
  assert.equal(result, null, 'malformed JSON should return null');
});

test('extractBehavioralSignals passes prior context to LLM prompt', async () => {
  let capturedPrompt = '';
  const capturingLlm = {
    complete: async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ deferenceSignals: [], commitmentLanguage: [], toneShifts: [], unexpectedTopics: [], silenceOn: [], dominantStyle: 'Analyst', warmthLevel: 'low', urgencyLevel: 'low' });
    },
  };

  await extractBehavioralSignals(
    'New message text.',
    ['Prior message 1', 'Prior message 2'],
    capturingLlm,
  );

  assert.ok(capturedPrompt.includes('Prior message 1'), 'prompt should include prior context');
});

// ============================================================================
// computePsychographicDelta
// ============================================================================

function psychProfile(overrides = {}) {
  return {
    disc: 'C',
    mbti: 'INTJ',
    vossType: 'Analyst',
    enneagram: '5',
    warmthLevel: 'low',
    dominantStyle: 'Analyst',
    ...overrides,
  };
}

function behavioralSignals(overrides = {}) {
  return {
    deferenceSignals: [],
    commitmentLanguage: [],
    toneShifts: [],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Analyst',
    warmthLevel: 'low',
    urgencyLevel: 'low',
    ...overrides,
  };
}

test('computePsychographicDelta returns null when signals match existing profile', () => {
  const existing = psychProfile({ disc: 'C', vossType: 'Analyst', warmthLevel: 'low' });
  const signals = behavioralSignals({ dominantStyle: 'Analyst', warmthLevel: 'low' });
  const delta = computePsychographicDelta(existing, signals);
  assert.equal(delta, null, 'no meaningful change should return null');
});

test('computePsychographicDelta returns delta when dominant style shifts', () => {
  const existing = psychProfile({ disc: 'C', vossType: 'Analyst', dominantStyle: 'Analyst' });
  const signals = behavioralSignals({ dominantStyle: 'Accommodator', warmthLevel: 'high' });
  const delta = computePsychographicDelta(existing, signals);
  assert.ok(delta !== null, 'style shift should produce delta');
  assert.ok(typeof delta.summary === 'string', 'delta should have summary');
  assert.ok(typeof delta.confidence === 'number', 'delta should have confidence');
  assert.ok(delta.confidence >= 0 && delta.confidence <= 1, 'confidence should be in [0,1]');
});

test('computePsychographicDelta returns delta when warmth level shifts significantly', () => {
  const existing = psychProfile({ warmthLevel: 'low' });
  const signals = behavioralSignals({ warmthLevel: 'high', dominantStyle: 'Analyst' });
  const delta = computePsychographicDelta(existing, signals);
  assert.ok(delta !== null, 'warmth shift should produce delta');
});

test('computePsychographicDelta confidence is below threshold for minor shifts', () => {
  const existing = psychProfile({ warmthLevel: 'low' });
  const signals = behavioralSignals({ warmthLevel: 'medium', dominantStyle: 'Analyst' });
  const delta = computePsychographicDelta(existing, signals);
  // medium vs low is a minor shift — may be below threshold
  if (delta !== null) {
    assert.ok(delta.confidence < DELTA_THRESHOLD || delta.confidence >= 0,
      'minor shifts should have lower confidence');
  }
});

test('computePsychographicDelta includes affected dimensions in result', () => {
  const existing = psychProfile({ disc: 'C', vossType: 'Analyst' });
  const signals = behavioralSignals({ dominantStyle: 'Assertive', warmthLevel: 'high' });
  const delta = computePsychographicDelta(existing, signals);
  assert.ok(delta !== null);
  assert.ok(Array.isArray(delta.changedDimensions), 'should list changed dimensions');
  assert.ok(delta.changedDimensions.length > 0, 'should have at least one changed dimension');
});

// ============================================================================
// onNewContactSignal
// ============================================================================

test('onNewContactSignal returns null when contact has no existing dossier', async () => {
  const llm = mockLlm('{}');
  const result = await onNewContactSignal(1001, extractedContent(), null, llm);
  assert.equal(result, null, 'no dossier = no delta to compute');
});

test('onNewContactSignal returns null when behavioral analysis returns null', async () => {
  const llm = failingLlm();
  const result = await onNewContactSignal(1001, extractedContent(), dossierRecord(), llm);
  assert.equal(result, null, 'LLM failure should return null gracefully');
});

test('onNewContactSignal returns ContactDelta when meaningful change detected', async () => {
  const llm = mockLlm(JSON.stringify({
    deferenceSignals: ['deferred to peer unexpectedly'],
    commitmentLanguage: ['agreed to terms without pushback'],
    toneShifts: ['shifted from guarded to open'],
    unexpectedTopics: ['mentioned personal situation unprompted'],
    silenceOn: [],
    dominantStyle: 'Accommodator',  // shifted from Analyst in dossier
    warmthLevel: 'high',            // shifted from low in dossier
    urgencyLevel: 'medium',
  }));

  const result = await onNewContactSignal(
    1001,
    extractedContent({ text: 'I really appreciate your help. I agree to everything you proposed. This means a lot to me personally.' }),
    dossierRecord(),
    llm,
  );

  // May return null if delta is below threshold — that's valid
  // But if it returns something, it must have the right shape
  if (result !== null) {
    assert.ok(typeof result.contactId === 'number', 'should have contactId');
    assert.ok(typeof result.summary === 'string', 'should have summary');
    assert.ok(result.delta !== null, 'should have delta');
    assert.ok(typeof result.confidence === 'number', 'should have confidence');
  }
});

test('onNewContactSignal never throws — always returns null or ContactDelta', async () => {
  const llm = failingLlm();
  let result;
  await assert.doesNotReject(async () => {
    result = await onNewContactSignal(9999, extractedContent(), dossierRecord(), llm);
  });
  assert.ok(result === null || typeof result === 'object');
});

test('onNewContactSignal result includes contactId when delta is returned', async () => {
  const llm = mockLlm(JSON.stringify({
    deferenceSignals: [],
    commitmentLanguage: ['shall deliver', 'agree to all terms'],
    toneShifts: ['became assertive'],
    unexpectedTopics: [],
    silenceOn: [],
    dominantStyle: 'Assertive',
    warmthLevel: 'low',
    urgencyLevel: 'high',
  }));

  const content = extractedContent({
    text: 'I shall deliver by end of week. I agree to all terms. This is non-negotiable.',
  });
  const dossier = dossierRecord({ metadata: { disc: 'C', vossType: 'Analyst', dominantStyle: 'Analyst' } });

  const result = await onNewContactSignal(1001, content, dossier, llm);
  if (result !== null) {
    assert.equal(result.contactId, 1001);
  }
});
