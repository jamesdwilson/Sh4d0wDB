import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';

// Import what we're testing
import { createOperationsLog, OperationsLog, generateOperationId } from './dist/write-durability.js';

describe('idempotency (Phase 4: duplicate detection)', () => {
  let log;
  let pendingPath;
  let completedPath;

  before(() => {
    // Clean up any existing files
    const opsDir = `${process.env.HOME}/.shadowdb`;
    const pendingFile = `${opsDir}/pending-writes.jsonl`;
    const completedFile = `${opsDir}/completed-writes.jsonl`;

    if (fs.existsSync(pendingFile)) {
      fs.unlinkSync(pendingFile);
    }
    if (fs.existsSync(completedFile)) {
      fs.unlinkSync(completedFile);
    }
  });

  after(() => {
    if (fs.existsSync(pendingPath)) {
      fs.unlinkSync(pendingPath);
    }
    if (fs.existsSync(completedPath)) {
      fs.unlinkSync(completedPath);
    }
  });

  it('should detect duplicate operationId', async () => {
    // Clean before test
    pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
    completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);

    log = createOperationsLog();
    const operationId = generateOperationId();

    // First write
    log.appendCompleted({
      timestamp: new Date().toISOString(),
      operationId,
      operation: 'write',
      status: 'complete',
      id: 42,
      category: 'general'
    });

    // Should detect duplicate
    assert.strictEqual(log.hasOperation(operationId), true);
  });

  it('should return false for non-existent operationId', async () => {
    // Clean before test
    pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
    completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);

    log = createOperationsLog();

    // Should not find non-existent operation
    assert.strictEqual(log.hasOperation('non-existent-id'), false);
  });

  it('should not detect duplicate for pending-only operation', async () => {
    // Clean before test
    pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
    completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);

    log = createOperationsLog();
    const operationId = generateOperationId();

    // Only pending, not completed
    log.appendPending({
      timestamp: new Date().toISOString(),
      operationId,
      operation: 'write',
      status: 'pending',
      category: 'general'
    });

    // Should NOT detect as duplicate (only completed count)
    assert.strictEqual(log.hasOperation(operationId), false);
  });

  it('should generate unique operationIds', async () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateOperationId());
    }
    assert.strictEqual(ids.size, 100, 'All IDs should be unique');
  });
});
