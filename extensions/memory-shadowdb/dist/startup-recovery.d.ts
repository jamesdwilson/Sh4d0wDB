/**
 * startup-recovery.ts — Startup Recovery for ShadowDB
 *
 * Scans operations log for orphaned writes at plugin startup.
 * Logs warnings for any pending operations older than 1 minute.
 */
/**
 * Initialize startup recovery scan
 * Call this when the plugin starts up
 */
export declare function initializeStartupRecovery(): Promise<number>;
