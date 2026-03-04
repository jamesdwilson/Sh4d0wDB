/**
 * Write Durability Module (Phase 4: Idempotency)
 *
 * Provides operation tracking with operationId for idempotent writes.
 * Uses JSONL files for append-only logging (pending/completed).
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';

export interface OperationsLogEntry {
  timestamp: string;
  operationId: string;
  operation: 'write' | 'update' | 'delete';
  status: 'pending' | 'complete' | 'failed';
  category?: string;
  id?: number;
  error?: string;
}

export interface PendingEntry extends OperationsLogEntry {
  status: 'pending';
}

export interface CompletedEntry extends OperationsLogEntry {
  status: 'complete';
  id: number;
}

export interface FailedEntry extends OperationsLogEntry {
  status: 'failed';
  error: string;
}

// Constants
const OPS_DIR = `${process.env.HOME}/.shadowdb`;
const PENDING_FILE = `${OPS_DIR}/pending-writes.jsonl`;
const COMPLETED_FILE = `${OPS_DIR}/completed-writes.jsonl`;

/**
 * Create a new OperationsLog instance
 */
export function createOperationsLog(): OperationsLog {
  return new OperationsLog();
}

/**
 * OperationsLog - tracks write operations for durability
 */
export class OperationsLog {
  /**
   * Append a pending operation entry
   */
  appendPending(entry: PendingEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(PENDING_FILE, line, 'utf-8');
  }

  /**
   * Append a completed operation entry
   */
  appendCompleted(entry: CompletedEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(COMPLETED_FILE, line, 'utf-8');
  }

  /**
   * Append a failed operation entry
   */
  appendFailed(entry: FailedEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(COMPLETED_FILE, line, 'utf-8');
  }

  /**
   * Check if an operationId already exists (idempotency check)
   */
  hasOperation(operationId: string): boolean {
    try {
      const completedContent = fs.readFileSync(COMPLETED_FILE, 'utf-8');
      const lines = completedContent.trim().split('\n');

      return lines.some(line => {
        const entry = JSON.parse(line);
        return entry.operationId === operationId && entry.status === 'complete';
      });
    } catch (err) {
      // File doesn't exist or is empty
      return false;
    }
  }

  /**
   * Get pending operations that have no matching completed entry (orphans)
   */
  getOrphans(): OperationsLogEntry[] {
    try {
      const pendingContent = fs.readFileSync(PENDING_FILE, 'utf-8');
      const completedContent = fs.readFileSync(COMPLETED_FILE, 'utf-8');

      const pendingLines = pendingContent.trim().split('\n').filter(Boolean);
      const completedLines = completedContent.trim().split('\n').filter(Boolean);

      const pendingIds = new Set(
        pendingLines.map(line => JSON.parse(line).operationId)
      );

      const completedIds = new Set(
        completedLines.map(line => JSON.parse(line).operationId)
      );

      const orphanIds = [...pendingIds].filter(id => !completedIds.has(id));

      return pendingLines
        .filter(line => orphanIds.includes(JSON.parse(line).operationId))
        .map(line => JSON.parse(line));
    } catch (err) {
      // File doesn't exist or is empty
      return [];
    }
  }

  /**
   * Clear completed entries (for testing/debugging)
   */
  clearCompleted(): void {
    try {
      fs.unlinkSync(COMPLETED_FILE);
    } catch (err) {
      // File doesn't exist, no-op
    }
  }
}

/**
 * Generate a new operationId for idempotent writes
 */
export function generateOperationId(): string {
  return randomUUID();
}

/**
 * Create a default pending entry for a write operation
 */
export function createPendingEntry(
  category: string,
  contentHash: string
): PendingEntry {
  return {
    timestamp: new Date().toISOString(),
    operationId: generateOperationId(),
    operation: 'write',
    status: 'pending',
    category
  };
}

/**
 * Create a default completed entry
 */
export function createCompletedEntry(
  id: number,
  category: string,
  operationId: string
): CompletedEntry {
  return {
    timestamp: new Date().toISOString(),
    operationId,
    operation: 'write',
    status: 'complete',
    id,
    category
  };
}
