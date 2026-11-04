// omo provider login over RPC (`login_start`), surfaced to Discord by
// commands/omo-login.ts.
//
// Logins are fire-command-then-subscribe: the command answers once the flow
// starts, then the URL, progress lines, mid-flow dialogs and the final
// result arrive as event records on the control session.
import os from 'node:os';
import { createLogger, LogPrefix } from '../logger.js';
import { clearOmoCatalog } from './catalog.js';
import { callControl, openControl } from './sessions.js';
const logger = createLogger(LogPrefix.LOGIN);
/** OAuth providers omo can sign in to. API keys stay on the omo CLI. */
export async function listOmoOAuthProviders() {
    const { data } = await callControl(os.homedir(), 'get_auth_providers');
    const rows = Array.isArray(data?.providers) ? data.providers : [];
    return rows
        .filter((row) => row.authType === 'oauth' && typeof row.id === 'string')
        .map((row) => ({
        id: row.id,
        name: typeof row.name === 'string' ? row.name : row.id,
        configured: row.status?.configured === true,
    }));
}
export async function startOmoLogin({ provider, onEvent, }) {
    const control = await openControl(os.homedir());
    let finished = false;
    const unsubscribe = control.conn.onRecord((record) => {
        if (finished || record.sessionId !== control.handle)
            return;
        switch (record.type) {
            case 'auth_login_url':
                if (record.provider === provider)
                    onEvent({ type: 'url', url: String(record.url) });
                return;
            case 'auth_login_progress':
                if (record.provider === provider)
                    onEvent({ type: 'progress', text: String(record.text ?? '') });
                return;
            case 'auth_login_end':
                if (record.provider !== provider)
                    return;
                finished = true;
                unsubscribe();
                clearOmoCatalog();
                onEvent({
                    type: 'end',
                    success: record.success === true,
                    error: typeof record.error === 'string' ? record.error : undefined,
                });
                return;
            case 'extension_ui_request':
                if (record.method === 'select' && Array.isArray(record.options)) {
                    onEvent({
                        type: 'select',
                        requestId: String(record.id),
                        title: String(record.title ?? 'Choose an option'),
                        options: record.options.map(String),
                    });
                }
                else if (record.method === 'input') {
                    onEvent({
                        type: 'input',
                        requestId: String(record.id),
                        title: String(record.title ?? 'Enter a value'),
                        placeholder: typeof record.placeholder === 'string' ? record.placeholder : undefined,
                    });
                }
                return;
            default:
                return;
        }
    });
    control.conn.onClose(() => {
        if (finished)
            return;
        finished = true;
        unsubscribe();
        onEvent({ type: 'end', success: false, error: 'omo engine stopped' });
    });
    try {
        await control.conn.call('login_start', { sessionId: control.handle, provider });
    }
    catch (e) {
        finished = true;
        unsubscribe();
        throw e;
    }
    logger.log(`[OMO LOGIN] started ${provider}`);
    return {
        async answer(requestId, value) {
            await control.conn.call('extension_ui_response', {
                sessionId: control.handle,
                uiRequestId: requestId,
                value,
            });
        },
        async cancel() {
            if (finished)
                return;
            await control.conn.call('login_cancel', { sessionId: control.handle, provider });
        },
    };
}
