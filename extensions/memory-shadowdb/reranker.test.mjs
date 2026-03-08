/**
 * reranker.test.mjs — TDD tests for reranker.ts
 *
 * Tests: rerankCandidates, checkRerankerHealth, parseRerankerConfig.
 * All HTTP calls use a lightweight mock server (no real network dependency).
 * Tests verify: correct ranking, graceful degradation, config parsing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rerankCandidates, checkRerankerHealth, parseRerankerConfig } from './dist/reranker.js';

// ============================================================================
// Test fixtures
// ============================================================================

const MOCK_QUERY = 'venture capital deal term sheet';

/** Five candidates — deliberately out of relevance order by rrfScore */
const MOCK_CANDIDATES = [
  { id: 1, content: 'Term sheet from Andreessen for Series A at $8M valuation', rrfScore: 0.82 },
  { id: 2, content: 'Grocery list: milk eggs bread butter',                       rrfScore: 0.75 },
  { id: 3, content: 'SAFE note for $2M from Sequoia Capital',                    rrfScore: 0.71 },
  { id: 4, content: 'The dog needs a walk today',                                rrfScore: 0.68 },
  { id: 5, content: 'Meeting with Sarah re Series A terms next Tuesday',         rrfScore: 0.65 },
];

/**
 * Reranker response that reflects real Qwen3-Reranker scoring.
 * Verified against live reranker on 2026-03-07.
 * Expected order: id=1 (0.99), id=5 (0.95), id=3 (0.27), id=4 (0.01), id=2 (0.00)
 */
const RERANKER_SUCCESS_RESPONSE = {
  results: [
    { index: 0, relevance_score: 0.9919 }, // id=1: term sheet
    { index: 4, relevance_score: 0.9502 }, // id=5: meeting re Series A
    { index: 2, relevance_score: 0.2689 }, // id=3: SAFE note
    { index: 3, relevance_score: 0.0072 }, // id=4: dog walk
    { index: 1, relevance_score: 0.0001 }, // id=2: grocery list
  ],
  meta: { api_version: { version: '1' } },
};

const NOOP_LOGGER = { info: () => {}, warn: () => {}, debug: () => {} };

// ============================================================================
// Mock HTTP server helpers
// ============================================================================

/**
 * Start a mock HTTP server on a random port.
 * @param {function} handler - (req, res) handler
 * @returns {{ server, baseUrl, close }}
 */
async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise(resolve => server.close(resolve));
  return { server, baseUrl, close };
}

/** Mock that returns a valid reranker response */
function successHandler(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/v1/rerank' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(RERANKER_SUCCESS_RESPONSE));
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
}

/** Mock that returns HTTP 500 */
function errorHandler(req, res) {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'internal server error' }));
}

/** Mock that never responds (simulates timeout) */
function hangingHandler(_req, _res) {
  // Intentionally never calls res.end()
}

/** Mock that returns /health 200 but /v1/rerank 503 */
function healthyButRerankFailsHandler(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy' }));
  } else {
    res.writeHead(503);
    res.end('Service Unavailable');
  }
}

// ============================================================================
// rerankCandidates — happy path
// ============================================================================

test('rerankCandidates returns candidates sorted by rerankScore (term sheet > meeting > SAFE > dog > grocery)', async () => {
  const { baseUrl, close } = await startMockServer(successHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    const result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);

    assert.equal(result.length, MOCK_CANDIDATES.length, 'should return same number of candidates');
    assert.equal(result[0].id, 1, 'term sheet should be ranked first');
    assert.equal(result[1].id, 5, 'Series A meeting should be ranked second');
    assert.equal(result[2].id, 3, 'SAFE note should be ranked third');
    assert.equal(result[4].id, 2, 'grocery list should be ranked last');
  } finally {
    await close();
  }
});

test('rerankCandidates populates rerankScore on all returned candidates', async () => {
  const { baseUrl, close } = await startMockServer(successHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    const result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);

    for (const candidate of result) {
      assert.ok(typeof candidate.rerankScore === 'number', `id=${candidate.id} should have rerankScore`);
      assert.ok(candidate.rerankScore >= 0 && candidate.rerankScore <= 1,
        `id=${candidate.id} rerankScore should be in [0,1], got ${candidate.rerankScore}`);
    }
  } finally {
    await close();
  }
});

test('rerankCandidates sends a single HTTP request for all candidates (not N requests)', async () => {
  let requestCount = 0;
  const countingHandler = (req, res) => {
    if (req.url === '/v1/rerank') requestCount++;
    successHandler(req, res);
  };
  const { baseUrl, close } = await startMockServer(countingHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);
    assert.equal(requestCount, 1, 'should send exactly 1 request for all candidates');
  } finally {
    await close();
  }
});

