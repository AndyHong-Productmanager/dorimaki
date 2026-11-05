// OpencodeClient-shaped adapter backed by an omo multi-session RPC host
// (`omo --mode rpc --multi-session`). Lets dorimaki's Discord runtime keep its
// existing SDK call surface while the engine underneath is omo.
//
// Mapping highlights:
//   session.create      -> open_session (new transcript under ~/.dorimaki/omo-sessions)
//   session.promptAsync -> prompt (set_model first when the model changed)
//   session.abort       -> abort
//   session.messages    -> get_messages (AgentMessages -> info + parts)
//   session.summarize   -> compact
//   permission.reply    -> extension_ui_response for a "Permission required" select
//   question.reply      -> extension_ui_response for question/select/confirm dialogs
//   global.event        -> async generator over translated event records
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger, LogPrefix } from '../logger.js';
import { clearOmoCatalog, getDefaultModelId, getModelCatalog, getSupportedThinkingLevels, listCommands, listProviders, } from './catalog.js';
import { OmoSessionTranslator } from './events.js';
import { newSessionId } from './ids.js';
import { agentMessagesToOpencode } from './messages.js';
import { OmoRpcError } from './rpc.js';
import { getOmoConnection, onOmoConnectionReady, subscribeOmoServerLifecycle } from './server.js';
import { callSession, createSession, deleteSessionFiles, forgetAllSessions, forgetControlSessions, forgetHandle, getLiveSession, listSessionMetas, modelRefFromState, openSession, readSessionMeta, sessionIdForHandle, setLiveModel, updateSessionTitle, } from './sessions.js';
import { permissionResponse, questionResponse, translateUiRequest, } from './ui-requests.js';
const logger = createLogger(LogPrefix.OPENCODE);
const eventCallbacks = new Set();
const translators = new Map();
const sessionStatus = new Map();
const pendingUi = new Map();
const injectedSystemPrompts = new Map();
function emitToAll(event) {
    if (event.type === 'session.status' && event.properties.sessionID) {
        sessionStatus.set(event.properties.sessionID, event.properties.status);
    }
    if (event.type === 'session.idle' && event.properties.sessionID) {
        sessionStatus.set(event.properties.sessionID, { type: 'idle' });
    }
    for (const cb of eventCallbacks)
        cb({ payload: event });
}
function getTranslator(sessionID) {
    let translator = translators.get(sessionID);
    if (!translator) {
        const cwd = getLiveSession(sessionID)?.cwd ?? readSessionMeta(sessionID)?.cwd ?? '';
        translator = new OmoSessionTranslator(sessionID, cwd);
        translators.set(sessionID, translator);
    }
    return translator;
}
function metaToSession(meta) {
    return {
        id: meta.id,
        slug: meta.id,
        projectID: 'omo',
        directory: meta.cwd,
        title: meta.title,
        version: 'omo',
        time: { created: meta.created, updated: meta.updated },
    };
}
function handleRecord(record) {
    if (record.type === 'session_closed' || record.type === 'session_parked') {
        if (record.sessionId)
            forgetHandle(record.sessionId);
        return;
    }
    const sessionID = sessionIdForHandle(record.sessionId);
    if (!sessionID)
        return;
    switch (record.type) {
        case 'model_changed':
            setLiveModel(sessionID, modelRefFromState(record.model));
            return;
        case 'session_info_changed': {
            const meta = updateSessionTitle(sessionID, String(record.name ?? ''));
            if (meta)
                emitToAll({ type: 'session.updated', properties: { info: metaToSession(meta) } });
            return;
        }
        case 'extension_ui_request':
            handleUiRequest(sessionID, record);
            return;
        case 'question_resolved': {
            const requestID = `que_${record.id}`;
            if (pendingUi.delete(requestID)) {
                emitToAll({ type: 'question.replied', properties: { sessionID, requestID, answers: [] } });
            }
            return;
        }
        default:
            for (const event of getTranslator(sessionID).translate(record))
                emitToAll(event);
    }
}
function handleUiRequest(sessionID, record) {
    const translation = translateUiRequest({
        record,
        sessionID,
        toolMessageId: (toolCallId) => getTranslator(sessionID).messageIdForTool(toolCallId),
    });
    switch (translation.kind) {
        case 'event':
            pendingUi.set(translation.pending.requestID, translation.pending);
            emitToAll(translation.event);
            return;
        case 'toast':
            emitToAll(translation.event);
            return;
        case 'cancel':
            logger.log(`[OMO CLIENT] cancelling ${record.method} dialog: ${translation.reason}`);
            void callSession(sessionID, 'extension_ui_response', { uiRequestId: record.id, cancelled: true })
                .catch((e) => logger.warn('[OMO CLIENT] failed to cancel dialog:', e));
            return;
        case 'ignore':
            return;
    }
}
async function answerUiRequest(pending, response) {
    await callSession(pending.sessionID, 'extension_ui_response', {
        uiRequestId: pending.uiRequestId,
        ...response,
    });
}
onOmoConnectionReady(async (conn) => {
    conn.onRecord(handleRecord);
    await conn.call('set_client_info', { capabilities: ['question'] });
});
function getConnection() {
    return getOmoConnection();
}
subscribeOmoServerLifecycle((event) => {
    if (event.type !== 'stopped')
        return;
    forgetControlSessions();
    clearOmoCatalog();
    pendingUi.clear();
    for (const sessionID of forgetAllSessions()) {
        if (sessionStatus.get(sessionID)?.type === 'idle')
            continue;
        emitToAll({
            type: 'session.error',
            properties: { sessionID, error: { name: 'UnknownError', data: { message: 'omo engine stopped' } } },
        });
        emitToAll({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } });
        emitToAll({ type: 'session.idle', properties: { sessionID } });
    }
    translators.clear();
});
// ── Prompt helpers ─────────────────────────────────────────────
function parseModel(model) {
    if (!model)
        return undefined;
    if (typeof model === 'string') {
        const slash = model.indexOf('/');
        if (slash <= 0)
            return undefined;
        return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
    }
    const m = model;
    if (typeof m.providerID === 'string' && typeof m.modelID === 'string') {
        return { provider: m.providerID, id: m.modelID };
    }
    return undefined;
}
function imageFromFilePart(part) {
    const mime = part.mime ?? '';
    const url = part.url ?? '';
    if (!mime.startsWith('image/') || !url)
        return undefined;
    const dataMatch = url.match(/^data:([^;,]+)?;base64,(.*)$/s);
    if (dataMatch)
        return { type: 'image', data: dataMatch[2], mimeType: dataMatch[1] || mime };
    const filePath = url.startsWith('file://') ? fileURLToPath(url) : url.startsWith('/') ? url : undefined;
    if (!filePath)
        return undefined;
    try {
        return { type: 'image', data: fs.readFileSync(filePath).toString('base64'), mimeType: mime };
    }
    catch {
        return undefined;
    }
}
function buildPromptInput(sessionID, params) {
    const texts = [];
    const images = [];
    const context = [];
    // omo has no per-turn system prompt. dorimaki's system message is sent as a
    // hidden custom message whenever it changes for this session.
    const system = typeof params.system === 'string' && params.system.trim()
        ? params.system
        : undefined;
    if (system && injectedSystemPrompts.get(sessionID) !== system) {
        injectedSystemPrompts.set(sessionID, system);
        context.push(`<system-reminder>\n${system}\n</system-reminder>`);
    }
    for (const part of params.parts ?? []) {
        if (part?.type === 'text' && part.text) {
            if (part.synthetic === true)
                context.push(part.text);
            else
                texts.push(part.text);
        }
        if (part?.type === 'file') {
            const image = imageFromFilePart(part);
            if (image)
                images.push(image);
            else if (part.url && !String(part.url).startsWith('data:')) {
                texts.push(`[Attached file: ${part.filename ?? 'file'} at ${part.url}]`);
            }
        }
    }
    return { message: texts.join('\n\n'), images, context };
}
async function sendContext(sessionID, context) {
    if (context.length === 0)
        return;
    await callSession(sessionID, 'send_custom_message', {
        customType: 'dorimaki-context',
        content: context.join('\n\n'),
        display: false,
        triggerTurn: false,
        deliverAs: 'nextTurn',
    });
}
async function ensureModel(sessionID, model) {
    if (!model)
        return;
    const session = await openSession({ id: sessionID });
    if (session instanceof Error)
        throw session;
    if (session.model?.provider === model.provider && session.model.id === model.id)
        return;
    const data = await callSession(sessionID, 'set_model', { provider: model.provider, modelId: model.id });
    setLiveModel(sessionID, modelRefFromState(data) ?? model);
}
// omo refuses a thinkingLevel on a prompt queued behind a running turn, so
// queued prompts drop it and run at the session's current level.
function queuedPrompt(payload) {
    const { thinkingLevel: _thinkingLevel, ...rest } = payload;
    return { ...rest, streamingBehavior: 'followUp' };
}
async function sendPrompt(sessionID, payload) {
    const busy = sessionStatus.get(sessionID)?.type === 'busy';
    try {
        return await callSession(sessionID, 'prompt', busy ? queuedPrompt(payload) : payload);
    }
    catch (e) {
        if (!busy && e instanceof OmoRpcError && e.code === 'streaming') {
            return callSession(sessionID, 'prompt', queuedPrompt(payload));
        }
        throw e;
    }
}
async function promptSession(params) {
    const conn = await getConnection();
    if (conn instanceof Error)
        return { error: conn };
    const sessionID = params.sessionID;
    try {
        const { message, images, context } = buildPromptInput(sessionID, params);
        if (params.noReply) {
            await callSession(sessionID, 'append_user_message', { content: message });
            return { data: {} };
        }
        const model = parseModel(params.model);
        await ensureModel(sessionID, model);
        await sendContext(sessionID, context);
        if (model)
            await getModelCatalog().catch(() => undefined);
        const variant = typeof params.variant === 'string' ? params.variant : undefined;
        const thinkingLevel = model && variant && getSupportedThinkingLevels(model).includes(variant)
            ? variant
            : undefined;
        const result = await sendPrompt(sessionID, {
            message,
            ...(images.length > 0 ? { images } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
        });
        // Extension commands such as /efforts run without starting a turn.
        // dorimaki still waits for an idle event to stop typing, so send one.
        if (result?.disposition === 'handled' && sessionStatus.get(sessionID)?.type !== 'busy') {
            emitToAll({ type: 'session.status', properties: { sessionID, status: { type: 'idle' } } });
            emitToAll({ type: 'session.idle', properties: { sessionID } });
            return { data: {} };
        }
        sessionStatus.set(sessionID, { type: 'busy' });
        return { data: {} };
    }
    catch (e) {
        return { error: e };
    }
}
/** Engine switch: dorimaki defaults to omo; set DORIMAKI_ENGINE=opencode for the legacy path. */
export function isOmoEngine() {
    return process.env.DORIMAKI_ENGINE !== 'opencode';
}
function notSupported(operation) {
    return async () => ({ error: new Error(`${operation} is not supported by the omo engine`) });
}
export function createOmoClient({ directory }) {
    const session = {
        async create(params) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            const cwd = params?.directory || directory;
            const id = newSessionId();
            const created = await createSession({ id, cwd, model: parseModel(params?.model) });
            if (created instanceof Error) {
                deleteSessionFiles(id);
                return { error: created };
            }
            sessionStatus.set(id, { type: 'idle' });
            const meta = readSessionMeta(id);
            return meta ? { data: metaToSession(meta) } : { error: new Error(`Session not found: ${id}`) };
        },
        async get({ sessionID }) {
            const meta = readSessionMeta(sessionID);
            if (!meta)
                return { error: new Error(`Session not found: ${sessionID}`) };
            return { data: metaToSession(meta) };
        },
        async list() {
            return { data: listSessionMetas().map(metaToSession) };
        },
        async messages({ sessionID, limit }) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            const meta = readSessionMeta(sessionID);
            if (!meta)
                return { error: new Error(`Session not found: ${sessionID}`) };
            try {
                const data = await callSession(sessionID, 'get_messages');
                const messages = agentMessagesToOpencode({
                    sessionID,
                    messages: Array.isArray(data?.messages) ? data.messages : [],
                    cwd: meta.cwd,
                });
                return { data: typeof limit === 'number' && limit > 0 ? messages.slice(-limit) : messages };
            }
            catch (e) {
                return { error: e };
            }
        },
        async status() {
            const busy = [...sessionStatus.entries()].filter(([, status]) => status.type !== 'idle');
            return { data: Object.fromEntries(busy) };
        },
        promptAsync: promptSession,
        async command(params) {
            const args = typeof params.arguments === 'string' ? params.arguments : '';
            const commandText = (name) => `/${name}${args ? ` ${args}` : ''}`;
            const prompt = (name) => promptSession({
                ...params,
                parts: [{ type: 'text', text: commandText(name) }],
            });
            const first = await prompt(params.command);
            if (first.error instanceof OmoRpcError && first.error.code === 'unknown_command') {
                return prompt(`skill:${params.command}`);
            }
            return first;
        },
        async abort({ sessionID }) {
            if (!getLiveSession(sessionID))
                return { data: true };
            try {
                await callSession(sessionID, 'abort');
                return { data: true };
            }
            catch (e) {
                return { error: e };
            }
        },
        async update({ sessionID, title }) {
            const meta = readSessionMeta(sessionID);
            if (!meta)
                return { error: new Error(`Session not found: ${sessionID}`) };
            if (typeof title === 'string' && title.trim()) {
                try {
                    await callSession(sessionID, 'set_session_name', { name: title });
                }
                catch (e) {
                    return { error: e };
                }
                return { data: metaToSession(updateSessionTitle(sessionID, title) ?? meta) };
            }
            return { data: metaToSession(meta) };
        },
        async delete({ sessionID }) {
            const live = getLiveSession(sessionID);
            if (live) {
                await live.conn.call('close_session', { sessionId: live.handle }).catch(() => undefined);
                forgetHandle(live.handle);
            }
            deleteSessionFiles(sessionID);
            translators.delete(sessionID);
            sessionStatus.delete(sessionID);
            injectedSystemPrompts.delete(sessionID);
            return { data: true };
        },
        async summarize({ sessionID }) {
            try {
                await callSession(sessionID, 'compact', {}, { timeoutMs: 30 * 60_000 });
                return { data: true };
            }
            catch (e) {
                return { error: e };
            }
        },
        revert: notSupported('revert'),
        unrevert: notSupported('unrevert'),
        fork: notSupported('fork'),
        share: notSupported('share'),
        trim: notSupported('trim'),
        sendRealtimeInput: notSupported('realtime input'),
    };
    const permission = {
        async reply({ requestID, reply }) {
            const pending = pendingUi.get(requestID);
            if (!pending || pending.kind !== 'permission') {
                return { error: new Error(`unknown permission request ${requestID}`) };
            }
            pendingUi.delete(requestID);
            try {
                await answerUiRequest(pending, permissionResponse(pending, reply));
            }
            catch (e) {
                return { error: e };
            }
            emitToAll({ type: 'permission.replied', properties: { sessionID: pending.sessionID, requestID, reply } });
            return { data: true };
        },
        async list() {
            return { data: [] };
        },
    };
    const question = {
        async reply({ requestID, answers }) {
            const pending = pendingUi.get(requestID);
            if (!pending || pending.kind === 'permission') {
                return { error: new Error(`unknown question request ${requestID}`) };
            }
            pendingUi.delete(requestID);
            try {
                await answerUiRequest(pending, questionResponse(pending, Array.isArray(answers) ? answers : []));
            }
            catch (e) {
                return { error: e };
            }
            emitToAll({ type: 'question.replied', properties: { sessionID: pending.sessionID, requestID, answers } });
            return { data: true };
        },
        async reject({ requestID }) {
            const pending = pendingUi.get(requestID);
            if (!pending)
                return { error: new Error(`unknown question request ${requestID}`) };
            pendingUi.delete(requestID);
            try {
                await answerUiRequest(pending, { cancelled: true });
            }
            catch (e) {
                return { error: e };
            }
            emitToAll({ type: 'question.rejected', properties: { sessionID: pending.sessionID, requestID } });
            return { data: true };
        },
        async list() {
            const questions = [...pendingUi.values()]
                .filter((pending) => pending.kind !== 'permission')
                .map((pending) => ({
                id: pending.requestID,
                sessionID: pending.sessionID,
                questions: pending.questions,
                ...(pending.tool ? { tool: pending.tool } : {}),
            }));
            return { data: questions };
        },
    };
    const provider = {
        async list() {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            try {
                return { data: await listProviders() };
            }
            catch (e) {
                return { error: e };
            }
        },
        async auth() {
            return { data: {} };
        },
    };
    const config = {
        async get() {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            const model = await getDefaultModelId().catch(() => undefined);
            return { data: model ? { model } : {} };
        },
        async providers() {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            try {
                const { all, default: defaults } = await listProviders();
                return { data: { providers: all, default: defaults } };
            }
            catch (e) {
                return { error: e };
            }
        },
    };
    const command = {
        async list(params) {
            const conn = await getConnection();
            if (conn instanceof Error)
                return { error: conn };
            try {
                return { data: await listCommands(params?.directory || directory) };
            }
            catch (e) {
                return { error: e };
            }
        },
    };
    const app = {
        async agents() {
            return { data: [] };
        },
    };
    const project = {
        async list() {
            return { data: [] };
        },
    };
    const instance = {
        async dispose() {
            return { data: true };
        },
    };
    const find = {
        async files() {
            return { data: [] };
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
            // Subscribe before returning so events emitted before the first
            // iteration are queued instead of dropped.
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
            const stream = (async function* () {
                try {
                    // The event bus outlives host restarts, so the stream ends only on abort.
                    while (!signal?.aborted) {
                        while (queue.length > 0)
                            yield queue.shift();
                        let timer;
                        await new Promise((resolve) => {
                            notify = resolve;
                            timer = setTimeout(resolve, 30_000);
                        });
                        clearTimeout(timer);
                        notify = null;
                    }
                }
                finally {
                    eventCallbacks.delete(cb);
                    signal?.removeEventListener('abort', onAbort);
                }
            })();
            return { stream };
        },
    };
    return {
        session,
        permission,
        question,
        provider,
        config,
        command,
        app,
        project,
        instance,
        find,
        auth,
        mcp,
        global,
    };
}
