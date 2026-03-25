import type { ParseError } from "./types.js";
export declare const getErrorContext: (text: string, index: number, length?: number, range?: number) => {
    line: number;
    column: number;
    snippet: string;
};
export declare const emitError: (onError: ((error: ParseError) => void) | undefined, code: string, text: string, index: number, length?: number) => void;
//# sourceMappingURL=errors.d.ts.map