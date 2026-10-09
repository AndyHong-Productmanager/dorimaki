// Type definitions, tagged errors, and constants for forum sync.
// All shared types and error classes live here to avoid circular dependencies
// between the sync modules.
import * as errore from 'errore';
// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
export const DEFAULT_DEBOUNCE_MS = 800;
export const DEFAULT_RATE_LIMIT_DELAY_MS = 250;
export const WRITE_IGNORE_TTL_MS = 2_000;
// ═══════════════════════════════════════════════════════════════════════════
// TAGGED ERRORS
// ═══════════════════════════════════════════════════════════════════════════
export class ForumChannelResolveError extends errore.createTaggedError({
    name: 'ForumChannelResolveError',
    message: 'Could not resolve forum channel $forumChannelId',
}) {
}
export class ForumSyncOperationError extends errore.createTaggedError({
    name: 'ForumSyncOperationError',
    message: 'Forum sync operation failed for forum $forumChannelId: $reason',
}) {
}
export class ForumFrontmatterParseError extends errore.createTaggedError({
    name: 'ForumFrontmatterParseError',
    message: 'Failed to parse frontmatter: $reason',
}) {
}
// ═══════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
export function delay({ ms }) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/** Mark a file path as recently written so the file watcher ignores it. */
export function addIgnoredPath({ runtimeState, filePath, }) {
    if (!runtimeState)
        return;
    runtimeState.ignoredPaths.set(filePath, Date.now() + WRITE_IGNORE_TTL_MS);
}
/** Check if a file path was recently written by us and should be ignored. */
export function shouldIgnorePath({ runtimeState, filePath, }) {
    const expiresAt = runtimeState.ignoredPaths.get(filePath);
    if (!expiresAt)
        return false;
    if (expiresAt < Date.now()) {
        runtimeState.ignoredPaths.delete(filePath);
        return false;
    }
    return true;
}
