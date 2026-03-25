// ── Core API ──
export { parseRichText, stripRichText } from "./parse.js";

// ── Types ──
export type {
  TextToken,
  TokenDraft,
  ErrorCode,
  ParseError,
  ParseOptions,
  TagHandler,
  SyntaxInput,
  SyntaxConfig,
} from "./types.js";

// ── Utilities for handler authors ──
export {
  extractText,
  materializeTextTokens,
  splitTokensByPipe,
  parsePipeArgs,
  parsePipeTextArgs,
} from "./builders.js";
export type { PipeArgs } from "./builders.js";
export { unescapeInline } from "./escape.js";
export { createToken, resetTokenIdSeed } from "./createToken.js";

// ── Syntax configuration ──
export { DEFAULT_SYNTAX, createSyntax } from "./syntax.js";
