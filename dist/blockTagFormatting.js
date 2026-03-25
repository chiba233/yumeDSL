export const stripSingleLeadingLineBreak = (text) => {
    if (text.startsWith("\r\n"))
        return text.slice(2);
    if (text.startsWith("\n"))
        return text.slice(1);
    return text;
};
export const consumeSingleTrailingLineBreak = (text, index) => {
    if (text.startsWith("\r\n", index))
        return index + 2;
    if (text[index] === "\n")
        return index + 1;
    return index;
};
export const normalizeBlockTagContent = (tag, content, mode, blockTagSet) => {
    if (!blockTagSet.has(tag))
        return content;
    if (mode === "highlight")
        return content;
    return stripSingleLeadingLineBreak(content);
};
export const consumeBlockTagTrailingLineBreak = (tag, text, index, mode, blockTagSet) => {
    if (!blockTagSet.has(tag))
        return index;
    if (mode === "highlight")
        return index;
    return consumeSingleTrailingLineBreak(text, index);
};
//# sourceMappingURL=blockTagFormatting.js.map