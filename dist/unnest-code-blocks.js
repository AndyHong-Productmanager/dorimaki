// Unnest code blocks from list items for Discord.
// Discord doesn't render code blocks inside lists, so this hoists them
// to root level while preserving list structure.
import { Lexer } from 'marked';
export function unnestCodeBlocksFromLists(markdown) {
    const lexer = new Lexer();
    const tokens = lexer.lex(markdown);
    const result = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const next = tokens[i + 1];
        const chunk = (() => {
            if (token.type === 'list') {
                const segments = processListToken(token);
                return renderSegments(segments);
            }
            return token.raw;
        })();
        if (!chunk) {
            continue;
        }
        const nextRaw = next?.raw ?? '';
        const needsNewline = nextRaw &&
            !chunk.endsWith('\n') &&
            typeof nextRaw === 'string' &&
            !nextRaw.startsWith('\n');
        result.push(needsNewline ? chunk + '\n' : chunk);
    }
    return result.join('');
}
function processListToken(list) {
    const segments = [];
    const start = typeof list.start === 'number' ? list.start : parseInt(list.start, 10) || 1;
    const prefix = list.ordered ? (i) => `${start + i}. ` : () => '- ';
    for (let i = 0; i < list.items.length; i++) {
        const item = list.items[i];
        const itemSegments = processListItem(item, prefix(i));
        segments.push(...itemSegments);
    }
    return segments;
}
function processListItem(item, prefix) {
    const segments = [];
    let currentText = [];
    // Track if we've seen a code block - text after code uses continuation prefix
    let seenCodeBlock = false;
    const taskMarker = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
    let wroteFirstListItem = false;
    const flushText = () => {
        const rawText = currentText.join('');
        const text = rawText.trimEnd();
        if (text.trim()) {
            // After a code block, use '-' as continuation prefix to avoid repeating numbers
            const effectivePrefix = seenCodeBlock ? '- ' : prefix;
            const marker = !wroteFirstListItem ? taskMarker : '';
            const normalizedText = normalizeListItemText({
                text,
                isTaskItem: item.task,
            });
            segments.push({
                type: 'list-item',
                prefix: effectivePrefix,
                content: marker + normalizedText,
            });
            wroteFirstListItem = true;
        }
        currentText = [];
    };
    for (const token of item.tokens) {
        if (token.type === 'code') {
            flushText();
            const codeToken = token;
            const lang = codeToken.lang || '';
            segments.push({
                type: 'code',
                content: '```' + lang + '\n' + codeToken.text + '\n```\n',
            });
            seenCodeBlock = true;
            continue;
        }
        if (token.type === 'list') {
            flushText();
            // Recursively process nested list - segments bubble up
            const nestedSegments = processListToken(token);
            segments.push(...nestedSegments);
            continue;
        }
        currentText.push(extractText(token));
    }
    flushText();
    // If no segments were created (empty item), return empty
    if (segments.length === 0) {
        return [];
    }
    // If item had no code blocks (all segments are list-items from this level),
    // return original raw to preserve formatting
    const hasCode = segments.some((s) => s.type === 'code');
    if (!hasCode) {
        return [{ type: 'list-item', prefix: '', content: item.raw }];
    }
    return segments;
}
function extractText(token) {
    // Prefer raw to preserve newlines and markdown markers.
    if (typeof token.raw === 'string') {
        return token.raw;
    }
    if (token.type === 'text') {
        return token.text;
    }
    return '';
}
function normalizeListItemText({ text, isTaskItem, }) {
    const withoutIndent = text.replace(/^\s+/, '');
    if (!isTaskItem) {
        return withoutIndent;
    }
    return withoutIndent.replace(/^\[(?: |x|X)\]\s+/, '');
}
function renderSegments(segments) {
    const result = [];
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const prev = segments[i - 1];
        if (segment.type === 'code') {
            // Add newline before code if previous was a list item
            if (prev && prev.type === 'list-item') {
                result.push('\n');
            }
            result.push(segment.content);
        }
        else {
            // list-item
            if (segment.prefix) {
                result.push(segment.prefix + segment.content + '\n');
            }
            else {
                // Raw content (no prefix means it's original raw)
                // Ensure raw ends with newline for proper separation from next segment
                const raw = segment.content.trimEnd();
                result.push(raw + '\n');
            }
        }
    }
    return result.join('').trimEnd();
}
