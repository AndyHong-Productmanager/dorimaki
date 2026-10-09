// Type declarations for signals
import log from '@purinton/log';

/**
 * Sets up shutdown handlers for the process.
 * @param options Options for shutdown handler setup.
 * @param options.processObj The process object to attach handlers to.
 * @param options.log Logger for output.
 * @param options.signals Signals to listen for.
 * @returns An object with shutdown and getShuttingDown functions.
 */
export interface RegisterSignalsOptions {
    processObj?: NodeJS.Process;
    log?: typeof log;
    signals?: string[];
    /** Optional async function called during shutdown with the signal */
    shutdownHook?: (signal: string) => Promise<void>;
}

export function registerSignals(options?: RegisterSignalsOptions): {
    shutdown: (signal: string) => Promise<void>;
    getShuttingDown: () => boolean;
};

export default registerSignals;
