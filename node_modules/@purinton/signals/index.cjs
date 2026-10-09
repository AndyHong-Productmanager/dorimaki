const logger = require('@purinton/log');

// Store shutdown hooks and state per processObj for test isolation
const shutdownHooksMap = new WeakMap();
const shuttingDownMap = new WeakMap();
const registeredProcesses = new WeakSet();

/**
 * Sets up shutdown handlers for the process.
 * @param {Object} options
 * @param {Object} [options.processObj=process] - The process object to attach handlers to.
 * @param {Object} [options.log=logger] - Logger for output.
 * @param {string[]} [options.signals=['SIGTERM', 'SIGINT', 'SIGHUP']] - Signals to listen for.
 * @param {Function} [options.shutdownHook] - Optional hook to call during shutdown.
 * @returns {Object} { shutdown, getShuttingDown }
 */
function registerSignals({
    processObj = process,
    log = logger,
    signals = ['SIGTERM', 'SIGINT', 'SIGHUP'],
    shutdownHook
} = {}) {
    if (!shutdownHooksMap.has(processObj)) shutdownHooksMap.set(processObj, []);
    if (!shuttingDownMap.has(processObj)) shuttingDownMap.set(processObj, false);
    if (shutdownHook) shutdownHooksMap.get(processObj).push(shutdownHook);

    const getShuttingDown = () => shuttingDownMap.get(processObj);
    const shutdown = async (signal) => {
        if (shuttingDownMap.get(processObj)) {
            log.warn(`Received ${signal} again, but already shutting down.`);
            return;
        }
        shuttingDownMap.set(processObj, true);
        log.debug(`Received ${signal}. Shutting down gracefully...`);
        try {
            for (const hook of shutdownHooksMap.get(processObj)) {
                await hook(signal);
            }
        } catch (err) {
            log.error('Error during shutdown hook:', err);
        }
        processObj.exit(0);
    };
    if (!registeredProcesses.has(processObj)) {
        signals.forEach(signal => {
            processObj.on(signal, () => shutdown(signal));
        });
        // Also handle process exit and beforeExit
        const runAllHooksOnExit = async (code) => {
            if (!shuttingDownMap.get(processObj)) {
                shuttingDownMap.set(processObj, true);
                log.debug(`Process exiting (code ${code}). Running shutdown hooks...`);
                try {
                    for (const hook of shutdownHooksMap.get(processObj)) {
                        await hook('exit');
                    }
                } catch (err) {
                    log.error('Error during shutdown hook:', err);
                }
            }
        };
        processObj.on('exit', runAllHooksOnExit);
        processObj.on('beforeExit', runAllHooksOnExit);
        log.debug('Registered Handlers', { signals: signals.join(', ') });
        registeredProcesses.add(processObj);
    }
    return { shutdown, getShuttingDown };
}

module.exports = registerSignals;
module.exports.default = registerSignals;
module.exports.registerSignals = registerSignals;
