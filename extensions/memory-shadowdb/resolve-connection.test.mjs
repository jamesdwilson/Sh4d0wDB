/**
 * resolve-connection.test.mjs — Unit tests for resolveConnectionString
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from './dist/index.js';

// resolveConnectionString is exported from config.js — import directly
import { resolveConnectionString } from './dist/config.js';

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const snapshot = {};
  for (const k of keys) {
    snapshot[k] = process.env[k];
    if (overrides[k] == null) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of keys) {
      if (snapshot[k] == null) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}

test('resolveConnectionString returns explicit plugin config first', () => {
  withEnv({ SHADOWDB_URL: 'postgres://env/db', DATABASE_URL: 'postgres://fallback/db' }, () => {
    const result = resolveConnectionString({ connectionString: 'postgres://explicit/db' });
    assert.equal(result, 'postgres://explicit/db');
  });
});

test('resolveConnectionString uses SHADOWDB_URL over DATABASE_URL', () => {
  withEnv({ SHADOWDB_URL: 'postgres://shadow/db', DATABASE_URL: 'postgres://generic/db' }, () => {
    const result = resolveConnectionString({});
    assert.equal(result, 'postgres://shadow/db');
  });
});

test('resolveConnectionString falls back to DATABASE_URL', () => {
  withEnv({ SHADOWDB_URL: null, DATABASE_URL: 'postgres://generic/db' }, () => {
    const result = resolveConnectionString({});
    assert.equal(result, 'postgres://generic/db');
  });
});

test('resolveConnectionString returns a postgresql:// string when nothing explicitly configured', () => {
  withEnv({ SHADOWDB_URL: null, DATABASE_URL: null }, () => {
    const result = resolveConnectionString({});
    assert.ok(result.startsWith('postgresql://'), `got: ${result}`);
  });
});
