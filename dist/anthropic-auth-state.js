// LEGACY rotation, superseded by @subrouter/opencode. See oauth-rotation-shared.ts.
/**
 * Anthropic OAuth account store and rotation.
 * Uses shared utilities from oauth-rotation-shared.ts for file locking,
 * store I/O, and account management. Anthropic-specific: store file path,
 * identity normalization via AnthropicAccountIdentity.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeAnthropicAccountIdentity, } from './anthropic-account-identity.js';
import { accountLabel, authFilePath, findCurrentAccountIndex, isOAuthStored, isPermanentOAuthRefreshFailure, normalizeAccountStore, readJson, upsertAccount as sharedUpsertAccount, withAuthStateLock, writeJson, shouldRotateAuth, } from './oauth-rotation-shared.js';
export { accountLabel, authFilePath, isOAuthStored, withAuthStateLock, shouldRotateAuth, isPermanentOAuthRefreshFailure, };
// --- Store file path ---
export function accountsFilePath() {
    if (process.env.XDG_DATA_HOME) {
        return path.join(process.env.XDG_DATA_HOME, 'opencode', 'anthropic-oauth-accounts.json');
    }
    return path.join(homedir(), '.local', 'share', 'opencode', 'anthropic-oauth-accounts.json');
}
// --- Store I/O ---
export async function loadAccountStore() {
    const raw = await readJson(accountsFilePath(), null);
    return normalizeAccountStore(raw);
}
export async function saveAccountStore(store) {
    await writeJson(accountsFilePath(), normalizeAccountStore(store));
}
// --- Upsert with Anthropic identity normalization ---
export function upsertAccount(store, auth, now = Date.now()) {
    const authWithIdentity = auth;
    const identity = normalizeAnthropicAccountIdentity({
        email: authWithIdentity.email,
        accountId: authWithIdentity.accountId,
    });
    return sharedUpsertAccount(store, { ...auth, ...identity }, now);
}
// --- Remember new login ---
export async function rememberAnthropicOAuth(auth, identity) {
    await withAuthStateLock(async () => {
        const store = await loadAccountStore();
        upsertAccount(store, { ...auth, ...normalizeAnthropicAccountIdentity(identity) });
        await saveAccountStore(store);
    });
}
// --- Auth file write + SDK sync ---
async function writeAnthropicAuthFile(auth) {
    const file = authFilePath();
    const data = await readJson(file, {});
    if (auth) {
        data.anthropic = auth;
    }
    else {
        delete data.anthropic;
    }
    await writeJson(file, data);
}
export async function setAnthropicAuth(auth, client) {
    await writeAnthropicAuthFile(auth);
    await client.auth.set({ providerID: 'anthropic', auth });
}
// --- Current account ---
export async function getCurrentAnthropicAccount() {
    const authJson = await readJson(authFilePath(), {});
    const auth = authJson.anthropic;
    if (!isOAuthStored(auth)) {
        return null;
    }
    const store = await loadAccountStore();
    const index = findCurrentAccountIndex(store, auth);
    const account = store.accounts[index];
    if (!account) {
        return { auth };
    }
    if (account.refresh !== auth.refresh && account.access !== auth.access) {
        return { auth };
    }
    return {
        auth,
        account,
        index,
    };
}
// --- Rotation ---
export async function rotateAnthropicAccount(auth, client) {
    return withAuthStateLock(async () => {
        const store = await loadAccountStore();
        if (store.accounts.length < 2)
            return undefined;
        const currentIndex = findCurrentAccountIndex(store, auth);
        const currentAccount = store.accounts[currentIndex];
        const nextIndex = (currentIndex + 1) % store.accounts.length;
        const nextAccount = store.accounts[nextIndex];
        if (!nextAccount)
            return undefined;
        const fromLabel = currentAccount
            ? accountLabel(currentAccount, currentIndex)
            : accountLabel(auth, currentIndex);
        nextAccount.lastUsed = Date.now();
        store.activeIndex = nextIndex;
        await saveAccountStore(store);
        const nextAuth = {
            type: 'oauth',
            refresh: nextAccount.refresh,
            access: nextAccount.access,
            expires: nextAccount.expires,
        };
        await setAnthropicAuth(nextAuth, client);
        return {
            auth: nextAuth,
            fromLabel,
            toLabel: accountLabel(nextAccount, nextIndex),
            fromIndex: currentIndex,
            toIndex: nextIndex,
        };
    });
}
// --- Remove account ---
/** Splice account at index and promote next. Caller must hold withAuthStateLock. */
async function spliceAccountAndPromote({ store, index, client, }) {
    store.accounts.splice(index, 1);
    if (store.accounts.length === 0) {
        store.activeIndex = 0;
        await saveAccountStore(store);
        await writeAnthropicAuthFile(undefined);
        return { store, active: undefined, activeLabel: undefined };
    }
    if (store.activeIndex > index) {
        store.activeIndex -= 1;
    }
    else if (store.activeIndex >= store.accounts.length) {
        store.activeIndex = 0;
    }
    const active = store.accounts[store.activeIndex];
    if (!active)
        throw new Error('Active Anthropic account disappeared during removal');
    active.lastUsed = Date.now();
    await saveAccountStore(store);
    const nextAuth = {
        type: 'oauth',
        refresh: active.refresh,
        access: active.access,
        expires: active.expires,
    };
    if (client) {
        await setAnthropicAuth(nextAuth, client);
    }
    else {
        await writeAnthropicAuthFile(nextAuth);
    }
    return {
        store,
        active: nextAuth,
        activeLabel: accountLabel(active, store.activeIndex),
    };
}
export async function removeAccount(index) {
    return withAuthStateLock(async () => {
        const store = await loadAccountStore();
        if (!Number.isInteger(index) || index < 0 || index >= store.accounts.length) {
            throw new Error(`Account ${index + 1} does not exist`);
        }
        return spliceAccountAndPromote({ store, index });
    });
}
/**
 * Remove the pool entry matching these OAuth credentials and promote the next
 * account. Used when refresh fails permanently (invalid_grant).
 */
export async function removeAccountByAuth(auth, client) {
    return withAuthStateLock(async () => {
        const store = await loadAccountStore();
        const index = store.accounts.findIndex((account) => account.refresh === auth.refresh || account.access === auth.access);
        if (index < 0)
            return undefined;
        const removed = store.accounts[index];
        if (!removed)
            return undefined;
        const removedLabel = accountLabel(removed, index);
        const result = await spliceAccountAndPromote({ store, index, client });
        return {
            removedLabel,
            activeLabel: result.activeLabel,
            active: result.active,
        };
    });
}
