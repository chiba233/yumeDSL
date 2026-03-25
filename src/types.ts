// ── Public types ──

export interface TextToken {
  type: string;
  value: string | TextToken[];
  id: string;
  [key: string]: unknown;
}

export interface TokenDraft {
  type: string;
  value: string | TextToken[];
  [key: string]: unknown;
}

export type ErrorCode =
  | "DEPTH_LIMIT"
  | "UNEXPECTED_CLOSE"
  | "INLINE_NOT_CLOSED"
  | "BLOCK_NOT_CLOSED"
  | "BLOCK_CLOSE_MALFORMED"
  | "RAW_NOT_CLOSED"
  | "RAW_CLOSE_MALFORMED";

export interface ParseError {
  code: ErrorCode;
  message: string;
  line: number;
  column: number;
  snippet: string;
}

export interface TagHandler {
  inline?: (tokens: TextToken[]) => TokenDraft;
  raw?: (arg: string | undefined, content: string) => TokenDraft;
  block?: (arg: string | undefined, content: TextToken[]) => TokenDraft;
}

export interface SyntaxInput {
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

export interface SyntaxConfig extends SyntaxInput {
  /** Precomputed, sorted descending by length. */
  escapableTokens: string[];
}

export interface ParseOptions {
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

// ── Internal types (not re-exported from index) ──

export type ParseMode = "render" | "highlight";

export interface ParseContext {
  text: string;
  depthLimit: number;
  mode: ParseMode;
  onError: ((error: ParseError) => void) | undefined;
  handlers: Record<string, TagHandler>;
  blockTagSet: ReadonlySet<string>;
  root: TextToken[];
  stack: ParseStackNode[];
  buffer: string;
  i: number;
}

export interface ParseStackNode {
  tag: string;
  richType: string | null;
  tokens: TextToken[];
  openPos: number;
  openLen: number;
}

export interface TagStartInfo {
  tag: string;
  tagOpenPos: number;
  tagNameEnd: number;
  inlineContentStart: number;
}

export interface ComplexTagParseResult {
  handled: boolean;
  nextIndex: number;
  token?: TextToken;
  fallbackText?: string;
  error?: {
    code: ErrorCode;
    index: number;
    length?: number;
  };
}

export interface TagHead {
  tag: string;
  tagStart: number;
  tagNameEnd: number;
  argStart: number;
}