test('rerankCandidates preserves all candidate fields (id, content, rrfScore) after reranking', async () => {
  const { baseUrl, close } = await startMockServer(successHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    const result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);

    const originalById = Object.fromEntries(MOCK_CANDIDATES.map(c => [c.id, c]));
    for (const candidate of result) {
      const original = originalById[candidate.id];
      assert.ok(original, `returned id=${candidate.id} not in original candidates`);
      assert.equal(candidate.content, original.content, 'content should be preserved');
      assert.equal(candidate.rrfScore, original.rrfScore, 'rrfScore should be preserved');
    }
  } finally {
    await close();
  }
});

// ============================================================================
// rerankCandidates — graceful degradation
// ============================================================================

test('rerankCandidates returns candidates sorted by rrfScore when service is unreachable', async () => {
  const config = parseRerankerConfig({ reranker: { baseUrl: 'http://127.0.0.1:19999', enabled: true, timeoutMs: 500 } });
  const result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);

  // Should not throw
  assert.equal(result.length, MOCK_CANDIDATES.length, 'should return all candidates');
  // Should be sorted by rrfScore (original order)
  for (let i = 0; i < result.length - 1; i++) {
    assert.ok(result[i].rrfScore >= result[i + 1].rrfScore,
      `degraded results should be sorted by rrfScore at index ${i}`);
  }
  // rerankScore should be undefined on all (not reranked)
  for (const candidate of result) {
    assert.equal(candidate.rerankScore, undefined, `id=${candidate.id} should have no rerankScore on failure`);
  }
});

test('rerankCandidates returns candidates sorted by rrfScore when service returns HTTP 500', async () => {
  const { baseUrl, close } = await startMockServer(errorHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    const result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);

    assert.equal(result.length, MOCK_CANDIDATES.length);
    for (let i = 0; i < result.length - 1; i++) {
      assert.ok(result[i].rrfScore >= result[i + 1].rrfScore,
        `should fall back to rrfScore order at index ${i}`);
    }
  } finally {
    await close();
  }
});

test('rerankCandidates returns candidates sorted by rrfScore when service times out', async () => {
  const { baseUrl, close } = await startMockServer(hangingHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true, timeoutMs: 200 } });
    const start = Date.now();
    const result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1000, `should abort within 1s, took ${elapsed}ms`);
    assert.equal(result.length, MOCK_CANDIDATES.length);
    for (const c of result) assert.equal(c.rerankScore, undefined);
  } finally {
    await close();
  }
});

test('rerankCandidates never throws — always returns an array', async () => {
  const config = parseRerankerConfig({ reranker: { baseUrl: 'http://127.0.0.1:1', enabled: true, timeoutMs: 100 } });
  let result;
  // This must not throw even with an invalid port
  result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);
  assert.ok(Array.isArray(result), 'should always return an array');
});

// ============================================================================
// rerankCandidates — skip conditions
// ============================================================================

test('rerankCandidates skips reranking when config.enabled = false', async () => {
  let requestCount = 0;
  const countingHandler = (req, res) => { requestCount++; successHandler(req, res); };
  const { baseUrl, close } = await startMockServer(countingHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: false } });
    const result = await rerankCandidates(MOCK_QUERY, MOCK_CANDIDATES, config, NOOP_LOGGER);

    assert.equal(requestCount, 0, 'should not make any HTTP request when disabled');
    assert.equal(result.length, MOCK_CANDIDATES.length);
    for (const c of result) assert.equal(c.rerankScore, undefined);
  } finally {
    await close();
  }
});

test('rerankCandidates skips reranking when candidates.length < minCandidates', async () => {
  let requestCount = 0;
  const countingHandler = (req, res) => { requestCount++; successHandler(req, res); };
  const { baseUrl, close } = await startMockServer(countingHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true, minCandidates: 5 } });
    const fewCandidates = MOCK_CANDIDATES.slice(0, 3); // only 3, threshold is 5
    const result = await rerankCandidates(MOCK_QUERY, fewCandidates, config, NOOP_LOGGER);

    assert.equal(requestCount, 0, 'should not rerank when below minCandidates threshold');
    assert.equal(result.length, 3);
  } finally {
    await close();
  }
});

test('rerankCandidates handles empty candidates array', async () => {
  const { baseUrl, close } = await startMockServer(successHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    const result = await rerankCandidates(MOCK_QUERY, [], config, NOOP_LOGGER);
    assert.deepEqual(result, [], 'should return empty array for empty input');
  } finally {
    await close();
  }
});

