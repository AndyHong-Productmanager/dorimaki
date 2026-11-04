// Translates omo RPC event records (senpi agent events) into the opencode SDK
// Event shapes that dorimaki's session runtime consumes:
//   session.status / idle / error / updated
//   message.updated / message.part.updated / message.part.delta
//
// One translator per session keeps the small amount of state needed to turn
// omo's flat stream (message_start, message_update deltas, tool_execution_*)
// into opencode's message + part model.
import { contentPartId, stepPartId } from './ids.js';
import { buildAssistantInfo, buildToolPart, buildUserInfo, completedToolState, toolTitle, userText, } from './messages.js';
export class OmoSessionTranslator {
    sessionID;
    cwd;
    userMessageId;
    assistant;
    lastAssistant;
    toolMessages = new Map();
    toolStarts = new Map();
    constructor(sessionID, cwd) {
        this.sessionID = sessionID;
        this.cwd = cwd;
    }
    messageIdForTool(toolCallId) {
        return this.toolMessages.get(toolCallId);
    }
    translate(record) {
        switch (record.type) {
            case 'agent_start':
                return [this.status({ type: 'busy' })];
            case 'message_start':
                return this.onMessageStart(record.message);
            case 'message_update':
                return this.onMessageUpdate(record);
            case 'message_end':
                return this.onMessageEnd(record.message);
            case 'tool_execution_start':
                return this.onToolStart(record);
            case 'tool_execution_end':
                return this.onToolEnd(record);
            case 'agent_end':
                return this.onAgentEnd(record);
            case 'agent_settled':
                return [this.status({ type: 'idle' }), { type: 'session.idle', properties: { sessionID: this.sessionID } }];
            case 'auto_retry_start':
                return [this.status({
                        type: 'retry',
                        attempt: record.attempt ?? 1,
                        message: String(record.errorMessage ?? 'retrying'),
                        next: Date.now() + (record.delayMs ?? 0),
                    })];
            default:
                return [];
        }
    }
    status(status) {
        return { type: 'session.status', properties: { sessionID: this.sessionID, status } };
    }
    onMessageStart(message) {
        if (!message)
            return [];
        if (message.role === 'user') {
            const info = buildUserInfo({ sessionID: this.sessionID, message });
            this.userMessageId = info.id;
            return [
                { type: 'message.updated', properties: { info } },
                {
                    type: 'message.part.updated',
                    properties: {
                        part: { id: contentPartId(info.id, 0), sessionID: this.sessionID, messageID: info.id, type: 'text', text: userText(message) },
                    },
                },
            ];
        }
        if (message.role === 'assistant') {
            return this.startAssistant(message);
        }
        return [];
    }
    startAssistant(message) {
        const info = buildAssistantInfo({
            sessionID: this.sessionID,
            message,
            parentID: this.userMessageId,
            cwd: this.cwd,
        });
        this.assistant = { message, info, parts: new Map() };
        return [
            { type: 'message.updated', properties: { info } },
            {
                type: 'message.part.updated',
                properties: {
                    part: { id: stepPartId(info.id, 'start'), sessionID: this.sessionID, messageID: info.id, type: 'step-start' },
                },
            },
        ];
    }
    onMessageUpdate(record) {
        const event = record.assistantMessageEvent;
        if (!event)
            return [];
        const events = [];
        if (!this.assistant) {
            const seed = record.message ?? event.partial;
            if (!seed)
                return [];
            events.push(...this.startAssistant(seed));
        }
        const assistant = this.assistant;
        const messageID = assistant.info.id;
        const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0;
        switch (event.type) {
            case 'text_start':
            case 'thinking_start': {
                const part = {
                    id: contentPartId(messageID, index),
                    type: event.type === 'text_start' ? 'text' : 'reasoning',
                    text: '',
                    start: Date.now(),
                    ended: false,
                };
                assistant.parts.set(index, part);
                events.push(this.partUpdated(messageID, part));
                break;
            }
            case 'text_delta':
            case 'thinking_delta': {
                const part = this.ensureLivePart(assistant, index, event.type === 'text_delta' ? 'text' : 'reasoning');
                const delta = String(event.delta ?? '');
                part.text += delta;
                events.push({
                    type: 'message.part.delta',
                    properties: { sessionID: this.sessionID, messageID, partID: part.id, field: 'text', delta },
                });
                break;
            }
            case 'text_end':
            case 'thinking_end': {
                const part = this.ensureLivePart(assistant, index, event.type === 'text_end' ? 'text' : 'reasoning');
                if (typeof event.content === 'string')
                    part.text = event.content;
                part.ended = true;
                events.push(this.partUpdated(messageID, part));
                break;
            }
            case 'toolcall_start': {
                if (typeof event.id !== 'string')
                    break;
                this.toolMessages.set(event.id, messageID);
                events.push(this.toolPart(event.id, record.resolvedToolName ?? event.toolName, {
                    status: 'pending',
                    input: {},
                    raw: '',
                }));
                break;
            }
            case 'toolcall_end': {
                const toolCall = event.toolCall;
                if (!toolCall || typeof toolCall.id !== 'string')
                    break;
                this.toolMessages.set(toolCall.id, messageID);
                events.push(this.toolPart(toolCall.id, record.resolvedToolName ?? toolCall.name, {
                    status: 'pending',
                    input: toolCall.arguments ?? {},
                    raw: '',
                }));
                break;
            }
            default:
                break;
        }
        return events;
    }
    ensureLivePart(assistant, index, type) {
        const existing = assistant.parts.get(index);
        if (existing)
            return existing;
        const part = {
            id: contentPartId(assistant.info.id, index),
            type,
            text: '',
            start: Date.now(),
            ended: false,
        };
        assistant.parts.set(index, part);
        return part;
    }
    partUpdated(messageID, part) {
        return {
            type: 'message.part.updated',
            properties: {
                part: {
                    id: part.id,
                    sessionID: this.sessionID,
                    messageID,
                    type: part.type,
                    text: part.text,
                    time: part.ended ? { start: part.start, end: Date.now() } : { start: part.start },
                },
            },
        };
    }
    toolPart(toolCallId, toolName, state) {
        const messageID = this.toolMessages.get(toolCallId) ?? this.assistant?.info.id ?? this.lastAssistant?.id ?? '';
        return {
            type: 'message.part.updated',
            properties: {
                part: buildToolPart({ sessionID: this.sessionID, messageID, toolCallId, toolName, state }),
            },
        };
    }
    onMessageEnd(message) {
        if (!message || message.role !== 'assistant')
            return [];
        const events = [];
        if (!this.assistant)
            events.push(...this.startAssistant(message));
        const assistant = this.assistant;
        const messageID = assistant.info.id;
        const blocks = Array.isArray(message.content) ? message.content : [];
        blocks.forEach((block, index) => {
            if (block?.type === 'toolCall' && typeof block.id === 'string') {
                this.toolMessages.set(block.id, messageID);
                return;
            }
            const isText = block?.type === 'text';
            const isThinking = block?.type === 'thinking';
            if (!isText && !isThinking)
                return;
            const part = this.ensureLivePart(assistant, index, isText ? 'text' : 'reasoning');
            if (part.ended)
                return;
            part.text = isText ? (block.text ?? part.text) : (block.thinking ?? part.text);
            part.ended = true;
            events.push(this.partUpdated(messageID, part));
        });
        const completedAt = Date.now();
        const info = buildAssistantInfo({
            sessionID: this.sessionID,
            message: { ...message, timestamp: assistant.info.time.created },
            parentID: this.userMessageId,
            cwd: this.cwd,
            completedAt,
        });
        events.push({
            type: 'message.part.updated',
            properties: {
                part: {
                    id: stepPartId(messageID, 'finish'),
                    sessionID: this.sessionID,
                    messageID,
                    type: 'step-finish',
                    reason: info.finish ?? 'stop',
                    cost: info.cost,
                    tokens: info.tokens,
                },
            },
        });
        events.push({ type: 'message.updated', properties: { info } });
        this.lastAssistant = info;
        this.assistant = undefined;
        return events;
    }
    onToolStart(record) {
        if (typeof record.toolCallId !== 'string')
            return [];
        const start = Date.now();
        this.toolStarts.set(record.toolCallId, start);
        const args = record.args ?? {};
        return [this.toolPart(record.toolCallId, record.toolName, {
                status: 'running',
                input: args,
                title: toolTitle(args),
                metadata: {},
                time: { start },
            })];
    }
    onToolEnd(record) {
        if (typeof record.toolCallId !== 'string')
            return [];
        const end = Date.now();
        const start = this.toolStarts.get(record.toolCallId) ?? end;
        this.toolStarts.delete(record.toolCallId);
        const state = completedToolState({
            args: record.args ?? {},
            result: { ...(record.result ?? {}), isError: record.isError === true },
            start,
            end,
        });
        return [this.toolPart(record.toolCallId, record.toolName, state)];
    }
    onAgentEnd(record) {
        if (record.willRetry)
            return [];
        const messages = Array.isArray(record.messages) ? record.messages : [];
        const lastAssistant = [...messages].reverse().find((m) => m?.role === 'assistant');
        if (!lastAssistant)
            return [];
        if (lastAssistant.stopReason === 'aborted') {
            return [{
                    type: 'session.error',
                    properties: { sessionID: this.sessionID, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } },
                }];
        }
        if (lastAssistant.stopReason !== 'error')
            return [];
        const failure = record.failure;
        const message = failure
            ? [failure.reason, failure.action].filter(Boolean).join(' - ')
            : String(lastAssistant.errorMessage || 'The model provider returned an error');
        return [{
                type: 'session.error',
                properties: {
                    sessionID: this.sessionID,
                    error: {
                        name: 'APIError',
                        data: {
                            message: failure?.provider ? `${failure.provider}/${failure.model}: ${message}` : message,
                            statusCode: failure?.httpStatus,
                            providerID: failure?.provider ?? lastAssistant.provider,
                            isRetryable: false,
                        },
                    },
                },
            }];
    }
}
