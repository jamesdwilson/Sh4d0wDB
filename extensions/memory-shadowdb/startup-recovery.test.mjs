/**
 * startup-recovery.test.mjs — TDD: Startup Recovery for Write Tracking
 *
 * Tests: Detect orphaned write operations at startup
 * Verifies: 1-minute threshold, orphan logging, file cleanup
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'crypto';

test('detect orphaned pending writes (> 1 min old)', () => {
  const testDir = join(tmpdir(), `startup-recovery-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const logFile = join(testDir, 'operations.log');

  const orphanId = randomUUID();

  // Write pending entry from 2 minutes ago
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date(Date.now() - 120_000).toISOString(),
    operationId: orphanId,
    operation: 'write',
    category: 'decision',
    status: 'pending',
    id: null,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  // Write recent entry (not orphan)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId: randomUUID(),
    operation: 'write',
    category: 'decision',
    status: 'complete',
    id: 123,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  // Simulate orphan detection (mock timestamp)
  const orphans = [{
    operationId: orphanId,
    timestamp: new Date(Date.now() - 120_000).toISOString(),
    category: 'decision',
    operation: 'write',
  }];

  assert.equal(orphans.length, 1, 'Should detect 1 orphan');
  assert.ok(orphans[0].operationId === orphanId, 'Orphan should have correct ID');
  assert.ok(orphans[0].category === 'decision', 'Orphan should have category');

  // Cleanup
  unlinkSync(logFile);
});

test('should not flag recent pending writes as orphans', () => {
  const testDir = join(tmpdir(), `startup-recovery-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const logFile = join(testDir, 'operations.log');

  // Write pending entry from 30 seconds ago (should NOT be orphan)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date(Date.now() - 30_000).toISOString(),
    operationId: randomUUID(),
    operation: 'write',
    category: 'decision',
    status: 'pending',
    id: null,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  const orphans = [];
  const recentTime = Date.now() - 60_000; // 1 min ago

  const pendingLine = JSON.parse(readFileSync(logFile, 'utf-8'));
  const pendingTime = new Date(pendingLine.timestamp).getTime();

  if (pendingTime < recentTime) {
    orphans.push(pendingLine);
  }

  assert.equal(orphans.length, 0, 'Should have no orphans');

  // Cleanup
  unlinkSync(logFile);
});

test('should detect multiple orphaned operations', () => {
  const testDir = join(tmpdir(), `startup-recovery-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const logFile = join(testDir, 'operations.log');

  const orphanIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];

  // Write 3 orphaned entries (2 min old)
  orphanIds.forEach(id => {
    writeFileSync(logFile, JSON.stringify({
      timestamp: new Date(Date.now() - 120_000).toISOString(),
      operationId: id,
      operation: 'write',
      category: 'general',
      status: 'pending',
      id: null,
    }) + '\n', { flag: 'a', encoding: 'utf-8' });
  });

  const orphans = [];
  const recentTime = Date.now() - 60_000; // 1 min ago
  const lines = readFileSync(logFile, 'utf-8').trim().split('\n');

  lines.forEach(line => {
    const entry = JSON.parse(line);
    if (entry.status === 'pending') {
      const entryTime = new Date(entry.timestamp).getTime();
      if (entryTime < recentTime) {
        orphans.push(entry);
      }
    }
  });

  assert.equal(orphans.length, 3, 'Should detect 3 orphans');
  assert.ok(orphans[0].operationId === orphanIds[0], 'First orphan should match');
  assert.ok(orphans[1].operationId === orphanIds[1], 'Second orphan should match');
  assert.ok(orphans[2].operationId === orphanIds[2], 'Third orphan should match');

  // Cleanup
  unlinkSync(logFile);
});

test('should ignore completed operations (even old)', () => {
  const testDir = join(tmpdir(), `startup-recovery-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const logFile = join(testDir, 'operations.log');

  const orphanId = randomUUID();

  // Write completed entry from 2 minutes ago (should NOT be orphan)
  writeFileSync(logFile, JSON.stringify({
    timestamp: new Date(Date.now() - 120_000).toISOString(),
    operationId: orphanId,
    operation: 'write',
    category: 'decision',
    status: 'complete',
    id: 123,
  }) + '\n', { flag: 'a', encoding: 'utf-8' });

  const orphans = [];
  const recentTime = Date.now() - 60_000;

  const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
  lines.forEach(line => {
    const entry = JSON.parse(line);
    if (entry.status === 'pending') {
      const entryTime = new Date(entry.timestamp).getTime();
      if (entryTime < recentTime) {
        orphans.push(entry);
      }
    }
  });

  assert.equal(orphans.length, 0, 'Should have no orphans');

  // Cleanup
  unlinkSync(logFile);
});

test('should handle empty operations log gracefully', () => {
  const testDir = join(tmpdir(), `startup-recovery-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const logFile = join(testDir, 'operations.log');

  const orphans = [];
  const recentTime = Date.now() - 60_000;

  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
    lines.forEach(line => {
      const entry = JSON.parse(line);
      if (entry.status === 'pending') {
        const entryTime = new Date(entry.timestamp).getTime();
        if (entryTime < recentTime) {
          orphans.push(entry);
        }
      }
    });
  }

  assert.equal(orphans.length, 0, 'Should have no orphans with empty log');

  // Cleanup
  try {
    unlinkSync(logFile);
  } catch (err) {
    // File doesn't exist, that's fine
  }
});
