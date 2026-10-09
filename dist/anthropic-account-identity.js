// LEGACY rotation, superseded by @subrouter/opencode. See oauth-rotation-shared.ts.
// Helpers for Anthropic OAuth account and Claude Code client identity.
const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.280 (external, cli)';
export function applyClaudeCodeRequestIdentity({ headers, accessToken, }) {
    headers.set('authorization', `Bearer ${accessToken}`);
    headers.set('user-agent', process.env.OPENCODE_ANTHROPIC_USER_AGENT || CLAUDE_CODE_USER_AGENT);
    headers.set('x-app', 'cli');
    return headers;
}
const identityHintKeys = new Set(['user', 'profile', 'account', 'viewer']);
const idKeys = ['user_id', 'userId', 'account_id', 'accountId', 'id', 'sub'];
export function normalizeAnthropicAccountIdentity(identity) {
    const email = typeof identity?.email === 'string' && identity.email.trim()
        ? identity.email.trim().toLowerCase()
        : undefined;
    const accountId = typeof identity?.accountId === 'string' && identity.accountId.trim()
        ? identity.accountId.trim()
        : undefined;
    if (!email && !accountId)
        return undefined;
    return {
        ...(email ? { email } : {}),
        ...(accountId ? { accountId } : {}),
    };
}
function getCandidateFromRecord(record, path) {
    const email = typeof record.email === 'string' ? record.email : undefined;
    const accountId = idKeys
        .map((key) => {
        const value = record[key];
        return typeof value === 'string' ? value : undefined;
    })
        .find((value) => {
        return Boolean(value);
    });
    const normalized = normalizeAnthropicAccountIdentity({ email, accountId });
    if (!normalized)
        return undefined;
    const hasIdentityHint = path.some((segment) => {
        return identityHintKeys.has(segment);
    });
    return {
        ...normalized,
        score: (normalized.email ? 4 : 0) + (normalized.accountId ? 2 : 0) + (hasIdentityHint ? 2 : 0),
    };
}
function collectIdentityCandidates(value, path = []) {
    if (!value || typeof value !== 'object')
        return [];
    if (Array.isArray(value)) {
        return value.flatMap((entry) => {
            return collectIdentityCandidates(entry, path);
        });
    }
    const record = value;
    const nested = Object.entries(record).flatMap(([key, entry]) => {
        return collectIdentityCandidates(entry, [...path, key]);
    });
    const current = getCandidateFromRecord(record, path);
    return current ? [current, ...nested] : nested;
}
export function extractAnthropicAccountIdentity(value) {
    const candidates = collectIdentityCandidates(value);
    const best = candidates.sort((a, b) => {
        return b.score - a.score;
    })[0];
    if (!best)
        return undefined;
    return normalizeAnthropicAccountIdentity(best);
}
