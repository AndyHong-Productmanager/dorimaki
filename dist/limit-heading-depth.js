// Limit heading depth for Discord.
// Discord only supports headings up to ### (h3), so this converts
// ####, #####, etc. to ### to maintain consistent rendering.
import { Lexer } from 'marked';
export function limitHeadingDepth(markdown, maxDepth = 3) {
    const lexer = new Lexer();
    const tokens = lexer.lex(markdown);
    let result = '';
    for (const token of tokens) {
        if (token.type === 'heading') {
            const heading = token;
            if (heading.depth > maxDepth) {
                const hashes = '#'.repeat(maxDepth);
                result += hashes + ' ' + heading.text + '\n';
            }
            else {
                result += token.raw;
            }
        }
        else {
            result += token.raw;
        }
    }
    return result;
}