test('rerankCandidates truncates content to 2000 chars before sending', async () => {
  let receivedBody = null;
  const capturingHandler = (req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Return a valid response for the candidates received
      const results = receivedBody.documents.map((_, i) => ({ index: i, relevance_score: 0.5 }));
      res.end(JSON.stringify({ results }));
    });
  };
  const { baseUrl, close } = await startMockServer(capturingHandler);
  try {
    const longContent = 'A'.repeat(5000);
    const candidates = [{ id: 1, content: longContent, rrfScore: 0.9 }];
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true, minCandidates: 1 } });
    await rerankCandidates(MOCK_QUERY, candidates, config, NOOP_LOGGER);

    assert.ok(receivedBody !== null, 'should have received a request body');
    assert.ok(receivedBody.documents[0].length <= 2000,
      `content should be truncated to ≤2000 chars, got ${receivedBody.documents[0].length}`);
  } finally {
    await close();
  }
});

// ============================================================================
// checkRerankerHealth
// ============================================================================

test('checkRerankerHealth returns true when service responds 200', async () => {
  const { baseUrl, close } = await startMockServer(successHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    const healthy = await checkRerankerHealth(config);
    assert.equal(healthy, true);
  } finally {
    await close();
  }
});

test('checkRerankerHealth returns false when service is unreachable', async () => {
  const config = parseRerankerConfig({ reranker: { baseUrl: 'http://127.0.0.1:19998', enabled: true } });
  const healthy = await checkRerankerHealth(config);
  assert.equal(healthy, false);
});

test('checkRerankerHealth returns false when service hangs beyond 1s', async () => {
  const { baseUrl, close } = await startMockServer(hangingHandler);
  try {
    const config = parseRerankerConfig({ reranker: { baseUrl, enabled: true } });
    const start = Date.now();
    const healthy = await checkRerankerHealth(config);
    const elapsed = Date.now() - start;
    assert.equal(healthy, false);
    assert.ok(elapsed < 2000, `health check should abort within 2s, took ${elapsed}ms`);
  } finally {
    await close();
  }
});

// ============================================================================
// parseRerankerConfig
// ============================================================================

test('parseRerankerConfig applies defaults when reranker section is absent', () => {
  const config = parseRerankerConfig({});
  assert.equal(config.baseUrl, 'http://127.0.0.1:9000');
  assert.equal(config.enabled, true);
  assert.equal(config.timeoutMs, 3000);
  assert.equal(config.minCandidates, 3);
  assert.equal(config.rerankTopK, 30);
  assert.equal(config.model, 'reranker');
});

test('parseRerankerConfig merges partial config with defaults', () => {
  const config = parseRerankerConfig({ reranker: { timeoutMs: 1500, minCandidates: 5 } });
  assert.equal(config.baseUrl, 'http://127.0.0.1:9000'); // default
  assert.equal(config.timeoutMs, 1500);                   // overridden
  assert.equal(config.minCandidates, 5);                  // overridden
  assert.equal(config.rerankTopK, 30);                    // default
});

test('parseRerankerConfig strips trailing slash from baseUrl', () => {
  const config = parseRerankerConfig({ reranker: { baseUrl: 'http://127.0.0.1:9000/' } });
  assert.equal(config.baseUrl, 'http://127.0.0.1:9000');
});

test('parseRerankerConfig throws on invalid baseUrl', () => {
  assert.throws(
    () => parseRerankerConfig({ reranker: { baseUrl: 'not-a-url' } }),
    /baseUrl/,
    'should throw with message mentioning baseUrl',
  );
});

test('parseRerankerConfig throws on negative timeoutMs', () => {
  assert.throws(
    () => parseRerankerConfig({ reranker: { timeoutMs: -1 } }),
    /timeoutMs/,
  );
});

test('parseRerankerConfig throws on minCandidates < 1', () => {
  assert.throws(
    () => parseRerankerConfig({ reranker: { minCandidates: 0 } }),
    /minCandidates/,
  );
});

test('parseRerankerConfig clamps rerankTopK to [1, 100]', () => {
  const low = parseRerankerConfig({ reranker: { rerankTopK: 0 } });
  assert.equal(low.rerankTopK, 1);

  const high = parseRerankerConfig({ reranker: { rerankTopK: 999 } });
  assert.equal(high.rerankTopK, 100);
});

test('parseRerankerConfig enabled=false disables reranker regardless of other settings', () => {
  const config = parseRerankerConfig({ reranker: { enabled: false, baseUrl: 'http://127.0.0.1:9000' } });
  assert.equal(config.enabled, false);
});
