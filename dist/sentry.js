// Sentry stubs. @sentry/node was removed — these are no-op placeholders
// so the 20+ files importing notifyError/initSentry don't need changing.
// If Sentry is re-enabled in the future, replace these stubs with real calls.
/**
 * Initialize Sentry. Currently a no-op.
 */
export function initSentry(_opts) { }
/**
 * Report an unexpected error. Currently a no-op.
 * Safe to call even if Sentry is not initialized.
 * Fire-and-forget only: use `void notifyError(error, msg)` and never await it.
 */
export function notifyError(_error, _msg) { }
/**
 * User-readable error class. Messages from AppError instances
 * are forwarded to the user as-is; regular Error messages may be obfuscated.
 */
export class AppError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AppError';
    }
}
