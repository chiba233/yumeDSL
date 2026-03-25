import type { ParseContext, TextToken } from "./types.js";
export declare const getCurrentTokens: (ctx: ParseContext) => TextToken[];
export declare const pushTextToCurrent: (ctx: ParseContext, str: string) => void;
export declare const flushBuffer: (ctx: ParseContext) => void;
export declare const finalizeUnclosedTags: (ctx: ParseContext) => void;
//# sourceMappingURL=context.d.ts.map