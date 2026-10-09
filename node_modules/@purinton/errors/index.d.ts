import log from '@purinton/log';

/**
 * Registers process-level exception handlers for uncaught exceptions, unhandled rejections, warnings, and exit events.
 * @param options
 * @param options.processObj The process object to attach handlers to (default: process).
 * @param options.log Logger for output (default: log).
 * @returns { removeHandlers } Function to remove all registered handlers (for testability).
 */
export declare function registerHandlers(
  options?: {
    processObj?: NodeJS.Process,
    log?: typeof log
  }
): { removeHandlers: () => void };
