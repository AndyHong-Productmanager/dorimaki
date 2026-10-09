// Dorimaki git worktree adaptor for OpenCode's experimental workspace system.
// Runs inside the opencode server process (NOT the bot process).
//
// PLUGIN SAFETY: This file must NOT import config.ts, logger.ts, or any
// module that pulls them in (like worktrees.ts). Uses git-worktree-core.ts
// which is designed to be plugin-safe (no logger/config dependencies).
// Never use console.log/console.error — plugins must be silent.
import crypto from 'node:crypto';
import path from 'node:path';
import { createWorktreeCore, DORIMAKI_WORKTREE_ADAPTER_TYPE, removeWorktreeFromOwnRepository, } from './git-worktree-core.js';
/**
 * Compute the on-disk directory for a managed worktree.
 * Mirrors getManagedWorktreeDirectory from worktrees.ts but reads DORIMAKI_DATA_DIR
 * from the environment instead of config.ts (which is not available in the
 * opencode server process).
 */
function computeWorktreeDirectory({ projectDirectory, branchName, }) {
    const dataDir = process.env.DORIMAKI_DATA_DIR;
    if (!dataDir) {
        return new Error('DORIMAKI_DATA_DIR not set — cannot compute worktree directory');
    }
    const projectHash = crypto
        .createHash('sha1')
        .update(projectDirectory)
        .digest('hex')
        .slice(0, 8);
    const withoutPrefix = branchName
        .replace(/^opencode\/dorimaki-/, '')
        .replaceAll('/', '-');
    return path.join(dataDir, 'worktrees', projectHash, withoutPrefix);
}
function getWorktreeIdentity(info) {
    if (!info.extra || typeof info.extra !== 'object') {
        return new Error('Dorimaki worktree identity is missing');
    }
    const identity = {};
    Object.assign(identity, info.extra);
    if (typeof identity.projectDirectory !== 'string' ||
        !path.isAbsolute(identity.projectDirectory)) {
        return new Error('Dorimaki worktree project directory must be absolute');
    }
    if (typeof identity.baseCommit !== 'string' ||
        !/^[0-9a-f]{40}$/i.test(identity.baseCommit)) {
        return new Error('Dorimaki worktree base commit must be a full commit SHA');
    }
    return {
        projectDirectory: identity.projectDirectory,
        baseCommit: identity.baseCommit,
    };
}
function createDorimakiWorktreeAdaptor() {
    return {
        name: 'Dorimaki Worktree',
        description: 'Create a git worktree managed by Dorimaki',
        configure(info) {
            const identity = getWorktreeIdentity(info);
            if (identity instanceof Error)
                throw identity;
            const branchName = info.branch || info.name;
            const directory = computeWorktreeDirectory({
                projectDirectory: identity.projectDirectory,
                branchName,
            });
            if (directory instanceof Error) {
                return { ...info, branch: branchName };
            }
            return {
                ...info,
                name: info.name || branchName,
                branch: branchName,
                directory,
            };
        },
        async create(info) {
            if (!info.directory) {
                throw new Error('Workspace directory not set — configure() likely failed');
            }
            const identity = getWorktreeIdentity(info);
            if (identity instanceof Error)
                throw identity;
            const result = await createWorktreeCore({
                projectDirectory: identity.projectDirectory,
                targetDirectory: info.directory,
                branchName: info.branch || info.name,
                baseCommit: identity.baseCommit,
                // Silent log — plugin must not write to stdout/stderr
            });
            if (result instanceof Error) {
                throw result;
            }
        },
        async remove(info) {
            if (!info.directory)
                return;
            const result = await removeWorktreeFromOwnRepository({
                worktreeDirectory: info.directory,
                branchName: info.branch || '',
            });
            if (result instanceof Error) {
                throw result;
            }
        },
        target(info) {
            return {
                type: 'local',
                directory: info.directory,
            };
        },
    };
}
/**
 * Plugin entrypoint — registers the dorimaki-worktree adaptor.
 * Called by OpenCode's plugin loader.
 */
export const dorimakiWorkspaceAdaptorPlugin = async ({ experimental_workspace, }) => {
    experimental_workspace.register(DORIMAKI_WORKTREE_ADAPTER_TYPE, createDorimakiWorktreeAdaptor());
    return {};
};
