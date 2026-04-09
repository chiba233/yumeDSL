// ── Core API ──
export { parseRichText, stripRichText, createParser } from "./parse.js";
export type { Parser } from "./parse.js";

// ── Structural parse ──
export { parseStructural } from "./structural.js";

// ── Structural print ──
export { printStructural } from "./print.js";
export type { PrintOptions } from "./print.js";

// ── Configuration ──
export { DEFAULT_SYNTAX, createEasySyntax, createSyntax } from "./syntax.js";
export { DEFAULT_TAG_NAME, createTagNameConfig } from "./chars.js";

// ── Handler helpers ──
export {
  createPassthroughTags,
  createSimpleInlineHandlers,
  createSimpleBlockHandlers,
  createSimpleRawHandlers,
  createPipeHandlers,
  createPipeBlockHandlers,
  createPipeRawHandlers,
  declareMultilineTags,
} from "./handlerHelpers.js";

// ── Handler utilities ──
export {
  createTextToken,
  extractText,
  materializeTextTokens,
  splitTokensByPipe,
  parsePipeArgs,
  parsePipeTextArgs,
  parsePipeTextList,
  createTokenGuard,
} from "./builders.js";
export { unescapeInline, readEscapedSequence } from "./escape.js";
export { createToken, resetTokenIdSeed } from "./createToken.js";

// ── Token traversal ──
export { walkTokens, mapTokens } from "./walk.js";
export type { TokenVisitContext, WalkVisitor, MapVisitor } from "./walk.js";

// ── Legacy context (compat) ──
// These module-level context wrappers are still used in two places:
// 1. parseRichText wraps with withSyntax/withTagNameConfig/withCreateId so that
//    user handlers calling public utilities without ctx still get correct values.
// 2. parseStructural reads getSyntax()/getTagNameConfig() at entry to capture
//    ambient context when no explicit overrides are provided.
// Will be removed in a future major version — migrate to DslContext.
export { withSyntax, getSyntax } from "./syntax.js";
export { withTagNameConfig } from "./chars.js";

// ── Types: core ──
export type {
  DslContext,
  ParserBaseOptions,
  ParseOptions,
  TagHandler,
  TagForm,
  TextToken,
  TokenDraft,
  NarrowToken,
  NarrowDraft,
  NarrowTokenUnion,
} from "./types.js";

// ── Types: configuration ──
export type { SyntaxInput, SyntaxConfig, TagNameConfig } from "./types.js";

// ── Types: block tags ──
export type { BlockTagInput, BlockTagLookup, MultilineForm } from "./types.js";

// ── Types: errors & utilities ──
export type { ErrorCode, ParseError, CreateId } from "./types.js";

// ── Position tracking ──
export { buildPositionTracker } from "./positions.js";
export { createEasyStableId } from "./stableId.js";

// ── Types: source positions ──
export type { PositionTracker, SourcePosition, SourceSpan } from "./types.js";

// ── Zone grouping ──
export { buildZones } from "./zones.js";
export {
  parseIncremental,
  createIncrementalSession,
} from "./incremental.js";

// ── Types: structural ──
export type {
  StructuralNode,
  StructuralParseOptions,
  Zone,
  IncrementalParseOptions,
  IncrementalEdit,
  IncrementalDocument,
  IncrementalSessionApplyMode,
  IncrementalSessionApplyResult,
  IncrementalSessionFallbackReason,
  IncrementalSessionStrategy,
  IncrementalSessionOptions,
  IncrementalSession,
} from "./types.js";

export type { PipeArgs } from "./builders.js";
export type { PipeHandlerDefinition } from "./handlerHelpers.js";
export type { EasyStableIdOptions } from "./stableId.js";
