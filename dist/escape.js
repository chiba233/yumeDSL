import { getSyntax } from "./syntax.js";
export const readEscapedSequence = (text, i) => {
    const { escapeChar, escapableTokens } = getSyntax();
    if (!text.startsWith(escapeChar, i)) {
        return [null, i];
    }
    const start = i + escapeChar.length;
    for (const token of escapableTokens) {
        if (text.startsWith(token, start)) {
            return [token, start + token.length];
        }
    }
    return [null, i];
};
export const readEscaped = (text, i) => {
    const [escaped, next] = readEscapedSequence(text, i);
    if (escaped !== null) {
        return [escaped, next];
    }
    return [text.slice(i, i + 1), i + 1];
};
export const unescapeInline = (str) => {
    let result = "";
    let i = 0;
    while (i < str.length) {
        const [chunk, next] = readEscaped(str, i);
        result += chunk;
        i = next;
    }
    return result;
};
//# sourceMappingURL=escape.js.map