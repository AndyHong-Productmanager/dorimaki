// Centralized zustand/vanilla store for global bot state.
// Replaces scattered module-level `let` variables, process.env mutations,
// and mutable arrays with a single immutable state atom.
// See skills/zustand-centralized-state/SKILL.md for the pattern.
import { createStore } from 'zustand/vanilla';
export const store = createStore(() => ({
    dataDir: null,
    projectsDir: null,
    defaultVerbosity: 'text_and_essential_tools',
    defaultMentionMode: false,
    critiqueEnabled: true,
    footerMentionsEnabled: false,
    enabledSkills: [],
    disabledSkills: [],
    allowedMentions: ['users'],
    allowAllUsers: false,
    opencodeHostname: null,
    opencodePort: null,
    restrictExternalDirectories: false,
    permissionTimeoutMs: 10 * 60 * 1000,
    useWorktrees: false,
    autoUpgradeEnabled: true,
    syncEnabled: true,
    discordBaseUrl: 'https://discord.com',
    gatewayToken: null,
    registeredUserCommands: [],
    threads: new Map(),
    test: { deterministicTranscription: null },
}));
