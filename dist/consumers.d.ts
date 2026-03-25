import type { ParseContext, TagStartInfo, TextToken } from "./types.js";
export declare const tryConsumeDepthLimitedTag: (ctx: ParseContext, info: TagStartInfo) => boolean;
export declare const tryConsumeComplexTag: (ctx: ParseContext, info: TagStartInfo, inlineEnd: number, parseInlineContent: (text: string, depthLimit: number, options?: {
    mode?: ParseContext["mode"];
}) => TextToken[]) => boolean;
export declare const tryConsumeInlineTag: (ctx: ParseContext, info: TagStartInfo, inlineEnd: number) => boolean;
export declare const tryConsumeTagStart: (ctx: ParseContext, parseInlineContent: (text: string, depthLimit: number, options?: {
    mode?: ParseContext["mode"];
}) => TextToken[]) => boolean;
export declare const finalizeClosedNode: (ctx: ParseContext, node: ParseContext["stack"][0]) => void;
export declare const tryConsumeTagClose: (ctx: ParseContext) => boolean;
export declare const tryConsumeEscape: (ctx: ParseContext) => boolean;
//# sourceMappingURL=consumers.d.ts.map