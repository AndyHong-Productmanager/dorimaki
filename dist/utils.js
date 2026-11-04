// General utility functions for the bot.
// Includes Discord OAuth URL generation, array deduplication,
// abort error detection, and date/time formatting helpers.
import os from 'node:os';
// Use namespace import for CJS interop — discord.js is CJS and its named
// exports aren't detectable by all ESM loaders (e.g. tsx/esbuild) because
// discord.js uses tslib's __exportStar which is opaque to static analysis.
import * as discord from 'discord.js';
const { PermissionsBitField } = discord;
import * as errore from 'errore';
export function generateBotInstallUrl({ clientId, permissions = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.SendMessagesInThreads,
    PermissionsBitField.Flags.CreatePublicThreads,
    PermissionsBitField.Flags.ManageThreads,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.AddReactions,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.UseExternalEmojis,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.ManageEvents,
    PermissionsBitField.Flags.CreateEvents,
], scopes = ['bot', 'applications.commands', 'identify', 'email'], guildId, disableGuildSelect = false, state, redirectUri, responseType, }) {
    const permissionsBitField = new PermissionsBitField(permissions);
    const permissionsValue = permissionsBitField.bitfield.toString();
    const url = new URL('https://discord.com/api/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('permissions', permissionsValue);
    url.searchParams.set('scope', scopes.join(' '));
    if (guildId) {
        url.searchParams.set('guild_id', guildId);
    }
    if (disableGuildSelect) {
        url.searchParams.set('disable_guild_select', 'true');
    }
    if (state) {
        url.searchParams.set('state', state);
    }
    if (redirectUri) {
        url.searchParams.set('redirect_uri', redirectUri);
    }
    if (responseType) {
        url.searchParams.set('response_type', responseType);
    }
    return url.toString();
}
export const DORIMAKI_GATEWAY_APP_ID = process.env.DORIMAKI_GATEWAY_APP_ID || '1477605701202481173';
export const DORIMAKI_WEBSITE_URL = process.env.DORIMAKI_WEBSITE_URL || 'https://kimaki.dev';
export function generateDiscordInstallUrlForBot({ appId, mode, clientId, clientSecret, gatewayCallbackUrl, reachableUrl, }) {
    if (mode !== 'gateway') {
        return generateBotInstallUrl({ clientId: appId });
    }
    if (!clientId || !clientSecret) {
        return new Error('Gateway credentials are missing from local database');
    }
    // In gateway mode, redirect to the website's /discord-install route.
    // This initiates the better-auth OAuth flow with clientId/clientSecret
    // as additionalData, which better-auth stores in its verification table
    // and recovers after Discord redirects back to the callback.
    // Use a dorimaki-specific callback field name to avoid ambiguity with
    // better-auth's own callbackURL state field.
    const url = new URL(`${DORIMAKI_WEBSITE_URL}/discord-install`);
    url.searchParams.set('clientId', clientId);
    url.searchParams.set('clientSecret', clientSecret);
    if (gatewayCallbackUrl) {
        url.searchParams.set('dorimakiCallbackUrl', gatewayCallbackUrl);
    }
    if (reachableUrl) {
        url.searchParams.set('reachableUrl', reachableUrl);
    }
    return url.toString();
}
export function deduplicateByKey(arr, keyFn) {
    const seen = new Set();
    return arr.filter((item) => {
        const key = keyFn(item);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
// Delegates to errore.isAbortError (walks cause chain for AbortError instances),
// then falls back to opencode server-specific abort patterns that aren't
// errore.AbortError but still represent aborted operations.
export function isAbortError(error) {
    if (errore.isAbortError(error))
        return true;
    if (!(error instanceof Error))
        return false;
    return (error.name === 'MessageAbortedError' ||
        error.message?.includes('aborted') === true);
}
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const TIME_DIVISIONS = [
    { amount: 60, name: 'seconds' },
    { amount: 60, name: 'minutes' },
    { amount: 24, name: 'hours' },
    { amount: 7, name: 'days' },
    { amount: 4.34524, name: 'weeks' },
    { amount: 12, name: 'months' },
    { amount: Number.POSITIVE_INFINITY, name: 'years' },
];
export function formatDistanceToNow(date) {
    let duration = (date.getTime() - Date.now()) / 1000;
    for (const division of TIME_DIVISIONS) {
        if (Math.abs(duration) < division.amount) {
            return rtf.format(Math.round(duration), division.name);
        }
        duration /= division.amount;
    }
    return rtf.format(Math.round(duration), 'years');
}
const dtf = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
});
export function formatDateTime(date) {
    return dtf.format(date);
}
// Comprehensive ANSI escape sequence regex covering CSI, OSC, and related sequences.
// Valid string terminator sequences are BEL, ESC\, and 0x9c.
const ANSI_REGEX = (() => {
    const ST = '(?:\\u0007|\\u001B\\u005C|\\u009C)';
    const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
    const csi = '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]';
    return new RegExp(`${osc}|${csi}`, 'g');
})();
export function stripAnsi(str) {
    return str.replace(ANSI_REGEX, '');
}
export function abbreviatePath(fullPath) {
    const home = os.homedir();
    if (fullPath.startsWith(home)) {
        return '~' + fullPath.slice(home.length);
    }
    return fullPath;
}
