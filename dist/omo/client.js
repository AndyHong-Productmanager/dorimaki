// OpencodeClient-shaped adapter backed by the omo app-server (Codex
// app-server JSON-RPC protocol). Lets dorimaki's Discord runtime keep its
// existing SDK call surface while the engine underneath is omo.
//
// Mapping highlights:
//   session.create      -> thread/start    (cwd + model)
//   session.promptAsync -> turn/start      (text parts -> input blocks)
//   session.abort       -> turn/interrupt
//   session.messages    -> thread/resume   (turns[].items[] -> info+parts)
//   permission.reply    -> JSON-RPC result for a pending server request
//   question.reply      -> JSON-RPC result for a pending server request
//   global.event        -> async generator over translated notifications
import { createLogger, LogPrefix } from '../logger.js';
import { OmoRpcConnection } from './rpc.js';
import { translateOmoNotification } from './events.js';
import { ensureOmoServer, getOmoServerWsUrl, readOmoWsToken, subscribeOmoServerLifecycle, } from './server.js';
const logger = createLogger(LogPrefix.OPENCODE);
// ── Shared connection ──────────────────────────────────────────
let connection = null;
let initialized = false;
let initializing = null;
const eventCallbacks = new Set();
const sessionStatus = new Map();
const sessionModels = new Map();
const sessionSystems = new Map();
const activeTurns = new Map(); // threadId -> turnId
const pendingServerRequests = new Map();
async function getConnection() {
    const serverResult = await ensureOmoServer();
    if (serverResult instanceof Error)
        return serverResult;
    if (connection && initialized)
        return connection;
    if (initializing) {
        const r = await initializing;
        if (r instanceof Error)
            return r;
        return connection;
    }
    initializing = (async () => {
        const url = getOmoServerWsUrl();
        const token = readOmoWsToken();
        if (!url || !token)
            return new Error('omo app-server url/token unavailable');
        const conn = new OmoRpcConnection(url, token);
        conn.onNotification((n) => {
            for (const ev of translateOmoNotification(n)) {
                if (ev.type === 'session.status' && ev.properties.sessionID) {
                    sessionStatus.set(ev.properties.sessionID, ev.properties.status);
                }
                if (ev.type === 'session.idle' && ev.properties.sessionID) {
                    sessionStatus.set(ev.properties.sessionID, { type: 'idle' });
                    activeTurns.delete(ev.properties.sessionID);
                }
                for (const cb of eventCallbacks)
                    cb({ payload: ev });
            }
        });
        conn.onServerRequest(async (req) => handleServerRequest(req));
        conn.onClose(() => {
            initialized = false;
            connection = null;
            for (const cb of eventCallbacks) {
                cb({ payload: { type: 'server.connected', properties: {} } });
            }
        });
        try {
            await conn.connect();
            await conn.call('initialize', {
                clientInfo: { name: 'dorimaki', version: '0.1.0' },
            });
        }
        catch (e) {
            return e instanceof Error ? e : new Error(String(e));
        }
        connection = conn;
        initialized = true;
        logger.log('[OMO CLIENT] connected and initialized');
        return true;
    })();
    const r = await initializing;
    initializing = null;
    if (r instanceof Error)
        return r;
    return connection;
}
subscribeOmoServerLifecycle((event) => {
    if (event.type === 'started') {
        initialized = false;
        connection = null;
    }
});
// ── Server-initiated requests (approvals / questions) ─────────
let nextRequestNum = 0;
async function handleServerRequest(req) {
    const isQuestion = /requestUserInput|question/i.test(req.method);
    const isApproval = /approval|permission|elicitation/i.test(req.method);
    if (!isQuestion && !isApproval) {
        logger.log(`[OMO CLIENT] unhandled server request ${req.method}, auto-approving with empty result`);
        return {};
    }
    const requestID = `omo-req-${req.rpcId}-${++nextRequestNum}`;
    const threadId = req.params.threadId ?? req.params.thread_id ?? '';
    return new Promise((resolve) => {
        pendingServerRequests.set(requestID, { ...req, respond: resolve });
        if (isQuestion) {
            const questions = req.params.questions ?? [{
                    id: 'q1',
                    header: req.params.title ?? 'Question',
                    question: req.params.prompt ?? req.params.message ?? JSON.stringify(req.params),
                    options: req.params.options ?? [],
                }];
            emitToAll({
                type: 'question.asked',
                properties: {
                    id: requestID,
                    sessionID: threadId,
                    questions,
                    tool: req.params.tool ? { messageID: '', callID: '' } : undefined,
                },
            });
        }
        else {
            emitToAll({
                type: 'permission.asked',
                properties: {
                    id: requestID,
                    sessionID: threadId,
                    permission: req.method,
                    patterns: req.params.patterns ?? [],
                    metadata: req.params,
                    always: [],
                    tool: undefined,
                },
            });
        }
    });
}
function emitToAll(event) {
    for (const cb of eventCallbacks)
        cb({ payload: event });
}
function replyToServerRequest(requestID, result) {
    const pending = pendingServerRequests.get(requestID);
    if (!pending)
        return false;
    pendingServerRequests.delete(requestID);
    pending.respond(result);
    return true;
}
// ── Helpers ────────────────────────────────────────────────────
function splitItemId(itemId) {
    const idx = itemId.lastIndexOf(':');
    return { messageId: idx === -1 ? itemId : itemId.slice(0, idx) };
}
function threadToSession(thread) {
    return {
        id: thread.id,
        directory: thread.cwd,
        title: thread.name ?? thread.preview ?? '',
        time: {
            created: (thread.createdAt ?? 0) * 1000,
            updated: (thread.updatedAt ?? 0) * 1000,
        },
    };
}
function threadToMessages(thread) {
    const messages = new Map();
    for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
            const { messageId } = splitItemId(item.id ?? '');
            if (!messages.has(messageId)) {
                messages.set(messageId, {
                    info: {
                        id: messageId,
                        sessionID: thread.id,
                        role: item.type === 'userMessage' ? 'user' : 'assistant',
                        time: { created: item.startedAtMs ?? turn.startedAt ?? Date.now() },
                    },
                    parts: [],
                });
            }
            const msg = messages.get(messageId);
            if (item.type === 'userMessage') {
                const text = (item.content ?? []).map((c) => c.text ?? '').join('\n');
                msg.parts.push({ id: `part_${item.id}`, sessionID: thread.id, messageID: messageId, type: 'text', text });
            }
            else if (item.type === 'agentMessage') {
                msg.parts.push({ id: `part_${item.id}`, sessionID: thread.id, messageID: messageId, type: 'text', text: item.text ?? '' });
            }
            else if (item.type === 'reasoning') {
                msg.parts.push({
                    id: `part_${item.id}`,
                    sessionID: thread.id,
                    messageID: messageId,
                    type: 'reasoning',
                    text: Array.isArray(item.content) ? item.content.join('\n') : '',
                });
            }
            else if (item.type === 'dynamicToolCall' || item.type === 'toolCall') {
                msg.parts.push({
                    id: `part_${item.id}`,
                    sessionID: thread.id,
                    messageID: messageId,
                    type: 'tool',
                    tool: item.tool ?? 'unknown',
                    callID: item.id,
                    state: { status: 'completed', input: item.arguments ?? {}, output: '', time: { start: 0 } },
                });
            }
        }
    }
    return [...messages.values()];
}
export function createOmoClient({ directory }) {
    const session = {
        async create(params) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            const model = params?.model
                ? `${params.model.providerID}/${params.model.modelID}`
                : sessionModels.get(directory);
            try {
                const result = await conn.call('thread/start', {
                    cwd: params?.directory ?? directory,
                    ...(model ? { model } : {}),
                    approvalPolicy: 'on-request',
                });
                const thread = result.thread;
                if (model)
                    sessionModels.set(thread.id, model);
                sessionStatus.set(thread.id, { type: 'idle' });
                return { data: threadToSession(thread) };
            }
            catch (e) {
                return { error: e };
            }
        },
        async get({ sessionID }) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            try {
                const result = await conn.call('thread/resume', { threadId: sessionID });
                return { data: threadToSession(result.thread) };
            }
            catch (e) {
                return { error: e };
            }
        },
        async list() {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            try {
                const result = await conn.call('thread/list', {});
                const threads = (result.data ?? result.threads ?? []);
                return { data: threads.map(threadToSession) };
            }
            catch (e) {
                return { error: e };
            }
        },
        async messages({ sessionID }) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            try {
                const result = await conn.call('thread/resume', { threadId: sessionID });
                return { data: threadToMessages(result.thread) };
            }
            catch (e) {
                return { error: e };
            }
        },
        async status() {
            await getConnection();
            return { data: Object.fromEntries(sessionStatus) };
        },
        async promptAsync(params) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            const sessionID = params.sessionID;
            const texts = [];
            for (const part of params.parts ?? []) {
                if (part.type === 'text' && part.text)
                    texts.push(part.text);
            }
            // Interim: omo app-server has no per-turn system prompt; prepend the
            // dorimaki system message to the first turn as a reminder block.
            const system = params.system ?? sessionSystems.get(sessionID);
            if (params.system)
                sessionSystems.set(sessionID, params.system);
            let inputText = texts.join('\n\n');
            if (system && !sessionSystems.has(`${sessionID}:injected`)) {
                sessionSystems.set(`${sessionID}:injected`, '1');
                inputText = `<system-reminder>\n${system}\n</system-reminder>\n\n${inputText}`;
            }
            if (params.model) {
                sessionModels.set(sessionID, `${params.model.providerID}/${params.model.modelID}`);
            }
            try {
                const result = await conn.call('turn/start', {
                    threadId: sessionID,
                    input: [{ type: 'text', text: inputText }],
                });
                if (result.turn?.id)
                    activeTurns.set(sessionID, result.turn.id);
                sessionStatus.set(sessionID, { type: 'busy' });
                return { data: {} };
            }
            catch (e) {
                return { error: e };
            }
        },
        async abort({ sessionID }) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            const turnId = activeTurns.get(sessionID);
            try {
                await conn.call('turn/interrupt', { threadId: sessionID, ...(turnId ? { turnId } : {}) });
                return { data: true };
            }
            catch (e) {
                return { error: e };
            }
        },
        async update({ sessionID, ...rest }) {
            // omo has no thread rename/model patch RPC verified yet; keep local state.
            if (rest.model)
                sessionModels.set(sessionID, `${rest.model.providerID}/${rest.model.modelID}`);
            return { data: { id: sessionID } };
        },
        async delete({ sessionID }) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            try {
                await conn.call('thread/archive', { threadId: sessionID });
                sessionStatus.delete(sessionID);
                return { data: true };
            }
            catch (e) {
                return { error: e };
            }
        },
        async summarize() {
            return { error: new Error('summarize not yet implemented for omo engine') };
        },
        async revert() {
            return { error: new Error('revert not supported by omo engine') };
        },
        async unrevert() {
            return { error: new Error('unrevert not supported by omo engine') };
        },
    };
    const permission = {
        async reply({ requestID, reply }) {
            const ok = replyToServerRequest(requestID, { decision: reply === 'reject' ? 'deny' : 'allow' });
            if (!ok)
                return { error: new Error(`unknown permission request ${requestID}`) };
            emitToAll({ type: 'permission.replied', properties: { requestID, reply } });
            return { data: true };
        },
    };
    const question = {
        async reply({ requestID, answers }) {
            const ok = replyToServerRequest(requestID, { answers });
            if (!ok)
                return { error: new Error(`unknown question request ${requestID}`) };
            emitToAll({ type: 'question.replied', properties: { requestID, answers } });
            return { data: true };
        },
        async reject({ requestID }) {
            const ok = replyToServerRequest(requestID, { rejected: true });
            if (!ok)
                return { error: new Error(`unknown question request ${requestID}`) };
            emitToAll({ type: 'question.rejected', properties: { requestID } });
            return { data: true };
        },
        async list() {
            return { data: [] };
        },
    };
    const provider = {
        async list() {
            // TODO: query omo models-store; return empty-but-valid shape for now
            return { data: { all: [], connected: [], default: {} } };
        },
    };
    const config = {
        async providers() {
            return { data: { providers: [], default: {} } };
        },
    };
    const auth = {
        async set() {
            return { data: true };
        },
    };
    const mcp = {
        async status() {
            return { data: {} };
        },
        async connect() {
            return { data: true };
        },
        async disconnect() {
            return { data: true };
        },
    };
    const global = {
        async event({ signal } = {}) {
            const conn = await getConnection();
            if (conn instanceof Error)
                throw conn;
            const stream = (async function* () {
                const queue = [];
                let notify = null;
                const cb = (ev) => {
                    queue.push(ev);
                    notify?.();
                };
                eventCallbacks.add(cb);
                const onAbort = () => {
                    eventCallbacks.delete(cb);
                    notify?.();
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                try {
                    while (!signal?.aborted) {
                        while (queue.length > 0)
                            yield queue.shift();
                        await new Promise((resolve) => {
                            notify = resolve;
                            setTimeout(resolve, 30_000);
                        });
                        notify = null;
                    }
                }
                finally {
                    eventCallbacks.delete(cb);
                }
            })();
            return { stream };
        },
    };
    return { session, permission, question, provider, config, auth, mcp, global };
}
