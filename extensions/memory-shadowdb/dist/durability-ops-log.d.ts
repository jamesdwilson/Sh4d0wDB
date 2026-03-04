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
export declare class OperationsLog {
    private readonly logPath;
    private readonly operationId;
    constructor(operationId?: string);
    /**
     * Append a pending operation entry
     */
    appendPending(operation: OperationType, category: string): Promise<void>;
    /**
     * Append a completed operation entry
     */
    appendComplete(operation: OperationType, id: number, category: string): Promise<void>;
    /**
     * Append an error entry
     */
    appendError(operation: OperationType, category: string | null, errorMessage: string): Promise<void>;
    /**
     * Write a log entry (internal method)
     */
    private _writeEntry;
    /**
     * Get the log path for debugging
     */
    getLogPath(): string;
    /**
     * Get the operation ID for debugging
     */
    getOperationId(): string;
    /**
     * Scan for orphaned pending operations (> 1 minute old)
     * @returns Array of orphaned operations
     */
    scanOrphans(): OperationsLogEntry[];
}
export declare function getGlobalLog(): OperationsLog;
export declare function resetGlobalLog(): void;
