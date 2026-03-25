import type { SyntaxConfig, SyntaxInput } from "./types.js";
export declare const DEFAULT_SYNTAX: SyntaxInput;
export declare const createSyntax: (overrides?: Partial<SyntaxInput>) => SyntaxConfig;
export declare const getSyntax: () => SyntaxConfig;
export declare const withSyntax: <T>(syntax: SyntaxConfig, fn: () => T) => T;
//# sourceMappingURL=syntax.d.ts.map