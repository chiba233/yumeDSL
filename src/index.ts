// ── Core API ──
export { parseRichText, stripRichText, createParser } from "./parse.js";
export type { Parser } from "./parse.js";

// ── Types ──
export type {
  TextToken,
  TokenDraft,
  ErrorCode,
  ParseError,
  ParseOptions,
  TagForm,
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

// ── Handler helpers ──
export { createPassthroughTags, createSimpleInlineHandlers } from "./handlerHelpers.js";

// ── Syntax configuration ──
export { DEFAULT_SYNTAX, createSyntax } from "./syntax.js";
