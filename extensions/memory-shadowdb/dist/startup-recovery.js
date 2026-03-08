/**
 * startup-recovery.ts — Startup Recovery for ShadowDB
 *
 * Scans operations log for orphaned writes at plugin startup.
 * Logs warnings for any pending operations older than 1 minute.
 */
import { OperationsLog } from './durability-ops-log.js';
/**
 * Initialize startup recovery scan
 * Call this when the plugin starts up
 */
export async function initializeStartupRecovery() {
    try {
        // Get global log instance (creates new one)
        const log = new OperationsLog();
        const orphans = log.scanOrphans();
        if (orphans.length > 0) {
            console.warn(`[ShadowDB Startup Recovery] Found ${orphans.length} orphaned write operation(s):`);
            orphans.forEach((orphan, idx) => {
                console.warn(`  [${idx + 1}] ID: ${orphan.operationId}, Type: ${orphan.operation}, Category: ${orphan.category}, Time: ${orphan.timestamp}`);
            });
            console.warn(`[ShadowDB Startup Recovery] These operations never completed. Check the operations log for details.`);
            return orphans.length;
        }
        return 0;
    }
    catch (err) {
        // Silently fail - startup recovery is optional
        console.warn('[ShadowDB Startup Recovery] Failed to scan for orphans:', err);
        return 0;
    }
}
//# sourceMappingURL=startup-recovery.js.map