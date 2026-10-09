// Debug helper for writing raw OpenCode event stream entries as JSONL.
// When enabled, writes one file per session ID so event ordering and
// lifecycle behavior can be analyzed with jq.
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../config.js';
import { FilesystemOperationError } from '../errors.js';
let eventLogDirPromise = null;
let eventLogWriteDisabled = false;
export function isOpencodeSessionEventLogEnabled() {
    return process.env['DORIMAKI_LOG_OPENCODE_SESSION_EVENTS'] === '1';
}
function sessionIdFromEventProperties(properties) {
    if (!properties || typeof properties !== 'object') {
        return undefined;
    }
    const sessionID = Reflect.get(properties, 'sessionID');
    if (typeof sessionID === 'string') {
        return sessionID;
    }
    const info = Reflect.get(properties, 'info');
    if (info && typeof info === 'object') {
        const id = Reflect.get(info, 'id');
        if (typeof id === 'string') {
            return id;
        }
        const infoSessionId = Reflect.get(info, 'sessionID');
        if (typeof infoSessionId === 'string') {
            return infoSessionId;
        }
    }
    const part = Reflect.get(properties, 'part');
    if (part && typeof part === 'object') {
        const partSessionId = Reflect.get(part, 'sessionID');
        if (typeof partSessionId === 'string') {
            return partSessionId;
        }
    }
    return undefined;
}
export function getOpencodeEventSessionId(event) {
    switch (event.type) {
        case 'message.updated':
            return event.properties.info.sessionID;
        case 'message.part.updated':
            return event.properties.part.sessionID;
        case 'message.part.delta':
        case 'message.part.removed':
        case 'session.status':
        case 'session.idle':
        case 'session.diff':
        case 'permission.asked':
        case 'permission.replied':
        case 'question.asked':
        case 'question.replied':
        case 'question.rejected':
            return event.properties.sessionID;
        case 'session.error':
            return event.properties.sessionID;
        case 'session.created':
        case 'session.updated':
        case 'session.deleted':
            return event.properties.info.id;
        default:
            // session.next.* and later SDK events put sessionID on properties.
            return sessionIdFromEventProperties(event.properties);
    }
}
function sanitizeSessionIdForFilename(sessionId) {
    return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}
async function resolveEventLogDirectory() {
    if (!eventLogDirPromise) {
        eventLogDirPromise = (async () => {
            const configuredEventLogDir = process.env['DORIMAKI_OPENCODE_SESSION_EVENTS_DIR'];
            const baseDir = configuredEventLogDir || path.join(getDataDir(), 'opencode-session-events');
            await fs.promises.mkdir(baseDir, { recursive: true });
            return baseDir;
        })();
    }
    return eventLogDirPromise;
}
export function buildOpencodeEventLogLine({ timestamp, threadId, projectDirectory, event, }) {
    return {
        timestamp,
        threadId,
        projectDirectory,
        event,
    };
}
export async function appendOpencodeSessionEventLog(entry) {
    if (!isOpencodeSessionEventLogEnabled() || eventLogWriteDisabled) {
        return null;
    }
    const sessionId = getOpencodeEventSessionId(entry.event);
    if (!sessionId) {
        return null;
    }
    const logDirResult = await resolveEventLogDirectory()
        .catch((e) => new FilesystemOperationError({ operation: 'resolveEventLogDir', cause: e }));
    if (logDirResult instanceof Error) {
        eventLogWriteDisabled = true;
        return logDirResult;
    }
    const safeSessionId = sanitizeSessionIdForFilename(sessionId);
    const logFilePath = path.join(logDirResult, `${safeSessionId}.jsonl`);
    const now = Date.now();
    const line = `${JSON.stringify(buildOpencodeEventLogLine({
        timestamp: now,
        threadId: entry.threadId,
        projectDirectory: entry.projectDirectory,
        event: entry.event,
    }))}\n`;
    const appendResult = await fs.promises.appendFile(logFilePath, line, 'utf8')
        .catch((e) => new FilesystemOperationError({ operation: 'appendEventLog', cause: e }));
    if (appendResult instanceof Error) {
        eventLogWriteDisabled = true;
        return appendResult;
    }
    return null;
}
