import { readEscapedSequence, unescapeInline } from "./escape.js";
import { getSyntax } from "./syntax.js";
import { createToken } from "./createToken.js";
const createTextToken = (value) => createToken({ type: "text", value });
export const extractText = (tokens) => {
    if (!tokens?.length)
        return "";
    return tokens.map((t) => (typeof t.value === "string" ? t.value : extractText(t.value))).join("");
};
export const materializeTextTokens = (tokens) => {
    return tokens.map((token) => {
        if (typeof token.value === "string") {
            return token.type === "text" ? { ...token, value: unescapeInline(token.value) } : token;
        }
        return {
            ...token,
            value: materializeTextTokens(token.value),
        };
    });
};
export const splitTokensByPipe = (tokens) => {
    const { escapeChar, tagDivider } = getSyntax();
    const parts = [[]];
    for (const token of tokens) {
        if (token.type !== "text" || typeof token.value !== "string") {
            parts[parts.length - 1].push(token);
            continue;
        }
        let buffer = "";
        let i = 0;
        const val = token.value;
        const flushText = () => {
            if (buffer) {
                parts[parts.length - 1].push(createTextToken(buffer));
                buffer = "";
            }
        };
        while (i < val.length) {
            const [escaped, next] = readEscapedSequence(val, i);
            if (escaped !== null) {
                buffer += escapeChar + escaped;
                i = next;
                continue;
            }
            if (val[i] === tagDivider) {
                flushText();
                parts.push([]);
                i++;
                while (i < val.length && val[i] === " ")
                    i++;
                continue;
            }
            buffer += val[i];
            i++;
        }
        flushText();
    }
    return parts;
};
export const parsePipeArgs = (tokens) => {
    const parts = splitTokensByPipe(tokens);
    return {
        parts,
        text: (index) => unescapeInline(extractText(parts[index] ?? [])).trim(),
        materializedTokens: (index) => materializeTextTokens(parts[index] ?? []),
        materializedTailTokens: (startIndex) => materializeTextTokens(parts.slice(startIndex).flat()),
    };
};
export const parsePipeTextArgs = (text) => parsePipeArgs([createTextToken(text)]);
//# sourceMappingURL=builders.js.map