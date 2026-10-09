// Reusable debounce helper for timeout-based callbacks.
// Encapsulates the timer handle and exposes trigger/clear/isPending so callers
// can batch clustered events without leaking timeout state into domain logic.
export function createDebouncedTimeout({ delayMs, callback, }) {
    let timeout = null;
    function clear() {
        if (!timeout) {
            return;
        }
        clearTimeout(timeout);
        timeout = null;
    }
    function trigger() {
        clear();
        timeout = setTimeout(() => {
            timeout = null;
            callback();
        }, delayMs);
    }
    function isPending() {
        return timeout !== null;
    }
    return {
        trigger,
        clear,
        isPending,
    };
}
