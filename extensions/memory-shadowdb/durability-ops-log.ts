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

export type OperationType = 'write' | 'update' | 'delete';
export type OperationStatus = 'pending' | 'complete' | 'error';

export interface OperationsLogEntry {
  timestamp: string;
  operationId: string;
  operation: OperationType;
  category: string;
  status: OperationStatus;
  id: number | null;
  error?: string;
}

export class OperationsLog {
  private readonly logPath: string;
  private readonly operationId: string;

  constructor(operationId: string = randomUUID()) {
    // Use environment variable for log directory, fallback to temp dir
    const logDir = process.env.SHADOWDB_LOG_DIR || join(tmpdir(), 'shadowdb-ops-log');
    this.logPath = join(logDir, 'operations.log');
    this.operationId = operationId;

    // Ensure log directory exists
    try {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    } catch (err) {
      // Silently fail if permission denied
    }
  }

  /**
   * Append a pending operation entry
   */
  async appendPending(
    operation: OperationType,
    category: string
  ): Promise<void> {
    const entry: OperationsLogEntry = {
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
  async appendComplete(
    operation: OperationType,
    id: number,
    category: string
  ): Promise<void> {
    const entry: OperationsLogEntry = {
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
  async appendError(
    operation: OperationType,
    category: string | null,
    errorMessage: string
  ): Promise<void> {
    const entry: OperationsLogEntry = {
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
  private _writeEntry(entry: OperationsLogEntry): void {
    try {
      // Append mode to avoid overwriting existing entries
      writeFileSync(this.logPath, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf-8' });
    } catch (err) {
      // Silently fail - log writing is not critical for operation success
      // The write itself (to DB) will fail if it can't log
      console.warn(`Failed to write operations log: ${err}`);
    }
  }

  /**
   * Get the log path for debugging
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Get the operation ID for debugging
   */
  getOperationId(): string {
    return this.operationId;
  }

  /**
   * Scan for orphaned pending operations (> 1 minute old)
   * @returns Array of orphaned operations
   */
  scanOrphans(): OperationsLogEntry[] {
    try {
      if (!existsSync(this.logPath)) {
        return [];
      }

      const recentTime = Date.now() - 60_000; // 1 minute ago
      const orphans: OperationsLogEntry[] = [];

      const lines = readFileSync(this.logPath, 'utf-8').trim().split('\n');
      
      lines.forEach(line => {
        try {
          const entry: OperationsLogEntry = JSON.parse(line);
          
          // Only flag pending operations as orphans
          if (entry.status === 'pending') {
            const entryTime = new Date(entry.timestamp).getTime();
            if (entryTime < recentTime) {
              orphans.push(entry);
            }
          }
        } catch (err) {
          // Skip invalid JSON lines
          // continue; // Don't need continue here, we're in forEach
        }
      });

      return orphans;
    } catch (err) {
      return [];
    }
  }
}

/**
 * Legacy helper for existing code (single global log)
 */
let globalLog: OperationsLog | null = null;

export function getGlobalLog(): OperationsLog {
  if (!globalLog) {
    globalLog = new OperationsLog();
  }
  return globalLog;
}

export function resetGlobalLog(): void {
  globalLog = null;
}
