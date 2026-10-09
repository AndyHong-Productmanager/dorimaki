// Session search helpers for dorimaki CLI commands.
// Parses string/regex queries and builds readable snippets from matched content.
// Default window so search does not load years of old session messages.
export const SESSION_SEARCH_DEFAULT_DAYS = 14;
export const SESSION_SEARCH_MESSAGE_CONCURRENCY = 4;
export function parseSessionSearchPattern(query) {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return new Error('Search query cannot be empty');
    }
    const regexMatch = trimmedQuery.match(/^\/([\s\S]+)\/([a-z]*)$/);
    if (!regexMatch) {
        return {
            mode: 'literal',
            raw: trimmedQuery,
            normalizedNeedle: trimmedQuery.toLowerCase(),
        };
    }
    const pattern = regexMatch[1] || '';
    const flags = regexMatch[2] || '';
    try {
        return {
            mode: 'regex',
            raw: trimmedQuery,
            regex: new RegExp(pattern, flags),
        };
    }
    catch (error) {
        return new Error(`Invalid regex query "${trimmedQuery}": ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function findFirstSessionSearchHit({ text, searchPattern, }) {
    if (searchPattern.mode === 'literal') {
        const index = text.toLowerCase().indexOf(searchPattern.normalizedNeedle);
        if (index < 0) {
            return undefined;
        }
        return {
            index,
            length: searchPattern.raw.length,
        };
    }
    searchPattern.regex.lastIndex = 0;
    const match = searchPattern.regex.exec(text);
    if (!match || match.index < 0) {
        return undefined;
    }
    return {
        index: match.index,
        length: Math.max(match[0]?.length || 0, 1),
    };
}
export function buildSessionSearchSnippet({ text, hit, contextLength = 90, }) {
    const start = Math.max(0, hit.index - contextLength);
    const end = Math.min(text.length, hit.index + hit.length + contextLength);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    const body = text
        .slice(start, end)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return `${prefix}${body}${suffix}`;
}
function stringifyUnknown(value) {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
export function getPartSearchTexts(part) {
    switch (part.type) {
        case 'text':
            return part.text ? [part.text] : [];
        case 'reasoning':
            return part.text ? [part.text] : [];
        case 'tool': {
            const inputText = stringifyUnknown(part.state?.input);
            const outputText = part.state?.status === 'completed'
                ? stringifyUnknown(part.state.output)
                : part.state?.status === 'error'
                    ? part.state.error || ''
                    : '';
            return [`tool:${part.tool || ''}`, inputText, outputText].filter((entry) => {
                return entry.trim().length > 0;
            });
        }
        case 'file':
            return [part.filename || '', part.url || ''].filter((entry) => {
                return entry.trim().length > 0;
            });
        default:
            return [];
    }
}
export function validateSessionSearchScope({ all, project, channel, }) {
    if (all && (project || channel)) {
        return new Error('Use --all alone. Do not combine it with --project or --channel. Search one project with: dorimaki session search "query" --project /path');
    }
    if (project && channel) {
        return new Error('Use either --project or --channel, not both');
    }
    return null;
}
export function parseSessionSearchDays(raw) {
    if (raw === undefined) {
        return SESSION_SEARCH_DEFAULT_DAYS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
        return new Error(`Invalid --days value: ${raw}. Use a whole number of days, or 0 for all time.`);
    }
    return parsed;
}
export function sessionSearchMinUpdated({ days, now = Date.now(), }) {
    if (days === 0) {
        return undefined;
    }
    return now - days * 24 * 60 * 60 * 1000;
}
export function resolveSessionSearchDirectories({ all, registeredDirectories, cwd, explicitDirectory, }) {
    if (!all) {
        return [explicitDirectory || cwd];
    }
    const uniqueDirectories = [...new Set(registeredDirectories)];
    if (uniqueDirectories.length === 0) {
        return new Error('No registered projects found. Add a project first with `dorimaki project add`, or search one directory with --project.');
    }
    return uniqueDirectories;
}
export function getSessionSearchSnippets({ messages, searchPattern, }) {
    return messages
        .flatMap((message) => {
        const rolePrefix = message.info.role === 'assistant'
            ? 'assistant'
            : message.info.role === 'user'
                ? 'user'
                : 'message';
        return message.parts
            .filter((part) => !(part.type === 'text' && part.synthetic))
            .flatMap((part) => {
            return getPartSearchTexts(part).flatMap((text) => {
                const hit = findFirstSessionSearchHit({
                    text,
                    searchPattern,
                });
                if (!hit) {
                    return [];
                }
                const snippet = buildSessionSearchSnippet({ text, hit });
                if (!snippet) {
                    return [];
                }
                return [`${rolePrefix}: ${snippet}`];
            });
        });
    })
        .slice(0, 3);
}
export async function collectSessionSearchMatches({ sessions, searchPattern, sessionToThread, limit, minUpdated, concurrency = SESSION_SEARCH_MESSAGE_CONCURRENCY, loadMessages, onMatch, }) {
    const sortedSessions = [...sessions]
        .sort((a, b) => {
        return b.updated - a.updated;
    })
        .filter((session) => {
        return minUpdated === undefined || session.updated >= minUpdated;
    });
    const matches = [];
    let scannedSessions = 0;
    const batchSize = Math.max(1, concurrency);
    for (let offset = 0; offset < sortedSessions.length; offset += batchSize) {
        if (matches.length >= limit) {
            break;
        }
        const batch = sortedSessions.slice(offset, offset + batchSize);
        scannedSessions += batch.length;
        const loadedBatch = await Promise.all(batch.map(async (session) => {
            const messages = session.messages
                ? session.messages
                : loadMessages
                    ? await loadMessages(session)
                    : [];
            return { session, messages };
        }));
        for (const { session, messages } of loadedBatch) {
            if (matches.length >= limit) {
                break;
            }
            const snippets = getSessionSearchSnippets({
                messages,
                searchPattern,
            });
            if (snippets.length === 0) {
                continue;
            }
            const threadId = sessionToThread.get(session.id);
            const match = {
                id: session.id,
                title: session.title || 'Untitled Session',
                directory: session.directory,
                updated: new Date(session.updated).toISOString(),
                source: threadId ? 'dorimaki' : 'opencode',
                threadId: threadId || null,
                snippets,
            };
            matches.push(match);
            onMatch?.(match);
        }
    }
    return { matches, scannedSessions };
}
