// OpenCode plugin that detects system prompt drift across turns.
// When the system prompt changes between user messages, it logs a warning
// with addition/deletion line counts so you know context cache was discarded.
// This helps spot plugins that mutate the system prompt unexpectedly.
import * as errore from 'errore';
import { countSystemPromptDiffLines, writeSystemPromptPatch, } from './cache-rewrite.js';
import { createPluginLogger, formatPluginErrorWithStack, setPluginLogFilePath } from './plugin-logger.js';
import { initSentry, notifyError } from './sentry.js';
const logger = createPluginLogger('OPENCODE');
function normalizeSystemPrompt({ system }) {
    return system.join('\n');
}
function buildTurnContext({ input, directory, }) {
    const model = input.model
        ? `${input.model.providerID}/${input.model.modelID}${input.variant ? `:${input.variant}` : ''}`
        : undefined;
    return {
        agent: input.agent,
        model,
        directory,
    };
}
function shouldSuppressDriftWarning({ previousContext, currentContext, }) {
    if (!previousContext || !currentContext)
        return false;
    return (previousContext.agent !== currentContext.agent
        || previousContext.model !== currentContext.model
        || previousContext.directory !== currentContext.directory);
}
function getOrCreateSessionState({ sessions, sessionId, }) {
    const existing = sessions.get(sessionId);
    if (existing)
        return existing;
    const state = {
        userTurnCount: 0,
        previousTurnPrompt: undefined,
        latestTurnPrompt: undefined,
        latestTurnPromptTurn: 0,
        comparedTurn: 0,
        previousTurnContext: undefined,
        currentTurnContext: undefined,
        pendingCompareTimeout: undefined,
    };
    sessions.set(sessionId, state);
    return state;
}
function handleSystemTransform({ input, output, sessions, dataDir, }) {
    const sessionId = input.sessionID;
    if (!sessionId)
        return;
    const currentPrompt = normalizeSystemPrompt({ system: output.system });
    const state = getOrCreateSessionState({ sessions, sessionId });
    const currentTurn = state.userTurnCount;
    state.latestTurnPrompt = currentPrompt;
    state.latestTurnPromptTurn = currentTurn;
    if (currentTurn <= 1)
        return;
    if (state.comparedTurn === currentTurn)
        return;
    const previousPrompt = state.previousTurnPrompt;
    state.comparedTurn = currentTurn;
    if (!previousPrompt || previousPrompt === currentPrompt)
        return;
    if (shouldSuppressDriftWarning({
        previousContext: state.previousTurnContext,
        currentContext: state.currentTurnContext,
    })) {
        return;
    }
    const { additions, deletions } = countSystemPromptDiffLines({
        beforeText: previousPrompt,
        afterText: currentPrompt,
    });
    const model = state.currentTurnContext?.model;
    const agent = state.currentTurnContext?.agent;
    if (!dataDir) {
        logger.warn(`[cache-drift] system prompt changed for session ${sessionId} `
            + `(+${additions} / -${deletions}), no data dir for patch`);
        return;
    }
    void writeSystemPromptPatch({
        dataDir,
        sessionId,
        beforeText: previousPrompt,
        afterText: currentPrompt,
        model,
        agent,
    }).then((filePath) => {
        logger.warn(`[cache-drift] system prompt changed for session ${sessionId} `
            + `(+${additions} / -${deletions}) patch=${filePath}`);
    }).catch((error) => {
        logger.warn(`[cache-drift] ${formatPluginErrorWithStack(error)}`);
        void notifyError(error, 'cache drift patch write failed');
    });
}
function getDeletedSessionId({ event }) {
    if (event.type !== 'session.deleted')
        return undefined;
    const sessionInfo = event.properties?.info;
    if (!sessionInfo || typeof sessionInfo !== 'object')
        return undefined;
    const id = sessionInfo.id;
    return typeof id === 'string' ? id : undefined;
}
const cacheDriftPlugin = async ({ directory }) => {
    initSentry();
    const dataDir = process.env.DORIMAKI_DATA_DIR;
    if (dataDir) {
        setPluginLogFilePath(dataDir);
    }
    const sessions = new Map();
    return {
        'chat.message': async (input) => {
            const sessionId = input.sessionID;
            if (!sessionId)
                return;
            const state = getOrCreateSessionState({ sessions, sessionId });
            if (state.userTurnCount > 0
                && state.latestTurnPromptTurn === state.userTurnCount) {
                state.previousTurnPrompt = state.latestTurnPrompt;
                state.previousTurnContext = state.currentTurnContext;
            }
            state.currentTurnContext = buildTurnContext({ input, directory });
            state.userTurnCount += 1;
        },
        'experimental.chat.system.transform': async (input, output) => {
            const result = errore.try({
                try: () => {
                    const sessionId = input.sessionID;
                    if (!sessionId)
                        return;
                    const state = getOrCreateSessionState({ sessions, sessionId });
                    if (state.pendingCompareTimeout) {
                        clearTimeout(state.pendingCompareTimeout);
                    }
                    // Delay one tick so other system-transform hooks can finish mutating
                    // output.system before we snapshot it for drift detection.
                    state.pendingCompareTimeout = setTimeout(() => {
                        state.pendingCompareTimeout = undefined;
                        try {
                            handleSystemTransform({ input, output, sessions, dataDir });
                        }
                        catch (err) {
                            logger.warn(`[cache-drift] ${formatPluginErrorWithStack(err)}`);
                            void notifyError(err, 'cache drift plugin transform hook failed');
                        }
                    }, 0);
                },
                catch: (error) => {
                    return new Error('cache drift transform hook failed', { cause: error });
                },
            });
            if (result instanceof Error) {
                logger.warn(`[cache-drift] ${formatPluginErrorWithStack(result)}`);
                void notifyError(result, 'cache drift plugin transform hook failed');
            }
        },
        event: async ({ event }) => {
            const result = errore.try({
                try: () => {
                    if (event.type !== 'session.deleted')
                        return;
                    const deletedSessionId = getDeletedSessionId({ event });
                    if (!deletedSessionId)
                        return;
                    const state = sessions.get(deletedSessionId);
                    if (state?.pendingCompareTimeout) {
                        clearTimeout(state.pendingCompareTimeout);
                    }
                    sessions.delete(deletedSessionId);
                },
                catch: (error) => {
                    return new Error('cache drift event hook failed', { cause: error });
                },
            });
            if (result instanceof Error) {
                logger.warn(`[cache-drift] ${formatPluginErrorWithStack(result)}`);
                void notifyError(result, 'cache drift plugin event hook failed');
            }
        },
    };
};
export { cacheDriftPlugin };
