// OpenCode message part formatting for Discord.
// Converts SDK message parts (text, tools, reasoning) to Discord-friendly format,
// handles file attachments, and provides tool summary generation.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, LogPrefix } from './logger.js';
import { FetchError, FilesystemOperationError } from './errors.js';
import { processImage } from './image-utils.js';
import { parsePatchFileCounts } from './patch-text-parser.js';
import { getDataDir } from './config.js';
const logger = createLogger(LogPrefix.FORMATTING);
export const TOOL_PREFIX = '┣ ';
export const FILE_EDIT_PREFIX = '◼︎ ';
export const THINKING_PREFIX = '┣ ';
// Discord subtext. Not `#-`.
export const SUBTEXT_PREFIX = '-# ';
// Same width as ┣. Only used for tool-related status lines; other bot status lines have no glyph.
export const STATUS_PREFIX = '⬦ ';
export const QUEUE_PREFIX = '» ';
export const WORKTREE_PREFIX = '⬦ ';
export function asSubtext(text) {
    const lead = text.startsWith('\n') ? '\n' : '';
    const body = lead ? text.slice(1) : text;
    return lead + body.split('\n').map((line) => {
        if (!line.trim())
            return line;
        if (line.startsWith('-#'))
            return line;
        return `${SUBTEXT_PREFIX}${line}`;
    }).join('\n');
}
/**
 * Serialize Discord embeds into plain text so the AI model can read them.
 * Each embed becomes an <embed> XML block with title, author, description,
 * fields, footer, and URL when present.
 */
export function serializeEmbeds(embeds) {
    if (embeds.length === 0)
        return '';
    const parts = [];
    for (const embed of embeds) {
        const lines = [];
        if (embed.author?.name) {
            lines.push(`Author: ${embed.author.name}`);
        }
        if (embed.title) {
            lines.push(`Title: ${embed.title}`);
        }
        if (embed.url) {
            lines.push(`URL: ${embed.url}`);
        }
        if (embed.description) {
            lines.push(embed.description);
        }
        for (const field of embed.fields) {
            lines.push(`${field.name}: ${field.value}`);
        }
        if (embed.footer?.text) {
            lines.push(`Footer: ${embed.footer.text}`);
        }
        if (lines.length > 0) {
            parts.push(`<embed>\n${lines.join('\n')}\n</embed>`);
        }
    }
    return parts.join('\n\n');
}
/**
 * Serialize a Discord poll into plain text so the AI model can read the
 * question and answer options.
 */
export function serializePoll(poll) {
    if (!poll)
        return '';
    const lines = [];
    if (poll.question.text) {
        lines.push(`Question: ${poll.question.text}`);
    }
    for (const [, answer] of poll.answers) {
        if (answer.text) {
            lines.push(`- ${answer.text}`);
        }
    }
    if (lines.length === 0)
        return '';
    return `<poll>\n${lines.join('\n')}\n</poll>`;
}
/**
 * Serialize forwarded message snapshots into plain text. Each snapshot is a
 * partial Message with content and embeds.
 */
export function serializeMessageSnapshots(snapshots) {
    if (snapshots.size === 0)
        return '';
    const parts = [];
    for (const [, snapshot] of snapshots) {
        const lines = [];
        if (snapshot.content) {
            lines.push(snapshot.content);
        }
        if (snapshot.embeds.length > 0) {
            const embedText = serializeEmbeds(snapshot.embeds);
            if (embedText)
                lines.push(embedText);
        }
        if (lines.length > 0) {
            parts.push(`<forwarded-message>\n${lines.join('\n\n')}\n</forwarded-message>`);
        }
    }
    return parts.join('\n\n');
}
/**
 * Resolves Discord mentions in message content to human-readable names.
 * Replaces <@userId> with @displayName, <@&roleId> with @roleName, <#channelId> with #channelName.
 * Appends serialized embeds, polls, and forwarded message snapshots so the AI
 * model can see all user-visible content.
 */
