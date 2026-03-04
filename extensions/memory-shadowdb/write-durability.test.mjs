import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';

// Import what we're testing
import { createOperationsLog, OperationsLog } from './dist/write-durability.js';

describe('write-durability (Phase 4: Idempotency)', () => {
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

  it('should append pending entry to pending-writes.jsonl', async () => {
    // Clean before test
    pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
    completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);

    log = createOperationsLog();

    log.appendPending({
      timestamp: new Date().toISOString(),
      operationId: 'test-id-1',
      operation: 'write',
      status: 'pending',
      category: 'general'
    });

    const content = await fs.promises.readFile(pendingPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.operationId, 'test-id-1');
    assert.strictEqual(entry.operation, 'write');
    assert.strictEqual(entry.status, 'pending');
  });

  it('should append completed entry to completed-writes.jsonl', async () => {
    // Clean before test
    pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
    completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);

    log = createOperationsLog();

    log.appendCompleted({
      timestamp: new Date().toISOString(),
      operationId: 'test-id-1',
      operation: 'write',
      status: 'complete',
      id: 42,
      category: 'general'
    });

    const content = await fs.promises.readFile(completedPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.operationId, 'test-id-1');
    assert.strictEqual(entry.id, 42);
    assert.strictEqual(entry.status, 'complete');
  });

  it('should append both pending and completed entries', async () => {
    // Clean before test
    pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
    completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);

    log = createOperationsLog();

    log.appendPending({
      timestamp: new Date().toISOString(),
      operationId: 'test-id-1',
      operation: 'write',
      status: 'pending',
      category: 'general'
    });

    log.appendCompleted({
      timestamp: new Date().toISOString(),
      operationId: 'test-id-1',
      operation: 'write',
      status: 'complete',
      id: 42,
      category: 'general'
    });

    const pendingContent = await fs.promises.readFile(pendingPath, 'utf-8');
    const completedContent = await fs.promises.readFile(completedPath, 'utf-8');

    assert.strictEqual(pendingContent.trim().split('\n').length, 1);
    assert.strictEqual(completedContent.trim().split('\n').length, 1);
  });

  it('should handle multiple operations', async () => {
    // Clean before test
    pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
    completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;
    if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
    if (fs.existsSync(completedPath)) fs.unlinkSync(completedPath);

    log = createOperationsLog();

    const ids = ['id-1', 'id-2', 'id-3'];
    ids.forEach(id => {
      log.appendPending({
        timestamp: new Date().toISOString(),
        operationId: id,
        operation: 'write',
        status: 'pending',
        category: 'general'
      });
    });

    const content = await fs.promises.readFile(pendingPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 3);

    lines.forEach((line, i) => {
      const entry = JSON.parse(line);
      assert.strictEqual(entry.operationId, ids[i]);
    });
  });

  it('should handle empty operations', async () => {
    // No-op, just verify no crash
    assert.doesNotThrow(() => {
      log = createOperationsLog();
      pendingPath = `${process.env.HOME}/.shadowdb/pending-writes.jsonl`;
      completedPath = `${process.env.HOME}/.shadowdb/completed-writes.jsonl`;

      log.appendPending({
        timestamp: new Date().toISOString(),
        operationId: 'test-id',
        operation: 'write',
        status: 'pending',
        category: 'general'
      });
    });
  });
});
