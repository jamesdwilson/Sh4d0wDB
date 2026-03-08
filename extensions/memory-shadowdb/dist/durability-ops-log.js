/**
 * durability-ops-log.ts — Operations Log for Write Tracking
 *
 * Tracks write/update/delete operations with IDs to distinguish:
 * - Successful writes (ID returned, log shows "complete")
 * - Failed writes (log shows "error")
 * - Tool never called (no log entry at all)
 *
 * Usage:
 * ```typescript
 * import { OperationsLog } from './durability-ops-log.js';
 *
 * const log = new OperationsLog();
 * await log.appendPendingWrite(operationId, category);
 * const result = await someWriteOperation();
 * await log.appendCompleteWrite(operationId, result.id, category);
 * await log.appendError(operationId, errorMessage);
 * ```
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'crypto';
export class OperationsLog {
    logPath;
    operationId;
    constructor(operationId = randomUUID()) {
        // Use environment variable for log directory, fallback to temp dir
        const logDir = process.env.SHADOWDB_LOG_DIR || join(tmpdir(), 'shadowdb-ops-log');
        this.logPath = join(logDir, 'operations.log');
        this.operationId = operationId;
        // Ensure log directory exists
        try {
            if (!existsSync(logDir)) {
                mkdirSync(logDir, { recursive: true });
            }
        }
        catch (err) {
            // Silently fail if permission denied
        }
    }
    /**
     * Append a pending operation entry
     */
    async appendPending(operation, category) {
        const entry = {
            timestamp: new Date().toISOString(),
            operationId: this.operationId,
            operation,
            category,
            status: 'pending',
            id: null,
        };
        this._writeEntry(entry);
    }
    /**
     * Append a completed operation entry
     */
    async appendComplete(operation, id, category) {
        const entry = {
            timestamp: new Date().toISOString(),
            operationId: this.operationId,
            operation,
            category,
            status: 'complete',
            id,
        };
        this._writeEntry(entry);
    }
    /**
     * Append an error entry
     */
    async appendError(operation, category, errorMessage) {
        const entry = {
            timestamp: new Date().toISOString(),
            operationId: this.operationId,
            operation,
            category: category || 'general',
            status: 'error',
            id: null,
            error: errorMessage,
        };
        this._writeEntry(entry);
    }
    /**
     * Write a log entry (internal method)
     */
    _writeEntry(entry) {
        try {
            // Append mode to avoid overwriting existing entries
            writeFileSync(this.logPath, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf-8' });
        }
        catch (err) {
            // Silently fail - log writing is not critical for operation success
            // The write itself (to DB) will fail if it can't log
            console.warn(`Failed to write operations log: ${err}`);
        }
    }
    /**
     * Get the log path for debugging
     */
    getLogPath() {
        return this.logPath;
    }
    /**
     * Get the operation ID for debugging
     */
    getOperationId() {
        return this.operationId;
    }
    /**
     * Scan for orphaned pending operations (> 1 minute old)
     * @returns Array of orphaned operations
     */
    scanOrphans() {
        try {
            if (!existsSync(this.logPath)) {
                return [];
            }
            const recentTime = Date.now() - 60_000; // 1 minute ago
            const orphans = [];
            const lines = readFileSync(this.logPath, 'utf-8').trim().split('\n');
            lines.forEach(line => {
                try {
                    const entry = JSON.parse(line);
                    // Only flag pending operations as orphans
                    if (entry.status === 'pending') {
                        const entryTime = new Date(entry.timestamp).getTime();
                        if (entryTime < recentTime) {
                            orphans.push(entry);
                        }
                    }
                }
                catch (err) {
                    // Skip invalid JSON lines
                    // continue; // Don't need continue here, we're in forEach
                }
            });
            return orphans;
        }
        catch (err) {
            return [];
        }
    }
}
/**
 * Legacy helper for existing code (single global log)
 */
let globalLog = null;
export function getGlobalLog() {
    if (!globalLog) {
        globalLog = new OperationsLog();
    }
    return globalLog;
}
export function resetGlobalLog() {
    globalLog = null;
}
//# sourceMappingURL=durability-ops-log.js.map