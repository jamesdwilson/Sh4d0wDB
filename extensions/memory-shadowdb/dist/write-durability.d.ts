/**
 * Write Durability Module (Phase 4: Idempotency)
 *
 * Provides operation tracking with operationId for idempotent writes.
 * Uses JSONL files for append-only logging (pending/completed).
 */
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
/**
 * Create a new OperationsLog instance
 */
export declare function createOperationsLog(): OperationsLog;
/**
 * OperationsLog - tracks write operations for durability
 */
export declare class OperationsLog {
    /**
     * Append a pending operation entry
     */
    appendPending(entry: PendingEntry): void;
    /**
     * Append a completed operation entry
     */
    appendCompleted(entry: CompletedEntry): void;
    /**
     * Append a failed operation entry
     */
    appendFailed(entry: FailedEntry): void;
    /**
     * Check if an operationId already exists (idempotency check)
     */
    hasOperation(operationId: string): boolean;
    /**
     * Get pending operations that have no matching completed entry (orphans)
     */
    getOrphans(): OperationsLogEntry[];
    /**
     * Clear completed entries (for testing/debugging)
     */
    clearCompleted(): void;
}
/**
 * Generate a new operationId for idempotent writes
 */
export declare function generateOperationId(): string;
/**
 * Create a default pending entry for a write operation
 */
export declare function createPendingEntry(category: string, contentHash: string): PendingEntry;
/**
 * Create a default completed entry
 */
export declare function createCompletedEntry(id: number, category: string, operationId: string): CompletedEntry;
