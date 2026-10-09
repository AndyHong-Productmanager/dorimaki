// Debounced async callback with centralized shutdown flushing.
// Used for persistence paths that should batch writes during runtime
// while allowing the bot's single SIGTERM/SIGINT handler to flush all callbacks.
const processFlushCallbacks = new Set();
export async function flushDebouncedProcessCallbacks() {
    const callbacks = [...processFlushCallbacks];
    await Promise.allSettled(callbacks.map((callback) => {
        return callback();
    }));
}
export function createDebouncedProcessFlush({ waitMs, callback, onError, }) {
    let timeout;
    let inFlight;
    let dirty = false;
    async function run() {
        if (!dirty) {
            return;
        }
        if (inFlight) {
            await inFlight;
            if (!dirty) {
                return;
            }
        }
        dirty = false;
        const current = Promise.resolve()
            .then(() => {
            return callback();
        })
            .catch((error) => {
            if (onError) {
                const wrappedError = error instanceof Error
                    ? error
                    : new Error('Debounced process flush failed', { cause: error });
                onError(wrappedError);
            }
        });
        inFlight = current;
        await current;
        if (inFlight === current) {
            inFlight = undefined;
        }
        if (dirty) {
            await run();
        }
    }
    function trigger() {
        dirty = true;
        if (timeout) {
            return;
        }
        timeout = setTimeout(() => {
            timeout = undefined;
            void run();
        }, waitMs);
    }
    async function flush() {
        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
        await run();
    }
    const processFlushCallback = async () => {
        await flush();
    };
    processFlushCallbacks.add(processFlushCallback);
    async function dispose() {
        processFlushCallbacks.delete(processFlushCallback);
        await flush();
    }
    return {
        trigger,
        flush,
        dispose,
    };
}
