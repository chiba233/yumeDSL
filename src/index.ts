// ── Core API ──
export { parseRichText, stripRichText, createParser } from "./parse.js";
export type { Parser } from "./parse.js";

// ── Structural parse ──
export { parseStructural } from "./structural.js";

// ── Configuration ──
export { DEFAULT_SYNTAX, createSyntax } from "./syntax.js";
export { DEFAULT_TAG_NAME, createTagNameConfig } from "./chars.js";

// ── Handler helpers ──
export {
  createPassthroughTags,
  createSimpleInlineHandlers,
  createSimpleBlockHandlers,
  createSimpleRawHandlers,
  createPipeBlockHandlers,
  createPipeRawHandlers,
  declareMultilineTags,
} from "./handlerHelpers.js";

// ── Handler utilities ──
export {
  extractText,
  materializeTextTokens,
  splitTokensByPipe,
  parsePipeArgs,
  parsePipeTextArgs,
  parsePipeTextList,
} from "./builders.js";
export { unescapeInline, readEscapedSequence } from "./escape.js";
export { createToken, resetTokenIdSeed } from "./createToken.js";

// ── Context ──
export { withSyntax, getSyntax } from "./syntax.js";
export { withTagNameConfig } from "./chars.js";

// ── Types: core ──
export type {
  ParserBaseOptions,
  ParseOptions,
  TagHandler,
  TagForm,
  TextToken,
  TokenDraft,
} from "./types.js";

// ── Types: configuration ──
export type {
  SyntaxInput,
  SyntaxConfig,
  TagNameConfig,
} from "./types.js";

// ── Types: block tags ──
export type {
  BlockTagInput,
  BlockTagLookup,
  MultilineForm,
} from "./types.js";

// ── Types: errors & utilities ──
export type {
  ErrorCode,
  ParseError,
  CreateId,
} from "./types.js";

// ── Types: structural ──
export type { StructuralNode, StructuralParseOptions } from "./types.js";

export type { PipeArgs } from "./builders.js";
