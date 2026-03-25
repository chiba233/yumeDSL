import { getLineEnd, isTagChar, isTagStartChar, isWholeLineToken } from "./chars.js";
import { getSyntax } from "./syntax.js";
import { readEscapedSequence } from "./escape.js";
export const findTagArgClose = (text, start) => {
    const { tagOpen, tagClose } = getSyntax();
    let pos = start;
    let depth = 1;
    while (pos < text.length) {
        const [escaped, next] = readEscapedSequence(text, pos);
        if (escaped !== null) {
            pos = next;
            continue;
        }
        if (text[pos] === tagOpen) {
            depth++;
        }
        else if (text[pos] === tagClose) {
            depth--;
            if (depth === 0)
                return pos;
        }
        pos++;
    }
    return -1;
};
const readTagHeadAt = (text, pos) => {
    const { tagPrefix, tagOpen } = getSyntax();
    if (!text.startsWith(tagPrefix, pos))
        return null;
    const tagStart = pos + tagPrefix.length;
    if (tagStart >= text.length || !isTagStartChar(text[tagStart])) {
        return null;
    }
    let tagNameEnd = tagStart + 1;
    while (tagNameEnd < text.length && isTagChar(text[tagNameEnd])) {
        tagNameEnd++;
    }
    if (text[tagNameEnd] !== tagOpen) {
        return null;
    }
    return {
        tag: text.slice(tagStart, tagNameEnd),
        tagStart: pos,
        tagNameEnd,
        argStart: tagNameEnd + tagOpen.length,
    };
};
const scanInlineBoundary = (text, start, returnCloseStart, fallbackToTextEnd) => {
    const { endTag } = getSyntax();
    let pos = start;
    let depth = 1;
    while (pos < text.length) {
        const [escaped, next] = readEscapedSequence(text, pos);
        if (escaped !== null) {
            pos = next;
            continue;
        }
        const head = readTagHeadAt(text, pos);
        if (head) {
            depth++;
            pos = head.argStart;
            continue;
        }
        if (text.startsWith(endTag, pos)) {
            depth--;
            const closeEnd = pos + endTag.length;
            if (depth === 0) {
                return returnCloseStart ? pos : closeEnd;
            }
            pos = closeEnd;
            continue;
        }
        pos++;
    }
    return fallbackToTextEnd ? text.length : -1;
};
export const getTagCloserType = (text, tagOpenIndex) => {
    const { blockOpen, blockClose, rawOpen, rawClose, endTag } = getSyntax();
    const argClose = findTagArgClose(text, tagOpenIndex);
    if (argClose === -1)
        return null;
    if (text.startsWith(blockOpen, argClose)) {
        return { closer: blockClose, argClose };
    }
    if (text.startsWith(rawOpen, argClose)) {
        return { closer: rawClose, argClose };
    }
    return { closer: endTag, argClose };
};
export const findInlineClose = (text, start) => {
    return scanInlineBoundary(text, start, true, false);
};
export const findBlockClose = (text, start) => {
    const { blockClose, rawClose, rawOpen, blockOpen, endTag } = getSyntax();
    let pos = start;
    let depth = 1;
    while (pos < text.length) {
        const [escaped, next] = readEscapedSequence(text, pos);
        if (escaped !== null) {
            pos = next;
            continue;
        }
        if (isWholeLineToken(text, pos, blockClose)) {
            depth--;
            if (depth === 0)
                return pos;
            pos = getLineEnd(text, pos) + 1;
            continue;
        }
        const head = readTagHeadAt(text, pos);
        if (head) {
            const tagInfo = getTagCloserType(text, head.argStart);
            if (tagInfo?.closer === rawClose) {
                const rawStart = tagInfo.argClose + rawOpen.length;
                const rawEnd = findRawClose(text, rawStart);
                if (rawEnd === -1)
                    return -1;
                pos = rawEnd + rawClose.length;
                continue;
            }
            if (tagInfo?.closer === blockClose) {
                depth++;
                pos = tagInfo.argClose + blockOpen.length;
                continue;
            }
            if (tagInfo?.closer === endTag) {
                const inlineEnd = findInlineClose(text, head.argStart);
                if (inlineEnd === -1) {
                    pos = head.argStart;
                    continue;
                }
                pos = inlineEnd + endTag.length;
                continue;
            }
        }
        pos++;
    }
    return -1;
};
export const findRawClose = (text, start) => {
    const { rawClose } = getSyntax();
    let pos = start;
    while (pos < text.length) {
        if (isWholeLineToken(text, pos, rawClose)) {
            return pos;
        }
        const lineEnd = text.indexOf("\n", pos);
        if (lineEnd === -1)
            break;
        pos = lineEnd + 1;
    }
    return -1;
};
export const findMalformedWholeLineTokenCandidate = (text, start, token) => {
    let pos = start;
    while (pos < text.length) {
        const lineEnd = text.indexOf("\n", pos);
        const end = lineEnd === -1 ? text.length : lineEnd;
        const line = text.slice(pos, end);
        const leadingWhitespace = line.length - line.trimStart().length;
        const trimmedStart = line.trimStart();
        if (trimmedStart.startsWith(token) && line !== token) {
            return {
                index: pos + leadingWhitespace,
                length: trimmedStart.length,
            };
        }
        if (lineEnd === -1)
            break;
        pos = lineEnd + 1;
    }
    return null;
};
export const skipDegradedInline = (text, start) => {
    return scanInlineBoundary(text, start, false, true);
};
export const readTagStartInfo = (text, i) => {
    const head = readTagHeadAt(text, i);
    if (!head)
        return null;
    return {
        tag: head.tag,
        tagOpenPos: head.tagStart,
        tagNameEnd: head.tagNameEnd,
        inlineContentStart: head.argStart,
    };
};
//# sourceMappingURL=scanner.js.map