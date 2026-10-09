// Translates omo app-server notifications (Codex app-server protocol) into
// the opencode SDK Event shapes that dorimaki's session runtime consumes.
//
// Consumed event types (from session-handler):
//   session.created / updated / deleted / status / idle / error / diff
//   message.updated / message.part.updated / message.part.delta / removed
//   permission.asked / replied, question.asked / replied / rejected
/** Split omo item id "msg_xxx:3" into message id + part index. */
function splitItemId(itemId) {
    const idx = itemId.lastIndexOf(':');
    if (idx === -1)
        return { messageId: itemId, partIndex: 0 };
    const suffix = Number(itemId.slice(idx + 1));
    if (Number.isNaN(suffix))
        return { messageId: itemId, partIndex: 0 };
    return { messageId: itemId.slice(0, idx), partIndex: suffix };
}
function partIdFor(itemId) {
    return `part_${itemId.replace(/[^a-zA-Z0-9]/g, '_')}`;
}
function itemToPart(threadId, item) {
    const { messageId } = splitItemId(item.id ?? '');
    const partId = partIdFor(item.id ?? '');
    const base = { id: partId, sessionID: threadId, messageID: messageId };
    switch (item.type) {
        case 'agentMessage':
            return {
                ...base,
                type: 'text',
                text: item.text ?? '',
                time: { start: item.startedAtMs ?? Date.now(), end: item.completedAtMs },
            };
        case 'reasoning':
            return {
                ...base,
                type: 'reasoning',
                text: Array.isArray(item.content) ? item.content.join('\n') : (item.text ?? ''),
                time: { start: item.startedAtMs ?? Date.now(), end: item.completedAtMs },
            };
        case 'userMessage': {
            const text = Array.isArray(item.content)
                ? item.content.map((c) => c.text ?? '').join('\n')
                : '';
            return { ...base, type: 'text', text };
        }
        case 'dynamicToolCall':
        case 'toolCall':
            return {
                ...base,
                type: 'tool',
                tool: item.tool ?? item.name ?? 'unknown',
                callID: item.id,
                state: {
                    status: item.completedAtMs || item.status === 'completed' ? 'completed' : 'running',
                    input: item.arguments ?? item.input ?? {},
                    output: item.output ?? item.result ?? '',
                    title: item.tool ?? item.name,
                    metadata: {},
                    time: { start: item.startedAtMs ?? Date.now(), end: item.completedAtMs },
                },
            };
        default:
            return null;
    }
}
export function translateOmoNotification(n) {
    const p = n.params;
    const threadId = p.threadId ?? p.thread?.id;
    const events = [];
    switch (n.method) {
        case 'thread/started': {
            const t = p.thread ?? {};
            events.push({
                type: 'session.created',
                properties: {
                    info: {
                        id: t.id,
                        directory: t.cwd,
                        title: t.name ?? t.preview ?? '',
                        time: { created: (t.createdAt ?? 0) * 1000, updated: (t.updatedAt ?? 0) * 1000 },
                    },
                },
            });
            break;
        }
        case 'thread/status/changed': {
            if (!threadId)
                break;
            const statusType = p.status?.type === 'active' ? 'busy' : 'idle';
            events.push({
                type: 'session.status',
                properties: { sessionID: threadId, status: { type: statusType } },
            });
            if (statusType === 'idle') {
                events.push({ type: 'session.idle', properties: { sessionID: threadId } });
            }
            break;
        }
        case 'turn/started': {
            if (!threadId)
                break;
            events.push({
                type: 'session.status',
                properties: { sessionID: threadId, status: { type: 'busy' } },
            });
            break;
        }
        case 'turn/completed': {
            if (!threadId)
                break;
            const turn = p.turn ?? {};
            if (turn.error) {
                events.push({
                    type: 'session.error',
                    properties: {
                        sessionID: threadId,
                        error: { name: 'TurnError', data: { message: String(turn.error?.message ?? turn.error) } },
                    },
                });
            }
            for (const item of turn.items ?? []) {
                if (item.type === 'userMessage')
                    continue;
                const part = itemToPart(threadId, item);
                if (part)
                    events.push({ type: 'message.part.updated', properties: { part } });
            }
            events.push({ type: 'session.idle', properties: { sessionID: threadId } });
            events.push({
                type: 'session.status',
                properties: { sessionID: threadId, status: { type: 'idle' } },
            });
            break;
        }
        case 'item/started':
        case 'item/completed': {
            if (!threadId || !p.item)
                break;
            const item = p.item;
            if (item.type === 'userMessage') {
                if (n.method === 'item/completed') {
                    const { messageId } = splitItemId(item.id ?? '');
                    events.push({
                        type: 'message.updated',
                        properties: {
                            info: {
                                id: messageId,
                                sessionID: threadId,
                                role: 'user',
                                time: { created: item.completedAtMs ?? Date.now() },
                            },
                        },
                    });
                }
                break;
            }
            const part = itemToPart(threadId, item);
            if (part)
                events.push({ type: 'message.part.updated', properties: { part } });
            break;
        }
        case 'item/agentMessage/textDelta':
        case 'item/reasoning/textDelta': {
            if (!threadId)
                break;
            const { messageId } = splitItemId(p.itemId ?? '');
            events.push({
                type: 'message.part.delta',
                properties: {
                    sessionID: threadId,
                    messageID: messageId,
                    partID: partIdFor(p.itemId ?? ''),
                    field: 'text',
                    delta: p.delta ?? '',
                },
            });
            break;
        }
        case 'thread/tokenUsage/updated':
        case 'extension_event':
            // not consumed by the runtime
            break;
        default:
            break;
    }
    return events;
}
