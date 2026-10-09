import logger from '@purinton/log';

/**
 * Registers process-level exception handlers for uncaught exceptions, unhandled rejections, warnings, and exit events.
 * @param {Object} options
 * @param {Object} [options.processObj=process] - The process object to attach handlers to.
 * @param {Object} [options.log=logger] - Logger for output.
 * @returns {Object} { removeHandlers } - Function to remove all registered handlers (for testability).
 */
export const registerHandlers = ({
  processObj = process,
  log = logger
} = {}) => {
  const handlers = {
    uncaughtException: (err) => log.error('Uncaught Exception', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
      error: err
    }),
    unhandledRejection: (reason, promise) => log.error('Unhandled Rejection', {
      reason: reason instanceof Error ? {
        name: reason.name,
        message: reason.message,
        stack: reason.stack,
        error: reason
      } : reason,
      promise
    }),
    warning: (warning) => log.warn('Warning', {
      name: warning?.name,
      message: warning?.message,
      stack: warning?.stack,
      warning
    })
  };
  processObj.on('uncaughtException', handlers.uncaughtException);
  processObj.on('unhandledRejection', handlers.unhandledRejection);
  processObj.on('warning', handlers.warning);
  const removeHandlers = () => {
    processObj.off('uncaughtException', handlers.uncaughtException);
    processObj.off('unhandledRejection', handlers.unhandledRejection);
    processObj.off('warning', handlers.warning);
  };
  log.debug('Exception handlers registered');
  return { removeHandlers };
};

export default registerHandlers;
