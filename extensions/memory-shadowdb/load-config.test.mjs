/**
 * load-config.test.mjs — Unit tests for loadShadowDbConfig
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadShadowDbConfig } from './dist/config.js';

test('loadShadowDbConfig returns parsed config from explicit path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadowdb-test-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ postgres: { host: 'myhost', database: 'mydb' } }));
  const result = loadShadowDbConfig(file);
  assert.equal(result?.postgres?.host, 'myhost');
  assert.equal(result?.postgres?.database, 'mydb');
  unlinkSync(file);
});

test('loadShadowDbConfig does not throw for missing file', () => {
  // Falls through to ~/.shadowdb.json — either returns home config or null
  const result = loadShadowDbConfig('/nonexistent/path/shadowdb.json');
  assert.ok(result === null || typeof result === 'object');
});

test('loadShadowDbConfig skips invalid JSON and does not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadowdb-test-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, 'not valid json {{{');
  // Falls through to ~/.shadowdb.json — either returns home config or null
  const result = loadShadowDbConfig(file);
  assert.ok(result === null || typeof result === 'object');
  unlinkSync(file);
});

test('loadShadowDbConfig skips missing explicit path and tries next', () => {
  // Missing explicit path → falls through to home config (if present) or null
  // Either way, should not throw
  const result = loadShadowDbConfig('/tmp/__shadowdb_definitely_missing_xyz.json');
  assert.ok(result === null || typeof result === 'object');
});
