// HTML fragment parser for Discord-renderable components.
// Supports a small reusable subset today (text + button) so tables and other
// CV2 renderers can map inline HTML into Discord UI elements.
import { DomHandler, ElementType, Parser } from 'htmlparser2';
export function parseInlineHtmlRenderables({ html, }) {
    let parseError;
    let domNodes = [];
    const handler = new DomHandler((error, dom) => {
        if (error) {
            parseError = new Error('Failed to parse HTML fragment', {
                cause: error,
            });
            return;
        }
        domNodes = dom;
    }, {
        withStartIndices: false,
        withEndIndices: false,
    });
    const parser = new Parser(handler, {
        xmlMode: false,
        decodeEntities: false,
        recognizeSelfClosing: true,
    });
    parser.write(html);
    parser.end();
    if (parseError) {
        return parseError;
    }
    return parseRenderableNodes({ nodes: domNodes });
}
function parseRenderableNodes({ nodes, }) {
    const renderables = [];
    for (const node of nodes) {
        if (node.type === ElementType.Text) {
            const textNode = node;
            renderables.push({
                type: 'text',
                text: textNode.data,
            });
            continue;
        }
        if (node.type === ElementType.Tag) {
            const element = node;
            if (element.name !== 'button') {
                return new Error(`Unsupported HTML tag: <${element.name}>`);
            }
            const buttonRenderable = parseButtonElement({ element });
            if (buttonRenderable instanceof Error)
                return buttonRenderable;
            renderables.push(buttonRenderable);
            continue;
        }
        if (node.type === ElementType.Comment) {
            continue;
        }
        return new Error(`Unsupported HTML node type: ${node.type}`);
    }
    return renderables;
}
function parseButtonElement({ element, }) {
    const id = element.attribs.id?.trim();
    if (!id) {
        return new Error('<button> is missing required id attribute');
    }
    const label = extractNodeText({ nodes: element.children })
        .replace(/\s+/g, ' ')
        .trim();
    if (!label) {
        return new Error(`<button id="${id}"> is missing label text`);
    }
    const variant = normalizeButtonVariant({
        value: element.attribs.variant,
    });
    if (variant instanceof Error)
        return variant;
    return {
        type: 'button',
        id,
        label,
        variant,
        disabled: 'disabled' in element.attribs,
    };
}
function normalizeButtonVariant({ value, }) {
    if (!value) {
        return 'secondary';
    }
    if (value === 'secondary') {
        return value;
    }
    if (value === 'primary') {
        return value;
    }
    if (value === 'success') {
        return value;
    }
    if (value === 'danger') {
        return value;
    }
    return new Error(`Unsupported <button> variant: ${value}`);
}
function extractNodeText({ nodes, }) {
    const parts = [];
    for (const node of nodes) {
        if (node.type === ElementType.Text) {
            parts.push((node).data);
            continue;
        }
        if (node.type === ElementType.Tag) {
            parts.push(extractNodeText({ nodes: (node).children }));
        }
    }
    return parts.join('');
}
