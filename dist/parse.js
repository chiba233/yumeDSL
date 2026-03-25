import { extractText } from "./builders.js";
import { tryConsumeEscape, tryConsumeTagClose, tryConsumeTagStart } from "./consumers.js";
import { finalizeUnclosedTags, flushBuffer } from "./context.js";
import { createSyntax, withSyntax } from "./syntax.js";
const deriveBlockTags = (handlers) => {
    const set = new Set();
    for (const [tag, handler] of Object.entries(handlers)) {
        const h = handler;
        if (h.raw || h.block)
            set.add(tag);
    }
    return set;
};
const internalParse = (text, depthLimit, options, onError, handlers, blockTagSet) => {
    if (!text)
        return [];
    const ctx = {
        text,
        depthLimit,
        mode: options?.mode ?? "render",
        onError,
        handlers,
        blockTagSet,
        root: [],
        stack: [],
        buffer: "",
        i: 0,
    };
    const recursiveParse = (innerText, innerDepthLimit, innerOptions) => {
        return internalParse(innerText, innerDepthLimit, innerOptions, onError, handlers, blockTagSet);
    };
    while (ctx.i < ctx.text.length) {
        if (tryConsumeTagStart(ctx, recursiveParse))
            continue;
        if (tryConsumeTagClose(ctx))
            continue;
        if (tryConsumeEscape(ctx))
            continue;
        ctx.buffer += ctx.text[ctx.i];
        ctx.i++;
    }
    flushBuffer(ctx);
    finalizeUnclosedTags(ctx);
    return ctx.root;
};
export const parseRichText = (text, options = {}) => {
    if (!text)
        return [];
    const handlers = options.handlers ?? {};
    const blockTagSet = options.blockTags
        ? new Set(options.blockTags)
        : deriveBlockTags(handlers);
    const syntax = createSyntax(options.syntax);
    return withSyntax(syntax, () => internalParse(text, options.depthLimit ?? 50, { mode: options.mode ?? "render" }, options.onError, handlers, blockTagSet));
};
export const stripRichText = (text, options = {}) => {
    if (!text)
        return "";
    const tokens = parseRichText(text, { ...options, onError: undefined });
    return extractText(tokens);
};
//# sourceMappingURL=parse.js.map