export function resolveMentions(message) {
    const content = resolveContentMentions(message);
    const extras = serializeMessageExtras(message);
    if (!extras)
        return content;
    return content ? `${content}\n\n${extras}` : extras;
}
/** Message content with mentions resolved, without embeds, polls or forwards. */
export function resolveContentMentions(message) {
    let content = message.content || '';
    // Replace user mentions <@userId> or <@!userId> with @displayName
    for (const [userId, user] of message.mentions.users) {
        const member = message.guild?.members.cache.get(userId);
        const displayName = member?.displayName || user.displayName || user.username;
        content = content.replace(new RegExp(`<@!?${userId}>`, 'g'), `@${displayName}`);
    }
    // Replace role mentions <@&roleId> with @roleName
    for (const [roleId, role] of message.mentions.roles) {
        content = content.replace(new RegExp(`<@&${roleId}>`, 'g'), `@${role.name}`);
    }
    // Replace channel mentions <#channelId> with #channelName
    for (const [channelId, channel] of message.mentions.channels) {
        const name = 'name' in channel ? channel.name : channelId;
        content = content.replace(new RegExp(`<#${channelId}>`, 'g'), `#${name}`);
    }
    return content;
}
// Matches explicit queue markers at the end of a message (case-insensitive).
// Supported forms:
// - punctuation + queue: ". queue", "! queue", ". queue.", "!queue."
// - queue as its own final line: "text\nqueue" or just "queue"
// When present the suffix is stripped and the message is routed through
// dorimaki's local queue (same as /queue command).
const QUEUE_SUFFIX_RE = /(?:[.!?,;:]|^)\s*queue\.?\s*$|\n\s*queue\.?\s*$/i;
/**
 * Only for code that builds or reads raw prompt text. Discord message ingress
 * must go through `resolveMessagePrompt()` in message-preprocessing.ts.
 */
export function extractQueueSuffix(prompt) {
    if (!QUEUE_SUFFIX_RE.test(prompt)) {
        return { prompt, forceQueue: false };
    }
    return { prompt: prompt.replace(QUEUE_SUFFIX_RE, '').trimEnd(), forceQueue: true };
}
/** Non-text message content (embeds, poll, forwards) serialized for the model. */
export function serializeMessageExtras(message) {
    return [
        serializeEmbeds(message.embeds),
        serializePoll(message.poll),
        serializeMessageSnapshots(message.messageSnapshots),
    ]
        .filter(Boolean)
        .join('\n\n');
}
/**
 * Escapes Discord inline markdown characters so dynamic content
 * doesn't break formatting when wrapped in *, _, **, etc.
 */
