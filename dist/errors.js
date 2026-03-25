const ERROR_MESSAGES = {
    DEPTH_LIMIT: "Nesting too deep",
    UNEXPECTED_CLOSE: "Unexpected close tag",
    BLOCK_NOT_CLOSED: "Block tag not closed",
    BLOCK_CLOSE_MALFORMED: "Malformed block close",
    RAW_NOT_CLOSED: "Raw block not closed",
    RAW_CLOSE_MALFORMED: "Malformed raw close",
    INLINE_NOT_CLOSED: "Inline tag not closed",
};
export const getErrorContext = (text, index, length = 1, range = 15) => {
    const lines = text.slice(0, index).split("\n");
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    const start = Math.max(0, index - range);
    const end = Math.min(text.length, index + length + range);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < text.length ? "..." : "";
    const before = text.slice(start, index);
    const content = text.slice(index, index + length);
    const after = text.slice(index + length, end);
    const highlightedSnippet = `${prefix}${before} >>>${content}<<< ${after}${suffix}`;
    return {
        line,
        column,
        snippet: highlightedSnippet.replace(/\n/g, " "),
    };
};
export const emitError = (onError, code, text, index, length) => {
    if (!onError)
        return;
    const { line, column, snippet } = getErrorContext(text, index, length);
    const base = ERROR_MESSAGES[code] ?? code;
    const message = `(L${line}:C${column}) ${base}: ${snippet}`;
    onError({ code, message, line, column, snippet });
};
//# sourceMappingURL=errors.js.map