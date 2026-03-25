import type { TagStartInfo } from "./types.js";
export declare const findTagArgClose: (text: string, start: number) => number;
export declare const getTagCloserType: (text: string, tagOpenIndex: number) => {
    closer: string;
    argClose: number;
} | null;
export declare const findInlineClose: (text: string, start: number) => number;
export declare const findBlockClose: (text: string, start: number) => number;
export declare const findRawClose: (text: string, start: number) => number;
export declare const findMalformedWholeLineTokenCandidate: (text: string, start: number, token: string) => {
    index: number;
    length: number;
} | null;
export declare const skipDegradedInline: (text: string, start: number) => number;
export declare const readTagStartInfo: (text: string, i: number) => TagStartInfo | null;
//# sourceMappingURL=scanner.d.ts.map