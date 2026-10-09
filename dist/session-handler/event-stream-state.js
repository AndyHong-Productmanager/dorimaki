// Pure event-stream derivation functions for session lifecycle state.
// These functions derive lifecycle decisions from an event buffer array.
// Zero imports from thread-session-runtime.ts, store.ts, or state.ts.
// Only types from @opencode-ai/sdk/v2 and the getOpencodeEventSessionId helper.
import { getOpencodeEventSessionId } from './opencode-session-event-log.js';
export function getEventBufferSessionId(event) {
    if (event.type === 'queue.question-handoff-started') {
        return event.properties.sessionID;
    }
    return getOpencodeEventSessionId(event);
}
function isCompactionContinuePart(part) {
    if (part.type !== 'text') {
        return false;
    }
    return part.synthetic === true && part.metadata?.compaction_continue === true;
}
function isInternalOpenCodeUserMessageId({ events, sessionId, messageId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    let sawPart = false;
    let hasUserTurnInput = false;
    let hasIgnoredNotice = false;
    for (let i = 0; i <= end; i++) {
        const event = events[i]?.event;
        if (event?.type !== 'message.part.updated') {
            continue;
        }
        const part = event.properties.part;
        if (part.sessionID !== sessionId || part.messageID !== messageId) {
            continue;
        }
        sawPart = true;
        if (part.type === 'compaction') {
            return true;
        }
        if (isCompactionContinuePart(part)) {
            return true;
        }
        if (part.type === 'text') {
            if (part.synthetic === true) {
                continue;
            }
            if (part.ignored === true) {
                hasIgnoredNotice = true;
                continue;
            }
            if (part.text?.trim()) {
                hasUserTurnInput = true;
            }
            continue;
        }
        hasUserTurnInput = true;
    }
    return sawPart && hasIgnoredNotice && !hasUserTurnInput;
}
function isUserFacingAssistantMessage(message) {
    return message.summary !== true;
}
export function getAssistantMessageKind({ events, sessionId, messageId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const event = events[i]?.event;
        if (event?.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
            continue;
        }
        return info.summary === true ? 'summary' : 'user-facing';
    }
    return 'unknown';
}
function getTaskChildSessionId({ part, }) {
    // Event-shape reference:
    // - cli/src/session-handler/event-stream-fixtures/real-session-task-three-parallel-sleeps.jsonl
    // - In real task events, state.metadata.sessionId appears on running/completed
    //   tool updates and is the canonical child-session identifier.
    // We intentionally do not parse state.output because it is user-facing text
    // and can change format across providers/versions.
    const metadataValue = part.state.metadata;
    const metadataSessionId = metadataValue && typeof metadataValue === 'object'
        ? metadataValue.sessionId
        : undefined;
    if (typeof metadataSessionId === 'string' && metadataSessionId.length > 0) {
        return metadataSessionId;
    }
    return undefined;
}
function getTaskCandidateFromEvent({ event, mainSessionId, }) {
    if (event.type !== 'message.part.updated') {
        return undefined;
    }
    const part = event.properties.part;
    if (part.sessionID !== mainSessionId) {
        return undefined;
    }
    if (part.type !== 'tool' || part.tool !== 'task' || part.state.status === 'pending') {
        return undefined;
    }
    const childSessionId = getTaskChildSessionId({ part });
    if (!childSessionId) {
        return undefined;
    }
    const subagentType = part.state.input?.subagent_type;
    const description = part.state.input?.description;
    return {
        assistantMessageId: part.messageID,
        childSessionId,
        subagentType: typeof subagentType === 'string' ? subagentType : undefined,
        description: typeof description === 'string' ? description : undefined,
    };
}
function getTaskPartStatus(event, sessionId) {
    if (event.type !== 'message.part.updated') {
        return undefined;
    }
    const part = event.properties.part;
    if (part.sessionID !== sessionId || part.type !== 'tool' || part.tool !== 'task') {
        return undefined;
    }
    const callID = part.callID || part.id;
    if (!callID) {
        return undefined;
    }
    return { callID, status: part.state.status };
}
// Scans backward for most recent session-scoped lifecycle event.
// Returns true if the latest lifecycle event for sessionId is session.status busy.
// If status/idle were evicted from the bounded buffer, a still-running task
// tool on that session also counts as busy. That stops `. queue` from draining
// (and the 3s interrupt plugin from aborting) while a subagent is in flight.
export function isSessionBusy({ events, sessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    const latestTaskStatusByCallId = new Map();
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const e = entry.event;
        const eid = getEventBufferSessionId(e);
        if (eid !== sessionId) {
            continue;
        }
        if (e.type === 'session.idle') {
            return false;
        }
        if (e.type === 'session.status') {
            return e.properties.status.type === 'busy';
        }
        const taskPart = getTaskPartStatus(e, sessionId);
        if (taskPart && !latestTaskStatusByCallId.has(taskPart.callID)) {
            latestTaskStatusByCallId.set(taskPart.callID, taskPart.status);
        }
    }
    return [...latestTaskStatusByCallId.values()].some((status) => {
        return status === 'running' || status === 'pending';
    });
}
export function didQuestionQueueHandoffSinceLatestQuestionAsked({ events, sessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const event = entry.event;
        const eventSessionId = getEventBufferSessionId(event);
        if (eventSessionId !== sessionId) {
            continue;
        }
        if (event.type === 'queue.question-handoff-started') {
            return true;
        }
        if (event.type === 'question.asked') {
            return false;
        }
    }
    return false;
}
// OpenCode emits question.asked when the tool starts, often before the
// preceding text part gets time.end. Discord must wait for that end event
// or the question UI posts first and the text dumps later.
export function isAssistantTextReadyForQuestion({ events, sessionId, messageId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const event = events[i]?.event;
        if (!event || event.type !== 'message.part.updated') {
            continue;
        }
        const part = event.properties.part;
        if (part.sessionID !== sessionId) {
            continue;
        }
        if (part.messageID !== messageId) {
            continue;
        }
        if (part.type !== 'text') {
            continue;
        }
        return Boolean(part.time?.end);
    }
    return true;
}
export function deriveLatestUnansweredQuestion({ events, sessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const event = entry.event;
        if (getEventBufferSessionId(event) !== sessionId) {
            continue;
        }
        if (event.type === 'question.replied' || event.type === 'question.rejected') {
            return undefined;
        }
        if (event.type === 'message.part.updated') {
            const part = event.properties.part;
            if (part.type === 'tool'
                && part.tool === 'question'
                && (part.state.status === 'error' || part.state.status === 'completed')) {
                return undefined;
            }
        }
        if (event.type === 'question.asked') {
            const messageId = event.properties.tool?.messageID;
            const latestUserMessage = getLatestUserMessage({
                events,
                sessionId,
                upToIndex: end,
            });
            if (messageId
                && latestUserMessage
                && !isAssistantMessageInLatestUserTurn({
                    events,
                    sessionId,
                    messageId,
                    upToIndex: end,
                })) {
                return undefined;
            }
            return {
                id: event.properties.id,
                questions: event.properties.questions,
                tool: event.properties.tool,
            };
        }
    }
    return undefined;
}
export function derivePendingPermissionRequests({ events, sessionId, }) {
    const permissions = new Set();
    for (const entry of events) {
        const event = entry.event;
        const eventSessionId = getEventBufferSessionId(event);
        if (eventSessionId !== sessionId) {
            continue;
        }
        if (event.type === 'permission.asked') {
            permissions.add(event.properties.id);
            continue;
        }
        if (event.type === 'permission.replied') {
            permissions.delete(event.properties.requestID);
        }
    }
    return [...permissions];
}
export function isAssistantMessageNaturalCompletion({ message, }) {
    if (!isUserFacingAssistantMessage(message)) {
        return false;
    }
    if (typeof message.time.completed !== 'number') {
        return false;
    }
    if (message.error) {
        return false;
    }
    // finish="tool-calls" means the model's last step was tool execution.
    // Mid-turn tool-call steps don't get footers — the footer comes from the
    // final text response (finish="stop") that follows. If the turn ends with
    // only tool-calls and no text follow-up, no footer is emitted. This is
    // acceptable since models almost always follow up with text after tools.
    return message.finish !== 'tool-calls';
}
export function hasAssistantMessageCompletedBefore({ events, sessionId, messageId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const event = entry.event;
        if (event.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
            continue;
        }
        if (typeof info.time.completed === 'number') {
            return true;
        }
    }
    return false;
}
export function getLatestUserMessage({ events, sessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    let latestUserMessage;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const event = entry.event;
        if (event.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'user') {
            continue;
        }
        if (isInternalOpenCodeUserMessageId({
            events,
            sessionId,
            messageId: info.id,
            upToIndex: end,
        })) {
            continue;
        }
        if (!latestUserMessage) {
            latestUserMessage = info;
            continue;
        }
        if (info.time.created > latestUserMessage.time.created) {
            latestUserMessage = info;
        }
    }
    return latestUserMessage;
}
export function getCurrentTurnStartTime({ events, sessionId, upToIndex, }) {
    const latestUserMessage = getLatestUserMessage({
        events,
        sessionId,
        upToIndex,
    });
    return latestUserMessage?.time.created;
}
// Token total helper — sum of input + output + reasoning + cache.read + cache.write
function getTokenTotal(tokens) {
    return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}
function emptyTurnTokenUsage() {
    return {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        model: undefined,
        providerID: undefined,
        assistantMessageCount: 0,
        userMessageId: undefined,
    };
}
function addAssistantTokens({ usage, message, }) {
    if (message.tokens) {
        usage.input += message.tokens.input;
        usage.output += message.tokens.output;
        usage.reasoning += message.tokens.reasoning;
        usage.cacheRead += message.tokens.cache.read;
        usage.cacheWrite += message.tokens.cache.write;
        usage.total += message.tokens.total ?? getTokenTotal(message.tokens);
    }
    usage.cost += message.cost;
    usage.model = message.modelID;
    usage.providerID = message.providerID;
}
function sumAssistantMessages({ messages, userMessageId, }) {
    if (messages.size === 0) {
        return {
            ...emptyTurnTokenUsage(),
            userMessageId,
        };
    }
    const usage = emptyTurnTokenUsage();
    usage.userMessageId = userMessageId;
    usage.assistantMessageCount = messages.size;
    for (const message of messages.values()) {
        addAssistantTokens({ usage, message });
    }
    return usage;
}
function collectAssistantMessages({ events, sessionId, upToIndex, parentID, }) {
    const latestByMessageId = new Map();
    for (let i = 0; i <= upToIndex; i++) {
        const event = events[i]?.event;
        if (event?.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'assistant') {
            continue;
        }
        if (parentID && info.parentID !== parentID) {
            continue;
        }
        latestByMessageId.set(info.id, info);
    }
    return latestByMessageId;
}
function getSessionInfoTokenUsage({ events, sessionId, upToIndex, }) {
    for (let i = upToIndex; i >= 0; i--) {
        const event = events[i]?.event;
        if (event?.type !== 'session.updated' && event?.type !== 'session.created') {
            continue;
        }
        const info = event.properties.info;
        if (info.id !== sessionId) {
            continue;
        }
        if (!info.tokens) {
            continue;
        }
        const usage = emptyTurnTokenUsage();
        usage.input = info.tokens.input;
        usage.output = info.tokens.output;
        usage.reasoning = info.tokens.reasoning;
        usage.cacheRead = info.tokens.cache.read;
        usage.cacheWrite = info.tokens.cache.write;
        usage.total = getTokenTotal(info.tokens);
        usage.cost = info.cost ?? 0;
        usage.model = info.model?.id;
        usage.providerID = info.model?.providerID;
        return usage.total > 0 || usage.cost > 0 ? usage : undefined;
    }
    return undefined;
}
// Latest billed token snapshot for the current user turn.
// Sums the last message.updated tokens per assistant message id so streaming
// updates are not double-counted. Scoped to sessionId so subagent idles
// report their own usage. Child task sessions often have no user message in
// the buffer; fall back to all assistant messages, then Session.tokens on
// session.updated (OpenCode projects per-session usage there).
export function getLatestTurnTokenUsage({ events, sessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    const latestUserMessage = getLatestUserMessage({
        events,
        sessionId,
        upToIndex,
    });
    if (latestUserMessage) {
        return sumAssistantMessages({
            messages: collectAssistantMessages({
                events,
                sessionId,
                upToIndex: end,
                parentID: latestUserMessage.id,
            }),
            userMessageId: latestUserMessage.id,
        });
    }
    const sessionAssistants = sumAssistantMessages({
        messages: collectAssistantMessages({
            events,
            sessionId,
            upToIndex: end,
        }),
    });
    if (sessionAssistants.total > 0 || sessionAssistants.assistantMessageCount > 0) {
        return sessionAssistants;
    }
    return getSessionInfoTokenUsage({
        events,
        sessionId,
        upToIndex: end,
    }) ?? emptyTurnTokenUsage();
}
function findFirstUserMessageIndex({ events, userMessageId, upToIndex, }) {
    for (let i = 0; i <= upToIndex; i++) {
        const event = events[i]?.event;
        if (event?.type !== 'message.updated') {
            continue;
        }
        if (event.properties.info.id === userMessageId) {
            return i;
        }
    }
    return undefined;
}
function findPreviousIdleIndexInTurn({ events, sessionId, firstUserMessageIndex, beforeIndex, }) {
    for (let i = beforeIndex - 1; i > firstUserMessageIndex; i--) {
        const event = events[i]?.event;
        if (event?.type === 'session.idle' && event.properties.sessionID === sessionId) {
            return i;
        }
    }
    return undefined;
}
function subtractTokenUsage({ current, previous, }) {
    return {
        input: current.input - previous.input,
        output: current.output - previous.output,
        reasoning: current.reasoning - previous.reasoning,
        cacheRead: current.cacheRead - previous.cacheRead,
        cacheWrite: current.cacheWrite - previous.cacheWrite,
        total: current.total - previous.total,
        cost: current.cost - previous.cost,
        model: current.model,
        providerID: current.providerID,
        assistantMessageCount: current.assistantMessageCount,
        userMessageId: current.userMessageId,
    };
}
function findFirstSessionEventIndex({ events, sessionId, upToIndex, }) {
    for (let i = 0; i <= upToIndex; i++) {
        const event = events[i]?.event;
        if (!event) {
            continue;
        }
        if (getEventBufferSessionId(event) === sessionId) {
            return i;
        }
    }
    return 0;
}
// Tokens billed since the previous session.idle in this user turn.
// Survives process restart because both idles stay in the event buffer.
// Child task sessions may have no user message.updated; scope from the first
// event for that sessionId instead so their tokens still emit.
export function getIdleTokenUsageDelta({ events, sessionId, idleEventIndex, }) {
    const current = getLatestTurnTokenUsage({
        events,
        sessionId,
        upToIndex: idleEventIndex,
    });
    if (current.total <= 0) {
        return undefined;
    }
    const firstUserMessageIndex = current.userMessageId
        ? findFirstUserMessageIndex({
            events,
            userMessageId: current.userMessageId,
            upToIndex: idleEventIndex,
        })
        : findFirstSessionEventIndex({
            events,
            sessionId,
            upToIndex: idleEventIndex,
        });
    if (firstUserMessageIndex === undefined) {
        return current;
    }
    const previousIdleIndex = findPreviousIdleIndexInTurn({
        events,
        sessionId,
        firstUserMessageIndex,
        beforeIndex: idleEventIndex,
    });
    if (previousIdleIndex === undefined) {
        return current;
    }
    const previous = getLatestTurnTokenUsage({
        events,
        sessionId,
        upToIndex: previousIdleIndex,
    });
    const delta = subtractTokenUsage({ current, previous });
    if (delta.total <= 0) {
        return undefined;
    }
    return delta;
}
const MIN_PROMPT_CACHE_READ_TO_TRACK = 1024;
const PROMPT_CACHE_DROP_RATIO = 0.5;
function hasPruneBetween({ events, sessionId, fromIndex, toIndex, }) {
    for (let i = fromIndex + 1; i <= toIndex; i++) {
        const event = events[i]?.event;
        if (event?.type !== 'message.part.updated') {
            continue;
        }
        const part = event.properties.part;
        if (part.sessionID !== sessionId || part.type !== 'tool') {
            continue;
        }
        if (part.state.status !== 'completed') {
            continue;
        }
        if (typeof part.state.time.compacted === 'number') {
            return true;
        }
    }
    return false;
}
function getCompletedAssistantAt({ events, sessionId, messageId, upToIndex, }) {
    for (let i = upToIndex; i >= 0; i--) {
        const event = events[i]?.event;
        if (event?.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
            continue;
        }
        if (typeof info.time.completed !== 'number') {
            return undefined;
        }
        return info;
    }
    return undefined;
}
function isComparableCacheAssistant(message) {
    if (!isUserFacingAssistantMessage(message)) {
        return false;
    }
    if (message.error) {
        return false;
    }
    if (!message.tokens || !message.modelID || !message.providerID) {
        return false;
    }
    return true;
}
// Same-model cache drop vs the previous completed assistant. Aborted/errored replies are skipped,
// compaction summaries and pruned tool output block the pair since they rewrite the prompt.
export function getPromptCacheClear({ events, sessionId, currentMessageId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    const current = getCompletedAssistantAt({
        events,
        sessionId,
        messageId: currentMessageId,
        upToIndex: end,
    });
    if (!current || !isComparableCacheAssistant(current) || !current.tokens) {
        return undefined;
    }
    const seen = new Set([currentMessageId]);
    for (let i = end; i >= 0; i--) {
        const event = events[i]?.event;
        if (event?.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'assistant') {
            continue;
        }
        if (seen.has(info.id) || info.parentID === current.parentID) {
            continue;
        }
        if (typeof info.time.completed !== 'number') {
            continue;
        }
        seen.add(info.id);
        if (!isUserFacingAssistantMessage(info)) {
            return undefined;
        }
        if (!isComparableCacheAssistant(info) || !info.tokens) {
            continue;
        }
        if (info.modelID !== current.modelID || info.providerID !== current.providerID) {
            return undefined;
        }
        if (hasPruneBetween({
            events,
            sessionId,
            fromIndex: i,
            toIndex: end,
        })) {
            return undefined;
        }
        // Anthropic reports a fresh cache as write only, so read alone misses the turn after a miss.
        const previousCached = info.tokens.cache.read + info.tokens.cache.write;
        const currentPrompt = current.tokens.input + current.tokens.cache.read + current.tokens.cache.write;
        // A reverted (shorter) prompt can only reuse its own length from cache.
        const expectedCacheRead = Math.min(previousCached, currentPrompt);
        if (expectedCacheRead < MIN_PROMPT_CACHE_READ_TO_TRACK) {
            return undefined;
        }
        if (current.tokens.cache.read > expectedCacheRead * PROMPT_CACHE_DROP_RATIO) {
            return undefined;
        }
        return {
            expectedCacheRead,
            currentCacheRead: current.tokens.cache.read,
            previousMessageId: info.id,
            currentMessageId: current.id,
            minutesSincePreviousMessage: Math.max(0, Math.round((current.time.created - info.time.completed) / 60_000)),
        };
    }
    return undefined;
}
export function formatCompactTokenCount(count) {
    if (count >= 1000) {
        const thousands = count / 1000;
        const rounded = thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1);
        return `${rounded.replace(/\.0$/, '')}k`;
    }
    return String(count);
}
export function formatPromptCacheClearMessage(clear, systemDiff) {
    const tokens = `prompt cache missed (${formatCompactTokenCount(clear.expectedCacheRead)} → ${formatCompactTokenCount(clear.currentCacheRead)}) (${clear.minutesSincePreviousMessage} mins passed)`;
    if (!systemDiff || (systemDiff.additions === 0 && systemDiff.deletions === 0)) {
        return tokens;
    }
    return `${tokens}, system +${systemDiff.additions} -${systemDiff.deletions}`;
}
// Scans backward for most recent message.updated with role=assistant for sessionId.
// Extracts model, providerID, agent, tokensUsed.
export function getLatestRunInfo({ events, sessionId, upToIndex, }) {
    const result = {
        model: undefined,
        providerID: undefined,
        agent: undefined,
        tokensUsed: 0,
    };
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const e = entry.event;
        if (e.type !== 'message.updated') {
            continue;
        }
        const msg = e.properties.info;
        if (msg.sessionID !== sessionId || msg.role !== 'assistant') {
            continue;
        }
        if (!isUserFacingAssistantMessage(msg)) {
            continue;
        }
        return {
            model: msg.modelID,
            providerID: msg.providerID,
            agent: msg.mode,
            tokensUsed: msg.tokens
                ? getTokenTotal(msg.tokens)
                : 0,
        };
    }
    return result;
}
export function getAssistantMessageIdsForLatestUserTurn({ events, sessionId, upToIndex, }) {
    const latestUserMessage = getLatestUserMessage({
        events,
        sessionId,
        upToIndex,
    });
    if (!latestUserMessage) {
        return new Set();
    }
    const end = upToIndex === undefined ? events.length : upToIndex + 1;
    const firstUserMessageIndexes = new Map();
    for (let i = 0; i < end; i++) {
        const event = events[i]?.event;
        if (event?.type !== 'message.updated') {
            continue;
        }
        const message = event.properties.info;
        if (message.sessionID === sessionId
            && message.role === 'user'
            && !firstUserMessageIndexes.has(message.id)) {
            firstUserMessageIndexes.set(message.id, i);
        }
    }
    const latestUserMessageIndex = firstUserMessageIndexes.get(latestUserMessage.id);
    const turnParentMessageIds = new Set([latestUserMessage.id]);
    if (latestUserMessageIndex !== undefined) {
        for (const [messageId, messageIndex] of firstUserMessageIndexes) {
            if (messageIndex < latestUserMessageIndex) {
                continue;
            }
            if (isInternalOpenCodeUserMessageId({
                events,
                sessionId,
                messageId,
                upToIndex,
            })) {
                turnParentMessageIds.add(messageId);
            }
        }
    }
    const assistantMessageIds = new Set();
    for (let i = 0; i < end; i++) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const e = entry.event;
        if (e.type !== 'message.updated') {
            continue;
        }
        const msg = e.properties.info;
        if (msg.sessionID !== sessionId || msg.role !== 'assistant') {
            continue;
        }
        if (!isUserFacingAssistantMessage(msg)) {
            continue;
        }
        if (turnParentMessageIds.has(msg.parentID)) {
            assistantMessageIds.add(msg.id);
        }
    }
    return assistantMessageIds;
}
export function didLatestUserTurnUseSleepTool({ events, sessionId, upToIndex, }) {
    const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
        events,
        sessionId,
        upToIndex,
    });
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const event = events[i]?.event;
        if (event?.type !== 'message.part.updated')
            continue;
        const part = event.properties.part;
        if (part.sessionID !== sessionId || part.type !== 'tool')
            continue;
        if (part.tool === 'dorimaki_sleep' && assistantMessageIds.has(part.messageID)) {
            return true;
        }
    }
    return false;
}
export function getLatestAssistantMessageIdForLatestUserTurn({ events, sessionId, upToIndex, }) {
    const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
        events,
        sessionId,
        upToIndex,
    });
    if (assistantMessageIds.size === 0) {
        return undefined;
    }
    const end = upToIndex ?? events.length - 1;
    let latestAssistantMessage;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const event = entry.event;
        if (event.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'assistant') {
            continue;
        }
        if (!isUserFacingAssistantMessage(info)) {
            continue;
        }
        if (!assistantMessageIds.has(info.id)) {
            continue;
        }
        if (!latestAssistantMessage) {
            latestAssistantMessage = info;
            continue;
        }
        if (info.time.created > latestAssistantMessage.time.created) {
            latestAssistantMessage = info;
        }
    }
    return latestAssistantMessage?.id;
}
function hasRenderablePartSummary(message) {
    if (!('partsSummary' in message) || !Array.isArray(message.partsSummary)) {
        return false;
    }
    return message.partsSummary.some((part) => {
        return part.type === 'text' || part.type === 'tool';
    });
}
function hasAssistantPartEvidence({ events, sessionId, messageId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const event = entry.event;
        if (event.type === 'message.updated') {
            const info = event.properties.info;
            if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
                continue;
            }
            if (hasRenderablePartSummary(info)) {
                return true;
            }
            continue;
        }
        if (event.type !== 'message.part.updated') {
            continue;
        }
        const { part } = event.properties;
        if (part.messageID !== messageId) {
            continue;
        }
        if (part.type === 'text' || part.type === 'tool') {
            return true;
        }
    }
    return false;
}
function hasAssistantStepFinished({ events, messageId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry || entry.event.type !== 'message.part.updated') {
            continue;
        }
        const { part } = entry.event.properties;
        if (part.messageID !== messageId) {
            continue;
        }
        if (part.type === 'step-finish') {
            return true;
        }
    }
    return false;
}
export function doesLatestUserTurnHaveNaturalCompletion({ events, sessionId, upToIndex, }) {
    const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
        events,
        sessionId,
        upToIndex,
    });
    if (!latestAssistantMessageId) {
        return false;
    }
    const end = upToIndex ?? events.length - 1;
    let latestAssistantMessage;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const event = entry.event;
        if (event.type !== 'message.updated') {
            continue;
        }
        const info = event.properties.info;
        if (info.sessionID !== sessionId || info.role !== 'assistant') {
            continue;
        }
        if (info.id !== latestAssistantMessageId) {
            continue;
        }
        latestAssistantMessage = info;
        if (isAssistantMessageNaturalCompletion({ message: info })) {
            return true;
        }
        break;
    }
    if (!latestAssistantMessage) {
        return false;
    }
    if (latestAssistantMessage.error) {
        return false;
    }
    if (latestAssistantMessage.finish === 'tool-calls') {
        return false;
    }
    return hasAssistantStepFinished({
        events,
        messageId: latestAssistantMessageId,
        upToIndex,
    }) && hasAssistantPartEvidence({
        events,
        sessionId,
        messageId: latestAssistantMessageId,
        upToIndex,
    });
}
export function isAssistantMessageInLatestUserTurn({ events, sessionId, messageId, upToIndex, }) {
    const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
        events,
        sessionId,
        upToIndex,
    });
    return assistantMessageIds.has(messageId);
}
export function isSummaryAssistantMessage({ events, sessionId, messageId, upToIndex, }) {
    return getAssistantMessageKind({
        events,
        sessionId,
        messageId,
        upToIndex,
    }) === 'summary';
}
// Returns a stable 1-based subtask index for candidateSessionId.
// Indexing scope is the parent assistant message that spawned the task tool calls,
// so numbering restarts at 1 for each assistant message.
export function getDerivedSubtaskIndex({ events, mainSessionId, candidateSessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    let parentAssistantMessageId;
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const candidate = getTaskCandidateFromEvent({
            event: entry.event,
            mainSessionId,
        });
        if (!candidate) {
            continue;
        }
        if (candidate.childSessionId !== candidateSessionId) {
            continue;
        }
        parentAssistantMessageId = candidate.assistantMessageId;
        break;
    }
    if (!parentAssistantMessageId) {
        return undefined;
    }
    const indexByChildSessionId = new Map();
    for (let i = 0; i <= end; i++) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const candidate = getTaskCandidateFromEvent({
            event: entry.event,
            mainSessionId,
        });
        if (!candidate || candidate.assistantMessageId !== parentAssistantMessageId) {
            continue;
        }
        if (!indexByChildSessionId.has(candidate.childSessionId)) {
            indexByChildSessionId.set(candidate.childSessionId, indexByChildSessionId.size + 1);
        }
    }
    return indexByChildSessionId.get(candidateSessionId);
}
// Returns the subagent_type (e.g. "explore", "general") for a given child session.
// Used to build labels like "explore-1" instead of generic "task-1".
export function getDerivedSubtaskAgentType({ events, mainSessionId, candidateSessionId, }) {
    for (let i = events.length - 1; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const candidate = getTaskCandidateFromEvent({
            event: entry.event,
            mainSessionId,
        });
        if (!candidate || candidate.childSessionId !== candidateSessionId || !candidate.subagentType) {
            continue;
        }
        return candidate.subagentType;
    }
    return undefined;
}
export function getDerivedSubtaskLabel({ events, mainSessionId, candidateSessionId, }) {
    const index = getDerivedSubtaskIndex({ events, mainSessionId, candidateSessionId });
    if (!index)
        return undefined;
    const agent = getDerivedSubtaskAgentType({ events, mainSessionId, candidateSessionId });
    return `${agent || 'task'}-${index}`;
}
export function getDerivedSubagentSessions({ events, mainSessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    const seenChildSessionIds = new Set();
    const sessions = [];
    for (let i = end; i >= 0; i--) {
        const entry = events[i];
        if (!entry) {
            continue;
        }
        const candidate = getTaskCandidateFromEvent({
            event: entry.event,
            mainSessionId,
        });
        if (!candidate || seenChildSessionIds.has(candidate.childSessionId)) {
            continue;
        }
        seenChildSessionIds.add(candidate.childSessionId);
        sessions.push({
            childSessionId: candidate.childSessionId,
            subagentType: candidate.subagentType,
            description: candidate.description,
            timestamp: entry.timestamp,
        });
    }
    return sessions;
}
function getParentIdFromSessionEvent(event) {
    if (event.type !== 'session.created' && event.type !== 'session.updated') {
        return undefined;
    }
    const parentID = event.properties.info.parentID;
    if (typeof parentID !== 'string' || parentID.length === 0) {
        return undefined;
    }
    return {
        sessionId: event.properties.info.id,
        parentID,
    };
}
// Global SSE is broadcast to every thread. Buffer only this thread's session
// plus its task/subagent children. /btw fork clones history onto a new
// sessionId; those events must not evict the parent's latest-turn buffer.
export function shouldBufferSessionEvent({ event, mainSessionId, isKnownChildSession, }) {
    if (event.type === 'session.diff' || event.type.endsWith('.delta')) {
        return false;
    }
    if (event.type === 'tui.toast.show') {
        return true;
    }
    const eventSessionId = getEventBufferSessionId(event);
    if (!eventSessionId) {
        return true;
    }
    // A new /btw thread registers the SSE listener before ensureSession.
    // Until the child session id is bound, drop every scoped event so the
    // parent clone flood cannot fill this buffer first.
    if (!mainSessionId) {
        return false;
    }
    if (eventSessionId === mainSessionId) {
        return true;
    }
    if (isKnownChildSession(eventSessionId)) {
        return true;
    }
    const parented = getParentIdFromSessionEvent(event);
    if (!parented) {
        return false;
    }
    return parented.parentID === mainSessionId || isKnownChildSession(parented.parentID);
}
// Child task sessions emit thousands of message.part.updated events. Those are
// still handled live for Discord display, but they must not occupy the bounded
// buffer or they evict parent session.status busy and `. queue` drains early.
// That is what aborted ses_f3c07efdbffeHwbaQhsE7fIz5z: live buffer mixed in
// child parts, persist dropped them, export still looked busy, drain fired.
// Keep child session/message lifecycle so token tracking and subtask identity
// still derive after the part flood.
export function shouldRetainSessionEvent({ event, mainSessionId, isKnownChildSession, }) {
    if (!shouldBufferSessionEvent({ event, mainSessionId, isKnownChildSession })) {
        return false;
    }
    const eventSessionId = getEventBufferSessionId(event);
    if (!eventSessionId || eventSessionId === mainSessionId) {
        return true;
    }
    return event.type !== 'message.part.updated';
}
export function trimEventBuffer({ events, mainSessionId, max, isKnownChildSession, }) {
    const retained = events.filter((entry) => {
        return shouldRetainSessionEvent({
            event: entry.event,
            mainSessionId,
            isKnownChildSession,
        });
    });
    if (retained.length <= max) {
        return retained;
    }
    return retained.slice(-max);
}
// Child sessions of the main thread: task tool metadata.sessionId, plus
// session.created/updated parentID (available before task metadata lands).
export function getDerivedChildSessionIds({ events, mainSessionId, upToIndex, }) {
    const end = upToIndex ?? events.length - 1;
    const ids = new Set();
    for (const session of getDerivedSubagentSessions({
        events,
        mainSessionId,
        upToIndex,
    })) {
        ids.add(session.childSessionId);
    }
    let grew = true;
    while (grew) {
        grew = false;
        for (let i = 0; i <= end; i++) {
            const event = events[i]?.event;
            if (!event) {
                continue;
            }
            const parented = getParentIdFromSessionEvent(event);
            if (!parented || ids.has(parented.sessionId)) {
                continue;
            }
            if (parented.parentID !== mainSessionId && !ids.has(parented.parentID)) {
                continue;
            }
            ids.add(parented.sessionId);
            grew = true;
        }
    }
    return ids;
}
export function isDerivedChildSession({ events, mainSessionId, candidateSessionId, upToIndex, }) {
    if (candidateSessionId === mainSessionId) {
        return false;
    }
    return getDerivedChildSessionIds({
        events,
        mainSessionId,
        upToIndex,
    }).has(candidateSessionId);
}
export function getTokenUsageSessionIdsForIdle({ events, mainSessionId, idleSessionId, upToIndex, }) {
    if (idleSessionId !== mainSessionId) {
        return [idleSessionId];
    }
    return [
        mainSessionId,
        ...getDerivedChildSessionIds({
            events,
            mainSessionId,
            upToIndex,
        }),
    ];
}
