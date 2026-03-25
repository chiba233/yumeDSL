import type { TextToken } from "./types.js";
export declare const extractText: (tokens?: TextToken[]) => string;
export declare const materializeTextTokens: (tokens: TextToken[]) => TextToken[];
export interface PipeArgs {
    parts: TextToken[][];
    text: (index: number) => string;
    materializedTokens: (index: number) => TextToken[];
    materializedTailTokens: (startIndex: number) => TextToken[];
}
export declare const splitTokensByPipe: (tokens: TextToken[]) => TextToken[][];
export declare const parsePipeArgs: (tokens: TextToken[]) => PipeArgs;
export declare const parsePipeTextArgs: (text: string) => PipeArgs;
//# sourceMappingURL=builders.d.ts.map