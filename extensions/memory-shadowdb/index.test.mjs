import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from './index.ts';

const {
  normalizeEmbeddingProvider,
  resolveEmbeddingConfig,
  resolveStartupInjectionConfig,
  validateEmbeddingDimensions,
} = __test__;

function withEnv(overrides, fn) {
  const snapshot = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
    OLLAMA_URL: process.env.OLLAMA_URL,
  };

  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === null) delete process.env[k];
      else process.env[k] = String(v);
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('normalizeEmbeddingProvider handles aliases', () => {
  assert.equal(normalizeEmbeddingProvider(undefined), 'ollama');
  assert.equal(normalizeEmbeddingProvider('openai_compatible'), 'openai-compatible');
  assert.equal(normalizeEmbeddingProvider('openai-compatible-api'), 'openai-compatible');
  assert.equal(normalizeEmbeddingProvider('google'), 'gemini');
  assert.equal(normalizeEmbeddingProvider('external'), 'command');
  assert.equal(normalizeEmbeddingProvider('custom'), 'command');
  assert.equal(normalizeEmbeddingProvider('voyage'), 'voyage');
  assert.equal(normalizeEmbeddingProvider('openai'), 'openai');
});

test('resolveEmbeddingConfig returns provider-specific defaults', () => {
  withEnv(
    {
      OPENAI_API_KEY: 'openai-key',
      VOYAGE_API_KEY: 'voyage-key',
      GEMINI_API_KEY: 'gemini-key',
      EMBEDDING_BASE_URL: 'https://proxy.example/v1',
      OLLAMA_URL: 'http://ollama.local:11434',
    },
    () => {
      const ollama = resolveEmbeddingConfig({ embedding: { provider: 'ollama' } });
      assert.equal(ollama.provider, 'ollama');
      assert.equal(ollama.model, 'nomic-embed-text');
      assert.equal(ollama.ollamaUrl, 'http://ollama.local:11434');
      assert.equal(ollama.dimensions, 768);

      const openai = resolveEmbeddingConfig({ embedding: { provider: 'openai' } });
      assert.equal(openai.provider, 'openai');
      assert.equal(openai.model, 'text-embedding-3-small');
      assert.equal(openai.apiKey, 'openai-key');
      assert.equal(openai.baseUrl, 'https://api.openai.com');

      const compatible = resolveEmbeddingConfig({ embedding: { provider: 'openai-compatible' } });
      assert.equal(compatible.provider, 'openai-compatible');
      assert.equal(compatible.baseUrl, 'https://proxy.example/v1');
      assert.equal(compatible.apiKey, 'openai-key');

      const voyage = resolveEmbeddingConfig({ embedding: { provider: 'voyage' } });
      assert.equal(voyage.provider, 'voyage');
      assert.equal(voyage.model, 'voyage-3-lite');
      assert.equal(voyage.apiKey, 'voyage-key');
      assert.equal(voyage.voyageInputType, 'query');

      const gemini = resolveEmbeddingConfig({ embedding: { provider: 'gemini' } });
      assert.equal(gemini.provider, 'gemini');
      assert.equal(gemini.model, 'text-embedding-004');
      assert.equal(gemini.apiKey, 'gemini-key');
      assert.equal(gemini.geminiTaskType, 'RETRIEVAL_QUERY');

      const command = resolveEmbeddingConfig({
        embedding: {
          provider: 'command',
          command: '/usr/local/bin/embedder',
          commandArgs: ['--json'],
          commandTimeoutMs: 9000,
        },
      });
      assert.equal(command.provider, 'command');
      assert.equal(command.model, 'external-command');
      assert.equal(command.command, '/usr/local/bin/embedder');
      assert.deepEqual(command.commandArgs, ['--json']);
      assert.equal(command.commandTimeoutMs, 9000);
    },
  );
});

test('validateEmbeddingDimensions enforces configured size', () => {
  const emb = [0.1, 0.2, 0.3];
  assert.deepEqual(validateEmbeddingDimensions(emb, 3, 'ollama:nomic-embed-text'), emb);
  assert.deepEqual(validateEmbeddingDimensions(emb, 0, 'ollama:nomic-embed-text'), emb);

  assert.throws(
    () => validateEmbeddingDimensions([0.1, 0.2], 3, 'openai:text-embedding-3-small'),
    /Embedding dimension mismatch/i,
  );
});


test('resolveStartupInjectionConfig defaults and normalization', () => {
  const defaults = resolveStartupInjectionConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.mode, 'always');
  assert.equal(defaults.maxChars, 4000);
  assert.equal(defaults.cacheTtlMs, 600000);

  const custom = resolveStartupInjectionConfig({
    startup: {
      enabled: false,
      mode: 'digest',
      maxChars: 1200,
      cacheTtlMs: 2500,
    },
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.mode, 'digest');
  assert.equal(custom.maxChars, 1200);
  assert.equal(custom.cacheTtlMs, 2500);

  const bad = resolveStartupInjectionConfig({
    startup: {
      mode: 'weird-mode',
      maxChars: -10,
      cacheTtlMs: -1,
    },
  });
  assert.equal(bad.mode, 'always');
  assert.equal(bad.maxChars, 4000);
  assert.equal(bad.cacheTtlMs, 600000);
});
