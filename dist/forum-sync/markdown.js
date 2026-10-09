// Markdown parsing, serialization, and section formatting for forum sync.
// Handles frontmatter extraction, message section building, and
// conversion between Discord messages and markdown format.
import YAML from 'yaml';
import * as errore from 'errore';
import { ForumFrontmatterParseError, } from './types.js';
export function toStringArray({ value }) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string');
}
export function getStringValue({ value }) {
    if (typeof value !== 'string')
        return '';
    return value;
}
export function parseFrontmatter({ markdown, }) {
    if (!markdown.startsWith('---\n')) {
        return { frontmatter: {}, body: markdown.trim() };
    }
    const end = markdown.indexOf('\n---\n', 4);
    if (end === -1) {
        return { frontmatter: {}, body: markdown.trim() };
    }
    const rawFrontmatter = markdown.slice(4, end);
    const body = markdown.slice(end + 5).trim();
    const parsed = errore.try(() => YAML.parse(rawFrontmatter), (cause) => new ForumFrontmatterParseError({ reason: 'yaml parse failed', cause }));
    if (parsed instanceof Error || !parsed || typeof parsed !== 'object') {
        return { frontmatter: {}, body };
    }
    return { frontmatter: parsed, body };
}
export function stringifyFrontmatter({ frontmatter, body, }) {
    const yamlText = YAML.stringify(frontmatter, null, {
        lineWidth: 120,
    }).trim();
    return `---\n${yamlText}\n---\n\n${body.trim()}\n`;
}
export function splitSections({ body }) {
    return body
        .split(/\r?\n---\r?\n/g)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}
export function extractStarterContent({ body }) {
    const sections = splitSections({ body });
    const firstSection = sections[0] || '';
    const match = firstSection.match(/^\*\*.+?\*\* \(\d+\) - .+?(?: \(edited .+?\))?\r?\n\r?\n([\s\S]*)$/);
    if (!match)
        return body.trim();
    return (match[1] || '').trim();
}
export function buildMessageSections({ messages, }) {
    return messages.map((message) => {
        const attachmentLines = Array.from(message.attachments.values()).map((attachment) => `Attachment: ${attachment.url}`);
        const contentParts = [];
        const trimmedContent = message.content.trim();
        if (trimmedContent) {
            contentParts.push(trimmedContent);
        }
        if (attachmentLines.length > 0) {
            contentParts.push(attachmentLines.join('\n'));
        }
        const content = contentParts.length > 0
            ? contentParts.join('\n\n')
            : '_(no text content)_';
        return {
            messageId: message.id,
            authorName: message.author.username,
            authorId: message.author.id,
            createdAt: new Date(message.createdTimestamp).toISOString(),
            editedAt: message.editedTimestamp
                ? new Date(message.editedTimestamp).toISOString()
                : null,
            content,
        };
    });
}
export function formatMessageSection({ section, }) {
    const editedSuffix = section.editedAt ? ` (edited ${section.editedAt})` : '';
    return `**${section.authorName}** (${section.authorId}) - ${section.createdAt}${editedSuffix}\n\n${section.content}`;
}
// Channel mention footer stored in the Discord starter message so
// projectChannelId survives a full re-sync from Discord (no local files).
// Uses <#id> so Discord renders it as a clickable channel link.
// Matches at start-of-string or after a newline so it works even when the
// footer is the only content in the message (e.g. empty body).
const PROJECT_CHANNEL_FOOTER_RE = /(?:^|\n)channel: <#(\d{17,20})>\s*$/;
const MAX_STARTER_MESSAGE_LENGTH = 2_000;
/** Append a channel mention footer, truncating the body so the total
 *  never exceeds Discord's 2000-char starter message limit. */
export function appendProjectChannelFooter({ content, projectChannelId, }) {
    if (!projectChannelId)
        return content;
    const footer = `\nchannel: <#${projectChannelId}>`;
    const maxContentLength = MAX_STARTER_MESSAGE_LENGTH - footer.length;
    const truncated = content.length > maxContentLength
        ? content.slice(0, maxContentLength)
        : content;
    return `${truncated}${footer}`;
}
export function extractProjectChannelFromContent({ content, }) {
    const match = content.match(PROJECT_CHANNEL_FOOTER_RE);
    if (!match)
        return { cleanContent: content };
    return {
        cleanContent: content.replace(PROJECT_CHANNEL_FOOTER_RE, '').trim(),
        projectChannelId: match[1],
    };
}
