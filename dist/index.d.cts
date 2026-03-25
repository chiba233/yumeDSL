interface TextToken {
    type: string;
    value: string | TextToken[];
    id: string;
}
interface TokenDraft {
    type: string;
    value: string | TextToken[];
    [key: string]: unknown;
}
interface ParseError {
    code: string;
    message: string;
    line: number;
    column: number;
    snippet: string;
}
interface TagHandler {
    inline?: (tokens: TextToken[]) => TokenDraft;
    raw?: (arg: string | undefined, content: string) => TokenDraft;
    block?: (arg: string | undefined, content: TextToken[]) => TokenDraft;
}
interface SyntaxInput {
    tagPrefix: string;
    tagOpen: string;
    tagClose: string;
    tagDivider: string;
    endTag: string;
    rawOpen: string;
    blockOpen: string;
    blockClose: string;
    rawClose: string;
    escapeChar: string;
}
interface SyntaxConfig extends SyntaxInput {
    /** Precomputed, sorted descending by length. */
    escapableTokens: string[];
}
interface ParseOptions {
    /** Tag handler map – keys are tag names, values define how each tag is parsed. */
    handlers?: Record<string, TagHandler>;
    /**
     * Tags that receive block-level line-break normalization.
     * Defaults to every tag whose handler has a `raw` or `block` parser.
     */
    blockTags?: string[];
    /** Maximum nesting depth (default 50). */
    depthLimit?: number;
    /** `"render"` (default) strips leading/trailing line breaks inside blocks; `"highlight"` preserves them. */
    mode?: "render" | "highlight";
    /** Called for every parse error. If omitted, errors are silently discarded. */
    onError?: (error: ParseError) => void;
    /** Override DSL syntax tokens (default: `$$tag(…)$$` family). */
    syntax?: Partial<SyntaxInput>;
}

declare const parseRichText: (text: string, options?: ParseOptions) => TextToken[];
declare const stripRichText: (text: string, options?: ParseOptions) => string;

declare const extractText: (tokens?: TextToken[]) => string;
declare const materializeTextTokens: (tokens: TextToken[]) => TextToken[];
interface PipeArgs {
    parts: TextToken[][];
    text: (index: number) => string;
    materializedTokens: (index: number) => TextToken[];
    materializedTailTokens: (startIndex: number) => TextToken[];
}
declare const splitTokensByPipe: (tokens: TextToken[]) => TextToken[][];
declare const parsePipeArgs: (tokens: TextToken[]) => PipeArgs;
declare const parsePipeTextArgs: (text: string) => PipeArgs;

declare const unescapeInline: (str: string) => string;

declare const createToken: (token: TokenDraft) => TextToken;
declare const resetTokenIdSeed: () => void;

declare const DEFAULT_SYNTAX: SyntaxInput;
declare const createSyntax: (overrides?: Partial<SyntaxInput>) => SyntaxConfig;

export { DEFAULT_SYNTAX, type ParseError, type ParseOptions, type PipeArgs, type SyntaxConfig, type SyntaxInput, type TagHandler, type TextToken, type TokenDraft, createSyntax, createToken, extractText, materializeTextTokens, parsePipeArgs, parsePipeTextArgs, parseRichText, resetTokenIdSeed, splitTokensByPipe, stripRichText, unescapeInline };
