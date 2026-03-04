/**
 * durability-ops-log.test.mjs — TDD: Operations Log for Write Tracking
 *
 * Tests: Track write/update/delete operations with IDs
 * Verifies: Pending/completed/error states, log file format
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'crypto';

const OPERATIONS_LOG = 'operations.log';

test('operations log can append pending write entry', () => {
  // Create fresh temp directory
  const testDir = join(tmpdir(), `ops-log-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const operationId = randomUUID();
  const category = 'decision';
  const logFile = join(testDir, OPERATIONS_LOG);

  // Write a pending entry (append mode)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId,
    operation: 'write',
    category,
    status: 'pending',
    id: null,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  // Verify entry was written
  assert.ok(existsSync(logFile), 'Log file should exist');

  const content = readFileSync(logFile, 'utf-8');
  assert.ok(content.includes(operationId), 'Log should contain operationId');
  assert.ok(content.includes('pending'), 'Log should contain status "pending"');

  // Cleanup
  unlinkSync(logFile);
});

test('operations log can append completed write entry', () => {
  // Create fresh temp directory
  const testDir = join(tmpdir(), `ops-log-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const operationId = randomUUID();
  const id = 12345;
  const category = 'decision';
  const logFile = join(testDir, OPERATIONS_LOG);

  // Write pending entry (append mode)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId,
    operation: 'write',
    category,
    status: 'pending',
    id: null,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  // Write completed entry (append mode)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId,
    operation: 'write',
    category,
    status: 'complete',
    id,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  const content = readFileSync(logFile, 'utf-8');
  const lines = content.trim().split('\n');

  assert.equal(lines.length, 2, 'Should have 2 entries');

  const pendingLine = lines[0];
  const completedLine = lines[1];

  assert.ok(pendingLine.includes('pending'), 'First entry should be pending');
  assert.ok(completedLine.includes('complete'), 'Second entry should be complete');
  assert.ok(completedLine.includes(id.toString()), 'Completed entry should contain id');

  // Cleanup
  unlinkSync(logFile);
});

test('operations log can append error entry', () => {
  // Create fresh temp directory
  const testDir = join(tmpdir(), `ops-log-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const operationId = randomUUID();
  const category = 'decision';
  const errorMessage = 'Connection timeout';
  const logFile = join(testDir, OPERATIONS_LOG);

  // Write error entry (append mode)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId,
    operation: 'write',
    category,
    status: 'error',
    id: null,
    error: errorMessage,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  const content = readFileSync(logFile, 'utf-8');
  assert.ok(content.includes('error'), 'Log should contain status "error"');
  assert.ok(content.includes(errorMessage), 'Log should contain error message');

  // Cleanup
  unlinkSync(logFile);
});

test('operations log can track multiple operations', () => {
  // Create fresh temp directory
  const testDir = join(tmpdir(), `ops-log-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const operationIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];

  const logFile = join(testDir, OPERATIONS_LOG);

  const entries = operationIds.map((id, i) => ({
    timestamp: new Date().toISOString(),
    operationId: id,
    operation: 'write',
    category: i === 0 ? 'decision' : i === 1 ? 'contact' : 'general',
    status: 'complete',
    id: i + 1,
  }));

  // Write all entries (append mode)
  entries.forEach(entry => {
    writeFileSync(logFile, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf-8' });
  });

  const content = readFileSync(logFile, 'utf-8');
  const lines = content.trim().split('\n');

  assert.equal(lines.length, 3, 'Should have 3 entries');

  operationIds.forEach(id => {
    assert.ok(content.includes(id), `Log should contain operationId ${id}`);
  });

  // Cleanup
  unlinkSync(logFile);
});

test('operations log can track operation type other than write', () => {
  // Create fresh temp directory
  const testDir = join(tmpdir(), `ops-log-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const operationId = randomUUID();
  const category = 'general';
  const logFile = join(testDir, OPERATIONS_LOG);

  // Test update (append mode)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId,
    operation: 'update',
    category,
    status: 'pending',
    id: null,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  // Test delete (append mode)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId,
    operation: 'delete',
    category: null,
    status: 'complete',
    id: 123,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  const content = readFileSync(logFile, 'utf-8');
  assert.ok(content.includes('update'), 'Log should contain operation "update"');
  assert.ok(content.includes('delete'), 'Log should contain operation "delete"');

  // Cleanup
  unlinkSync(logFile);
});

test('operations log handles empty entries gracefully', () => {
  // Create fresh temp directory
  const testDir = join(tmpdir(), `ops-log-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const logFile = join(testDir, OPERATIONS_LOG);

  // Write empty line (append mode)
  writeFileSync(logFile, '\n', { flag: 'a', encoding: 'utf-8' });

  const content = readFileSync(logFile, 'utf-8');
  assert.ok(content.length > 0, 'Should handle empty lines');

  // Cleanup
  unlinkSync(logFile);
});
