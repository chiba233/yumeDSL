import type { ComplexTagParseResult, ParseMode, TagHandler, TextToken } from "./types.js";
export declare const tryParseComplexTag: (text: string, tagOpenPos: number, tag: string, tagNameEnd: number, inlineEnd: number, depthLimit: number, mode: ParseMode, handlers: Record<string, TagHandler>, blockTagSet: ReadonlySet<string>, parseInlineContent: (text: string, depthLimit: number, options?: {
    mode?: ParseMode;
}) => TextToken[]) => ComplexTagParseResult;
//# sourceMappingURL=complex.d.ts.map