// XML/HTML tag content extractor.
// Parses XML-like tags from strings (e.g., channel topics) to extract
// Dorimaki configuration like directory paths and app IDs.
import { DomHandler, Parser, ElementType } from 'htmlparser2';
import { createLogger, LogPrefix } from './logger.js';
const xmlLogger = createLogger(LogPrefix.XML);
export function extractTagsArrays({ xml, tags, }) {
    const result = {
        others: [],
    };
    // Initialize arrays for each tag
    tags.forEach((tag) => {
        result[tag] = [];
    });
    try {
        const handler = new DomHandler((error, dom) => {
            if (error) {
                xmlLogger.error('Error parsing XML:', error);
            }
            else {
                const findTags = (nodes, path = []) => {
                    nodes.forEach((node) => {
                        if (node.type === ElementType.Tag) {
                            const element = node;
                            const currentPath = [...path, element.name];
                            const pathString = currentPath.join('.');
                            // Extract content using original string positions
                            const extractContent = () => {
                                // Use element's own indices but exclude the tags
                                if (element.startIndex !== null &&
                                    element.endIndex !== null) {
                                    // Extract the full element including tags
                                    const fullElement = xml.substring(element.startIndex, element.endIndex + 1);
                                    // Find where content starts (after opening tag)
                                    const contentStart = fullElement.indexOf('>') + 1;
                                    // Find where content ends (before this element's closing tag)
                                    const closingTag = `</${element.name}>`;
                                    const contentEnd = fullElement.lastIndexOf(closingTag);
                                    if (contentStart > 0 && contentEnd > contentStart) {
                                        return fullElement.substring(contentStart, contentEnd);
                                    }
                                    return '';
                                }
                                return '';
                            };
                            // Check both single tag names and nested paths
                            if (tags.includes(element.name)) {
                                const content = extractContent();
                                result[element.name]?.push(content);
                            }
                            // Check for nested path matches
                            if (tags.includes(pathString)) {
                                const content = extractContent();
                                result[pathString]?.push(content);
                            }
                            if (element.children) {
                                findTags(element.children, currentPath);
                            }
                        }
                        else if (node.type === ElementType.Text &&
                            node.parent?.type === ElementType.Root) {
                            const textNode = node;
                            if (textNode.data.trim()) {
                                // console.log('node.parent',node.parent)
                                result.others?.push(textNode.data.trim());
                            }
                        }
                    });
                };
                findTags(dom);
            }
        }, {
            withStartIndices: true,
            withEndIndices: true,
            xmlMode: true,
        });
        const parser = new Parser(handler, {
            xmlMode: true,
            decodeEntities: false,
        });
        parser.write(xml);
        parser.end();
    }
    catch (error) {
        xmlLogger.error('Unexpected error in extractTags:', error);
    }
    return result;
}
export function extractNonXmlContent(xml) {
    const result = extractTagsArrays({ xml, tags: [] });
    return result.others.join('\n');
}
