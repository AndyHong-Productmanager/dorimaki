// Tracks which OpenCode sessions last edited each file.
// Plugin appends JSONL events; CLI derives the per-file session list on read.
import fs from 'node:fs';
import path from 'node:path';
import * as errore from 'errore';
import { FilesystemOperationError } from './errors.js';
import { extractPatchFilePaths } from './patch-text-parser.js';
import { createPluginLogger, setPluginLogFilePath } from './plugin-logger.js';
const logger = createPluginLogger('FILEEDIT');
export const FILE_EDIT_EVENTS_FILENAME = 'file-edit-events.jsonl';
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_COMPACT_AFTER_BYTES = 5 * 1024 * 1024;
function isFileEditTool(tool) {
    return tool === 'edit' || tool === 'write' || tool === 'apply_patch';
}
function getStringField({ args, key }) {
    const value = args[key];
    return typeof value === 'string' ? value : '';
}
export function extractEditedFiles({ tool, args, directory, }) {
    const name = tool.toLowerCase();
    if (name === 'edit' || name === 'write') {
        const filePath = getStringField({ args, key: 'filePath' });
        if (!filePath)
            return [];
        return [path.resolve(directory, filePath)];
    }
    if (name !== 'apply_patch')
        return [];
    const patchText = getStringField({ args, key: 'patchText' });
    if (!patchText)
        return [];
    return extractPatchFilePaths(patchText).map((filePath) => {
        return path.resolve(directory, filePath);
    });
}
export function editorsForFile({ events, filePath, cwd, }) {
    const resolved = path.resolve(cwd, filePath);
    const latestBySession = new Map();
    for (const event of events) {
        if (path.resolve(event.file) !== resolved)
            continue;
        const previous = latestBySession.get(event.sessionId);
        if (previous === undefined || event.at > previous) {
            latestBySession.set(event.sessionId, event.at);
        }
    }
    return [...latestBySession.entries()]
        .map(([sessionId, at]) => {
        return { sessionId, at };
    })
        .sort((left, right) => {
        return right.at - left.at;
    });
}
function parseFileEditEvent(line) {
    const parsed = errore.try(() => JSON.parse(line), (cause) => new FilesystemOperationError({ operation: 'parse file edit event', cause }));
    if (parsed instanceof Error)
        return null;
    if (!parsed || typeof parsed !== 'object')
        return null;
    if (parsed.v !== 1)
        return null;
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at))
        return null;
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0)
        return null;
    if (typeof parsed.file !== 'string' || parsed.file.length === 0)
        return null;
    if (typeof parsed.tool !== 'string' || !isFileEditTool(parsed.tool))
        return null;
    return {
        v: 1,
        at: parsed.at,
        sessionId: parsed.sessionId,
        file: parsed.file,
        tool: parsed.tool,
    };
}
function nodeErrorCode(error) {
    const cause = error.cause;
    if (!cause || typeof cause !== 'object')
        return '';
    const code = Reflect.get(cause, 'code');
    return typeof code === 'string' ? code : '';
}
export function loadFileEditEvents({ dataDir }) {
    const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME);
    const raw = errore.try(() => fs.readFileSync(logPath, 'utf8'), (cause) => new FilesystemOperationError({ operation: 'read file edit log', cause }));
    if (raw instanceof Error) {
        if (nodeErrorCode(raw) === 'ENOENT')
            return [];
        return raw;
    }
    const events = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        const event = parseFileEditEvent(line);
        if (event)
            events.push(event);
    }
    return events;
}
function collapseFileEditEvents(events) {
    const latest = new Map();
    for (const event of events) {
        const key = `${event.sessionId}\0${event.file}`;
        const previous = latest.get(key);
        if (!previous || event.at >= previous.at)
            latest.set(key, event);
    }
    return [...latest.values()].sort((left, right) => {
        return left.at - right.at;
    });
}
function compactFileEditLog({ dataDir, maxEvents, }) {
    const loaded = loadFileEditEvents({ dataDir });
    if (loaded instanceof Error)
        return loaded;
    const collapsed = collapseFileEditEvents(loaded);
    const kept = collapsed.length > maxEvents ? collapsed.slice(-maxEvents) : collapsed;
    const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME);
    const tempPath = `${logPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const body = kept.map((event) => `${JSON.stringify(event)}\n`).join('');
    const written = errore.try(() => {
        fs.writeFileSync(tempPath, body);
        fs.renameSync(tempPath, logPath);
    }, (cause) => new FilesystemOperationError({ operation: 'compact file edit log', cause }));
    if (written instanceof Error) {
        fs.rmSync(tempPath, { force: true });
        return written;
    }
}
export function appendFileEditEvents({ dataDir, events, maxEvents = DEFAULT_MAX_EVENTS, compactAfterBytes = DEFAULT_COMPACT_AFTER_BYTES, }) {
    if (events.length === 0)
        return;
    const logPath = path.join(dataDir, FILE_EDIT_EVENTS_FILENAME);
    const prepared = errore.try(() => {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.appendFileSync(logPath, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    }, (cause) => new FilesystemOperationError({ operation: 'append file edit log', cause }));
    if (prepared instanceof Error)
        return prepared;
    const size = errore.try(() => fs.statSync(logPath).size, (cause) => new FilesystemOperationError({ operation: 'stat file edit log', cause }));
    if (size instanceof Error)
        return size;
    if (size < compactAfterBytes)
        return;
    return compactFileEditLog({ dataDir, maxEvents });
}
function recordToolEdits({ dataDir, directory, sessionId, tool, args, }) {
    const name = tool.toLowerCase();
    if (!isFileEditTool(name))
        return;
    const files = extractEditedFiles({ tool: name, args, directory });
    if (files.length === 0)
        return;
    const at = Date.now();
    const events = files.map((file) => {
        return {
            v: 1,
            at,
            sessionId,
            file,
            tool: name,
        };
    });
    const result = appendFileEditEvents({ dataDir, events });
    if (result instanceof Error) {
        logger.warn('Failed to record file edit', result.message);
    }
}
export function createFileEditHooks({ dataDir, directory, }) {
    return {
        'tool.execute.after': async (input) => {
            recordToolEdits({
                dataDir,
                directory,
                sessionId: input.sessionID,
                tool: input.tool,
                args: input.args,
            });
        },
    };
}
export const fileEditTrackerPlugin = async ({ directory }) => {
    const dataDir = process.env.DORIMAKI_DATA_DIR;
    if (!dataDir)
        return {};
    setPluginLogFilePath(dataDir);
    const created = errore.try(() => fs.mkdirSync(dataDir, { recursive: true }), (cause) => new FilesystemOperationError({ operation: 'create file edit log dir', cause }));
    if (created instanceof Error) {
        logger.warn('Failed to create file edit log dir', created.message);
    }
    return createFileEditHooks({ dataDir, directory });
};
