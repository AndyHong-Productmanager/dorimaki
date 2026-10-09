import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { sanitizeSensitiveText, sanitizeUnknownValue } from './privacy-sanitizer.js';
let pluginLogFilePath = null;
export function setPluginLogFilePath(dataDir) {
    pluginLogFilePath = path.join(dataDir, 'dorimaki.log');
}
function formatArg(arg) {
    if (typeof arg === 'string') {
        return sanitizeSensitiveText(arg, { redactPaths: false });
    }
    const safeArg = sanitizeUnknownValue(arg, { redactPaths: false });
    return util.inspect(safeArg, { colors: false, depth: 4 });
}
export function formatPluginErrorWithStack(error) {
    if (error instanceof Error) {
        return sanitizeSensitiveText(error.stack ?? `${error.name}: ${error.message}`, { redactPaths: false });
    }
    if (typeof error === 'string') {
        return sanitizeSensitiveText(error, { redactPaths: false });
    }
    const safeError = sanitizeUnknownValue(error, { redactPaths: false });
    return sanitizeSensitiveText(util.inspect(safeError, { colors: false, depth: 4 }), {
        redactPaths: false,
    });
}
function writeToFile(level, prefix, args) {
    if (!pluginLogFilePath) {
        return;
    }
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] [${level}] [${prefix}] ${args.map(formatArg).join(' ')}\n`;
    try {
        fs.appendFileSync(pluginLogFilePath, message);
    }
    catch {
        // Plugin logging must never break the OpenCode plugin process.
    }
}
const LOG_LEVEL_MAP = {
    LOG: 'info',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
    DEBUG: 'debug',
};
export function createPluginLogger(prefix) {
    let boundClient = null;
    let boundService = prefix;
    function writeToOpencode(level, args) {
        if (!boundClient)
            return;
        const message = args.map(formatArg).join(' ');
        void boundClient.app
            .log({
            service: boundService,
            level: LOG_LEVEL_MAP[level] || 'info',
            message,
            extra: {},
        })
            .catch(() => {
            // Logging must never break plugin logic.
        });
    }
    return {
        // Bind an OpenCode v2 client so log calls also emit to OpenCode's
        // structured logger via client.app.log. Call once after creating the
        // client. The service name groups all entries from this plugin.
        bindClient(client, service) {
            boundClient = client;
            if (service)
                boundService = service;
        },
        log: (...args) => {
            writeToFile('LOG', prefix, args);
            writeToOpencode('LOG', args);
        },
        info: (...args) => {
            writeToFile('INFO', prefix, args);
            writeToOpencode('INFO', args);
        },
        warn: (...args) => {
            writeToFile('WARN', prefix, args);
            writeToOpencode('WARN', args);
        },
        error: (...args) => {
            writeToFile('ERROR', prefix, args);
            writeToOpencode('ERROR', args);
        },
        debug: (...args) => {
            writeToFile('DEBUG', prefix, args);
            writeToOpencode('DEBUG', args);
        },
    };
}
// Append a session ID marker at the end of a toast message so the bot-side
// handleTuiToast can route the toast to the correct Discord thread.
// Without this marker the toast is silently dropped.
export function appendToastSessionMarker({ message, sessionId, }) {
    if (!sessionId) {
        return message;
    }
    return `${message} ${sessionId}`;
}
