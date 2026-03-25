import type { ParseMode } from "./types.js";
export declare const stripSingleLeadingLineBreak: (text: string) => string;
export declare const consumeSingleTrailingLineBreak: (text: string, index: number) => number;
export declare const normalizeBlockTagContent: (tag: string, content: string, mode: ParseMode, blockTagSet: ReadonlySet<string>) => string;
export declare const consumeBlockTagTrailingLineBreak: (tag: string, text: string, index: number, mode: ParseMode, blockTagSet: ReadonlySet<string>) => number;
//# sourceMappingURL=blockTagFormatting.d.ts.map