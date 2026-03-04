import { describe, it, expect } from 'node:test';
import assert from 'assert';
// Import what we're testing
import { createOperationsLog, OperationsLog } from './dist/write-durability.js';
describe('write-durability (Phase 4: Idempotency)', () => {
    let log;
    let pendingPath;
    let completedPath;
    beforeEach(() => {
        // Clean up any existing files
        const opsDir = `${process.env.HOME}/.shadowdb`;
        const pendingFile = `${opsDir}/pending-writes.jsonl`;
        const completedFile = `${opsDir}/completed-writes.jsonl`;
        if (require('fs').existsSync(pendingFile)) {
            require('fs').unlinkSync(pendingFile);
        }
        if (require('fs').existsSync(completedFile)) {
            require('fs').unlinkSync(completedFile);
        }
        log = createOperationsLog();
        pendingPath = pendingFile;
        completedPath = completedFile;
    });
    afterEach(() => {
        if (require('fs').existsSync(pendingPath)) {
            require('fs').unlinkSync(pendingPath);
        }
        if (require('fs').existsSync(completedPath)) {
            require('fs').unlinkSync(completedPath);
        }
    });
    it('should append pending entry to pending-writes.jsonl', () => {
        log.appendPending({
            timestamp: new Date().toISOString(),
            operationId: 'test-id-1',
            operation: 'write',
            status: 'pending',
            category: 'general'
        });
        const content = require('fs').readFileSync(pendingPath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines.length).toBe(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            operationId: 'test-id-1',
            operation: 'write',
            status: 'pending'
        });
    });
    it('should append completed entry to completed-writes.jsonl', () => {
        log.appendCompleted({
            timestamp: new Date().toISOString(),
            operationId: 'test-id-1',
            operation: 'write',
            status: 'complete',
            id: 42,
            category: 'general'
        });
        const content = require('fs').readFileSync(completedPath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines.length).toBe(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            operationId: 'test-id-1',
            id: 42,
            status: 'complete'
        });
    });
    it('should append both pending and completed entries', () => {
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
        const pendingContent = require('fs').readFileSync(pendingPath, 'utf-8');
        const completedContent = require('fs').readFileSync(completedPath, 'utf-8');
        expect(pendingContent.trim().split('\n').length).toBe(1);
        expect(completedContent.trim().split('\n').length).toBe(1);
    });
    it('should handle multiple operations', () => {
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
        const content = require('fs').readFileSync(pendingPath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines.length).toBe(3);
        lines.forEach((line, i) => {
            const entry = JSON.parse(line);
            expect(entry.operationId).toBe(ids[i]);
        });
    });
    it('should handle empty operations', () => {
        // No-op, just verify no crash
        expect(() => {
            log.appendPending({
                timestamp: new Date().toISOString(),
                operationId: 'test-id',
                operation: 'write',
                status: 'pending',
                category: 'general'
            });
        }).not.toThrow();
    });
});