function escapeInlineMarkdown(text) {
    return text.replace(/([*_~|`\\])/g, '\\$1');
}
// parsePatchCounts → imported from patch-text-parser.ts as parsePatchFileCounts
/**
 * Normalize whitespace: convert newlines to spaces and collapse consecutive spaces.
 */
function normalizeWhitespace(text) {
    return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
}
export function sessionPartKind(part) {
    return part.type === 'text' ? 'text' : 'tool';
}
export function shouldLeadWithBlankLine({ previousKind, nextKind, }) {
    if (!previousKind)
        return false;
    return previousKind !== nextKind;
}
export function sessionPartContent({ content, leadWithBlankLine, }) {
    if (!leadWithBlankLine)
        return content;
    return `\n${content}`;
}
export function asDiscordQuote(text) {
    const lead = text.startsWith('\n') ? '\n' : '';
    const body = lead ? text.slice(1) : text;
    return lead + body.split('\n').map((line) => {
        if (line.startsWith('>'))
            return line;
        return `> ${line}`;
    }).join('\n');
}
// Leave one char for the kind-change blank line in sessionPartContent.
const DISCORD_MESSAGE_MAX_LENGTH = 2000;
export function quotedTextFitsOneDiscordMessage(text) {
    return asDiscordQuote(text).length < DISCORD_MESSAGE_MAX_LENGTH;
}
function isNonEmptyTextPart(part) {
    return part.type === 'text' && Boolean(part.text?.trim());
}
function isRenderableTurnPart(part) {
    return isNonEmptyTextPart(part) || part.type === 'tool';
}
function nextToolNameAfter({ parts, fromIndex, }) {
    for (const part of parts.slice(fromIndex + 1)) {
        if (isNonEmptyTextPart(part))
            return undefined;
        if (part.type === 'tool' && part.tool)
            return part.tool;
    }
}
export function shouldQuoteIntermediateTextPart({ part, isLastInTurn, nextToolName, }) {
    if (!isNonEmptyTextPart(part) || isLastInTurn)
        return false;
    const text = part.text ?? '';
    if (text.includes('<callout'))
        return false;
    if (text.trim().includes('\n'))
        return false;
    if (!quotedTextFitsOneDiscordMessage(text))
        return false;
    if (nextToolName === 'question'
        || nextToolName?.endsWith('dorimaki_sleep')
        || nextToolName?.endsWith('dorimaki_action_buttons')) {
        return false;
    }
    return true;
}
export function planAssistantTurnFlush({ parts, mode, throughPartId, }) {
    const throughIndex = throughPartId
        ? parts.findIndex((part) => part.id === throughPartId)
        : -1;
    const sendUntil = (() => {
        if (mode === 'interactive' && throughIndex >= 0)
            return throughIndex + 1;
        return parts.length;
    })();
    const sendParts = [];
    const holdParts = [];
    for (const [index, part] of parts.entries()) {
        // Live tools must not wait for the current text part to end.
        if (mode === 'progress' && part.type === 'text' && !part.time?.end) {
            holdParts.push(part);
            continue;
        }
        if (index < sendUntil) {
            sendParts.push({
                part,
                quoteText: shouldQuoteIntermediateTextPart({
                    part,
                    isLastInTurn: mode !== 'progress'
                        && parts.filter(isRenderableTurnPart).at(-1)?.id === part.id,
                    nextToolName: nextToolNameAfter({ parts, fromIndex: index }),
                }),
            });
            continue;
        }
        holdParts.push(part);
    }
    return {
        send: sendParts.map((entry) => ({ id: entry.part.id, quoteText: entry.quoteText })),
        hold: holdParts.map((part) => ({ id: part.id, quoteText: false })),
        sendParts,
    };
}
/**
 * Collect renderable assistant parts from session messages as SessionChunks.
 * Each non-empty formatted part becomes one chunk. Caller can batch them
 * with batchChunksForDiscord() before sending.
 *
 * - skipPartIds: parts already synced (external sync). Skipped parts are
 *   not included in the result.
 * - limit: max parts to include (from the end). Older parts are counted
 *   in skippedCount.
 */
export function collectSessionChunks({ messages, skipPartIds, limit, }) {
    const allChunks = [];
    for (const message of messages) {
        if (message.info.role !== 'assistant') {
            continue;
        }
        for (const part of message.parts) {
            if (skipPartIds?.has(part.id)) {
                continue;
            }
            const content = formatPart(part);
            if (!content.trim()) {
                continue;
            }
            const quote = shouldQuoteIntermediateTextPart({
                part,
                isLastInTurn: false,
                nextToolName: nextToolNameAfter({
                    parts: message.parts,
                    fromIndex: message.parts.indexOf(part),
                }),
            });
            allChunks.push({
                partIds: [part.id],
                content: (quote ? asDiscordQuote(content) : content).trimEnd(),
                kind: sessionPartKind(part),
            });
        }
    }
    if (limit !== undefined && allChunks.length > limit) {
        return {
            chunks: allChunks.slice(-limit),
            skippedCount: allChunks.length - limit,
        };
    }
    return { chunks: allChunks, skippedCount: 0 };
}
// Merge consecutive SessionChunks into as few Discord messages as possible,
// respecting the 2000 char limit.
const DISCORD_BATCH_MAX_LENGTH = 2000;
export function batchChunksForDiscord(chunks) {
    if (chunks.length === 0) {
        return [];
    }
    const batched = [];
    let current = {
        partIds: [...chunks[0].partIds],
        content: chunks[0].content,
        kind: chunks[0].kind,
    };
    for (let i = 1; i < chunks.length; i++) {
        const next = chunks[i];
        if (next.kind !== current.kind) {
            batched.push(current);
            current = {
                partIds: [...next.partIds],
                content: next.content,
                kind: next.kind,
            };
            continue;
        }
        const merged = current.content + '\n' + next.content;
        if (merged.length <= DISCORD_BATCH_MAX_LENGTH) {
            current = {
                partIds: [...current.partIds, ...next.partIds],
                content: merged,
                kind: current.kind,
            };
        }
        else {
            batched.push(current);
            current = {
                partIds: [...next.partIds],
                content: next.content,
                kind: next.kind,
            };
        }
    }
    batched.push(current);
    return batched;
}
export const TEXT_MIME_TYPES = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/toml',
];
export function isTextMimeType(contentType) {
    if (!contentType) {
        return false;
    }
    return TEXT_MIME_TYPES.some((prefix) => contentType.startsWith(prefix));
}
// Small Discord "send as file" prompts stay inlined. Bigger dumps only get a URL.
export const TEXT_ATTACHMENT_INLINE_LIMIT_BYTES = 64 * 1024;
const DORIMAKI_SEND_PROMPT_ATTACHMENT_NAME = 'prompt.md';
function formatAttachmentSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024) {
        const kb = bytes / 1024;
        return `${kb < 10 ? kb.toFixed(1) : kb.toFixed(0)} KB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
}
function shouldInlineTextAttachment(attachment) {
    if (attachment.name === DORIMAKI_SEND_PROMPT_ATTACHMENT_NAME)
        return true;
    return attachment.size <= TEXT_ATTACHMENT_INLINE_LIMIT_BYTES;
}
function textAttachmentAttrs(attachment, extra = []) {
    return [
        `filename="${attachment.name}"`,
        `mime="${attachment.contentType}"`,
        `size="${attachment.size}"`,
        `url="${attachment.url}"`,
        ...extra,
    ].join(' ');
}
function safeAttachmentBasename(name) {
    const sanitized = path.basename(name).replace(/\0/g, '');
    if (!sanitized || sanitized === '.' || sanitized === '..')
        return 'attachment';
    return sanitized;
}
function localAttachmentPath(attachment) {
    const id = attachment.id || attachment.url.slice(-12).replace(/[^a-zA-Z0-9]/g, '');
    return path.join(getDataDir(), 'attachments', `${id}-${safeAttachmentBasename(attachment.name)}`);
}
export async function getTextAttachments(message) {
    const textAttachments = Array.from(message.attachments.values()).filter((attachment) => isTextMimeType(attachment.contentType));
    if (textAttachments.length === 0) {
        return '';
    }
    const attachmentsDir = path.join(getDataDir(), 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const textContents = await Promise.all(textAttachments.map(async (attachment) => {
        const response = await fetch(attachment.url)
            .catch((e) => new FetchError({ url: attachment.url, cause: e }));
        if (response instanceof Error) {
            return `<attachment ${textAttachmentAttrs(attachment)} error="${response.message}" />`;
        }
        if (!response.ok) {
            return `<attachment ${textAttachmentAttrs(attachment)} error="Failed to fetch: ${response.status}" />`;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const savedPath = localAttachmentPath(attachment);
        const written = await fs.promises
            .writeFile(savedPath, buffer)
            .catch((e) => new FilesystemOperationError({ operation: 'write attachment', cause: e }));
        if (written instanceof Error) {
            logger.error(`Failed to save attachment ${attachment.name}:`, written.message);
        }
        const pathAttr = written instanceof Error ? [] : [`path="${savedPath}"`];
        if (!shouldInlineTextAttachment(attachment)) {
            const sizeLabel = formatAttachmentSize(attachment.size);
            return [
                `<attachment ${textAttachmentAttrs(attachment, [...pathAttr, 'large="true"'])}>`,
                `This file is large (${sizeLabel}, ${attachment.contentType || 'unknown type'}). Contents were not inlined to save context. Read the local path.`,
                `</attachment>`,
            ].join('\n');
        }
        return `<attachment ${textAttachmentAttrs(attachment, pathAttr)}>\n${buffer.toString('utf8')}\n</attachment>`;
    }));
    return textContents.join('\n\n');
}
export async function getFileAttachments(message) {
    const fileAttachments = Array.from(message.attachments.values()).filter((attachment) => {
        const contentType = attachment.contentType || '';
        return (contentType.startsWith('image/') || contentType === 'application/pdf');
    });
    if (fileAttachments.length === 0) {
        return [];
    }
    const results = await Promise.all(fileAttachments.map(async (attachment) => {
        const response = await fetch(attachment.url)
            .catch((e) => new FetchError({ url: attachment.url, cause: e }));
        if (response instanceof Error) {
            logger.error(`Error downloading attachment ${attachment.name}:`, response.message);
            return null;
        }
        if (!response.ok) {
            logger.error(`Failed to fetch attachment ${attachment.name}: ${response.status}`);
            return null;
        }
        const rawBuffer = Buffer.from(await response.arrayBuffer());
        const originalMime = attachment.contentType || 'application/octet-stream';
        // Process image (resize if needed, convert to JPEG)
        const { buffer, mime } = await processImage(rawBuffer, originalMime);
        const base64 = buffer.toString('base64');
        const dataUrl = `data:${mime};base64,${base64}`;
        logger.log(`Attachment ${attachment.name}: ${rawBuffer.length} → ${buffer.length} bytes, ${mime}`);
        return {
            type: 'file',
            mime,
            filename: attachment.name,
            url: dataUrl,
            sourceUrl: attachment.url,
        };
    }));
    return results.filter((r) => r !== null);
}
const MAX_BASH_COMMAND_INLINE_LENGTH = 50;
export function formatBashToolTitle({ command, description, summary, stateTitle, }) {
    const label = description || summary;
    if (!command && !label && !stateTitle)
        return '';
    const isSingleLine = !command.includes('\n');
    const firstMeaningfulLine = command
        .split('\n')
        .find((line) => line.trim().length > 0)
        ?.trimStart() ?? '';
    if (command && isSingleLine && command.length <= MAX_BASH_COMMAND_INLINE_LENGTH) {
        return ` _${escapeInlineMarkdown(command)}_`;
    }
    if (label) {
        return ` _${escapeInlineMarkdown(label)}_`;
    }
    if (firstMeaningfulLine.length > 0) {
        const needsTruncation = firstMeaningfulLine.length > MAX_BASH_COMMAND_INLINE_LENGTH;
        const base = needsTruncation
            ? firstMeaningfulLine.slice(0, MAX_BASH_COMMAND_INLINE_LENGTH)
            : firstMeaningfulLine;
        // Always add ellipsis when showing a partial command (multiline or length-truncated)
        return ` _${escapeInlineMarkdown(base)}…_`;
    }
    if (stateTitle) {
        return ` _${escapeInlineMarkdown(stateTitle)}_`;
    }
    return '';
}
export function getToolSummaryText(part) {
    if (part.type !== 'tool')
        return '';
    if (part.tool === 'edit') {
        const filePath = part.state.input?.filePath || '';
        const newString = part.state.input?.newString || '';
        const oldString = part.state.input?.oldString || '';
        const added = newString.split('\n').length;
        const removed = oldString.split('\n').length;
        const fileName = filePath.split('/').pop() || '';
        return fileName
            ? `*${escapeInlineMarkdown(fileName)}* (+${added}-${removed})`
            : `(+${added}-${removed})`;
    }
    if (part.tool === 'apply_patch') {
        // Only inputs are available when parts are sent during streaming (output/metadata not yet populated)
        const patchText = part.state.input?.patchText || '';
        if (!patchText) {
            return '';
        }
        const patchCounts = parsePatchFileCounts(patchText);
        return [...patchCounts.entries()]
            .map(([filePath, { additions, deletions }]) => {
            const fileName = filePath.split('/').pop() || '';
            return fileName
                ? `*${escapeInlineMarkdown(fileName)}* (+${additions}-${deletions})`
                : `(+${additions}-${deletions})`;
        })
            .join(', ');
    }
    if (part.tool === 'write') {
        const filePath = part.state.input?.filePath || '';
        const content = part.state.input?.content || '';
        const lines = content.split('\n').length;
        const fileName = filePath.split('/').pop() || '';
        return fileName
            ? `*${escapeInlineMarkdown(fileName)}* (${lines} line${lines === 1 ? '' : 's'})`
            : `(${lines} line${lines === 1 ? '' : 's'})`;
    }
    if (part.tool === 'webfetch') {
        const url = part.state.input?.url || '';
        const urlWithoutProtocol = url.replace(/^https?:\/\//, '');
        return urlWithoutProtocol
            ? `*${escapeInlineMarkdown(urlWithoutProtocol)}*`
            : '';
    }
    if (part.tool === 'read') {
        const filePath = part.state.input?.filePath || '';
        const fileName = filePath.split('/').pop() || '';
        return fileName ? `*${escapeInlineMarkdown(fileName)}*` : '';
    }
    if (part.tool === 'list') {
        const path = part.state.input?.path || '';
        const dirName = path.split('/').pop() || path;
        return dirName ? `*${escapeInlineMarkdown(dirName)}*` : '';
    }
    if (part.tool === 'glob') {
        const pattern = part.state.input?.pattern || '';
        return pattern ? `*${escapeInlineMarkdown(pattern)}*` : '';
    }
    if (part.tool === 'grep') {
        const pattern = part.state.input?.pattern || '';
        return pattern ? `*${escapeInlineMarkdown(pattern)}*` : '';
    }
    if (part.tool === 'bash' ||
        part.tool === 'todoread' ||
        part.tool === 'todowrite') {
        return '';
    }
    // Task tool display is handled via subtask part in session-handler (shows name + agent)
    if (part.tool === 'task') {
        return '';
    }
    if (part.tool === 'skill') {
        const name = part.state.input?.name || '';
        return name ? `_${escapeInlineMarkdown(name)}_` : '';
    }
    // File upload tool - show the prompt
    if (part.tool.endsWith('dorimaki_file_upload')) {
        const prompt = part.state.input?.prompt || '';
        return prompt ? `*${escapeInlineMarkdown(prompt.slice(0, 60))}*` : '';
    }
    // LESSON: tool parts are sent to Discord at `running` status (see
    // shouldSendPart in thread-session-runtime), so `state.title` from the tool
    // result is never rendered here. Everything shown must come from state.input.
    // `until` is already absolute; `duration` is relative, so say "for 2h" —
    // never "until 2h".
    if (part.tool.endsWith('dorimaki_sleep')) {
        const until = part.state.input?.until || '';
        const duration = part.state.input?.duration || '';
        const reason = part.state.input?.reason || '';
        const when = until ? `until ${until}` : duration ? `for ${duration}` : '';
        const reasonText = reason ? `_${escapeInlineMarkdown(reason)}_` : '';
        return [when && escapeInlineMarkdown(when), reasonText]
            .filter(Boolean)
            .join(' ');
    }
    if (!part.state.input)
        return '';
    const inputFields = Object.entries(part.state.input)
        .map(([key, value]) => {
        if (value === null || value === undefined)
            return null;
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        const normalized = normalizeWhitespace(stringValue);
        const truncatedValue = normalized.length > 50 ? normalized.slice(0, 50) + '…' : normalized;
        return `${key}: ${truncatedValue}`;
    })
        .filter(Boolean);
    if (inputFields.length === 0)
        return '';
    return `(${inputFields.join(', ')})`;
}
export function formatTodoList(part) {
    if (part.type !== 'tool' || part.tool !== 'todowrite')
        return '';
    const todos = part.state.input?.todos || [];
    const activeIndex = todos.findIndex((todo) => {
        return todo.status === 'in_progress';
    });
    const activeTodo = todos[activeIndex];
    if (activeIndex === -1 || !activeTodo)
        return '';
    const todoNumber = activeIndex + 1;
    const content = activeTodo.content.charAt(0).toLowerCase() + activeTodo.content.slice(1);
    return `${todoNumber}.  **${escapeInlineMarkdown(content)}**`;
}
export function formatTaskToolTitle(part) {
    // Running only. The child session can be created later when many tasks queue.
    if (part.tool !== 'task' || part.state.status !== 'running')
        return '';
    const description = part.state.input?.description;
    const stateTitle = part.state.title;
    const title = typeof description === 'string' && description
        ? description
        : typeof stateTitle === 'string'
            ? stateTitle
            : '';
    if (!title)
        return '';
    const subagentType = part.state.input?.subagent_type;
    const agent = typeof subagentType === 'string' ? subagentType : 'task';
    return asSubtext(`${TOOL_PREFIX}${escapeInlineMarkdown(agent)} **${escapeInlineMarkdown(title)}**`);
}
// Non-text parts (tools, thinking, files) render as Discord subtext so they look dimmer than text.
export function formatPart(part, prefix) {
    const formatted = formatPartBody(part, prefix);
    if (!formatted || part.type === 'text')
        return formatted;
    return asSubtext(formatted);
}
function formatPartBody(part, prefix) {
    const pfx = prefix ? `${prefix} ⋅ ` : '';
    if (part.type === 'text') {
        if (part.synthetic === true)
            return '';
        const text = part.text?.trim();
        if (!text)
            return '';
        if (prefix) {
            return `${pfx}${text}`;
        }
        return text;
    }
    if (part.type === 'reasoning') {
        if (!part.text?.trim())
            return '';
        return `${THINKING_PREFIX}${pfx}thinking`;
    }
    if (part.type === 'file') {
        return prefix
            ? `📄 ${pfx}${part.filename || 'File'}`
            : `📄 ${part.filename || 'File'}`;
    }
    if (part.type === 'step-start' ||
        part.type === 'step-finish' ||
        part.type === 'patch' ||
        part.type === 'compaction') {
        return '';
    }
    if (part.type === 'agent') {
        return `${TOOL_PREFIX}${pfx}agent ${part.id}`;
    }
    if (part.type === 'snapshot') {
        return `${TOOL_PREFIX}${pfx}snapshot ${part.snapshot}`;
    }
    if (part.type === 'tool') {
        if (part.tool === 'todowrite') {
            const formatted = formatTodoList(part);
            return prefix && formatted ? `${TOOL_PREFIX}${pfx}${formatted}` : formatted;
        }
        // Question tool is handled via Discord dropdowns, not text
        if (part.tool === 'question') {
            return '';
        }
        // File upload tool is handled via Discord button + modal, not text
        if (part.tool.endsWith('dorimaki_file_upload')) {
            return '';
        }
        // Action buttons tool is handled via Discord buttons, not text
        if (part.tool.endsWith('dorimaki_action_buttons')) {
            return '';
        }
        // Task tool display is handled in session-handler with proper label
        if (part.tool === 'task') {
            return '';
        }
        if (part.state.status === 'pending') {
            if (part.tool !== 'bash') {
                return '';
            }
            const command = part.state.input?.command || '';
            const description = part.state.input?.description || '';
            const summary = part.state.input?.summary || '';
            const toolTitle = formatBashToolTitle({
                command,
                description,
                summary,
            });
            return `${TOOL_PREFIX}${pfx}bash${toolTitle}`;
        }
        const summaryText = getToolSummaryText(part);
        const stateTitle = 'title' in part.state ? part.state.title : undefined;
        let toolTitle = '';
        if (part.state.status === 'error') {
            toolTitle = part.state.error || 'error';
        }
        else if (part.tool === 'bash') {
            const command = part.state.input?.command || '';
            const description = part.state.input?.description || '';
            const summary = part.state.input?.summary || '';
            const formatted = formatBashToolTitle({
                command,
                description,
                summary,
                stateTitle,
            });
            toolTitle = formatted.startsWith(' ') ? formatted.slice(1) : formatted;
        }
        else if (stateTitle) {
            toolTitle = `_${escapeInlineMarkdown(stateTitle)}_`;
        }
        const icon = (() => {
            if (part.state.status === 'error') {
                return '⨯';
            }
            if (part.tool === 'edit' ||
                part.tool === 'write' ||
                part.tool === 'apply_patch') {
                return FILE_EDIT_PREFIX;
            }
            return TOOL_PREFIX;
        })();
        const toolParts = [part.tool, toolTitle, summaryText]
            .filter(Boolean)
            .join(' ');
        if (icon === '⨯') {
            return `${icon} ${pfx}${toolParts}`;
        }
        return `${icon}${pfx}${toolParts}`;
    }
    logger.warn('Unknown part type:', part);
    return '';
}
