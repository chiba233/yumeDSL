// ── Core API ──
export { parseRichText, stripRichText, createParser } from "./core/parse.js";
export type { Parser } from "./core/parse.js";

// ── Structural parse ──
export { parseStructural } from "./core/structural.js";

// ── Structural print ──
export { printStructural } from "./internal/print.js";
export type { PrintOptions } from "./internal/print.js";

// ── Configuration ──
export { DEFAULT_SYNTAX, createEasySyntax, createSyntax } from "./config/syntax.js";
export { DEFAULT_TAG_NAME, createTagNameConfig } from "./config/chars.js";

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
} from "./handlerBuilders/handlerHelpers.js";

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
} from "./handlerBuilders/builders.js";
export { unescapeInline, readEscapedSequence } from "./handlerBuilders/escape.js";
export { createToken, resetTokenIdSeed } from "./handlerBuilders/createToken.js";

// ── Token traversal ──
export { walkTokens, mapTokens } from "./handlerBuilders/walk.js";
export type { TokenVisitContext, WalkVisitor, MapVisitor } from "./handlerBuilders/walk.js";

// ── Legacy context (compat) ──
// These module-level context wrappers are still used in two places:
// 1. parseRichText wraps with withSyntax/withTagNameConfig/withCreateId so that
//    user handlers calling public utilities without ctx still get correct values.
// 2. parseStructural reads getSyntax()/getTagNameConfig() at entry to capture
//    ambient context when no explicit overrides are provided.
// Will be removed in a future major version — migrate to DslContext.
export { withSyntax, getSyntax } from "./config/syntax.js";
export { withTagNameConfig } from "./config/chars.js";

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
} from "./types/core.js";

// ── Types: configuration ──
export type { SyntaxInput, SyntaxConfig, TagNameConfig } from "./types/config.js";

// ── Types: block tags ──
export type { BlockTagInput, BlockTagLookup, MultilineForm } from "./types/core.js";

// ── Types: errors & utilities ──
export type { ErrorCode, ParseError, CreateId } from "./types/core.js";

// ── Position tracking ──
export { buildPositionTracker } from "./internal/positions.js";
export { createEasyStableId } from "./internal/stableId.js";

// ── Types: source positions ──
export type { PositionTracker, SourcePosition, SourceSpan } from "./types/core.js";

// ── Zone grouping ──
export { buildZones } from "./internal/zones.js";
export {
  parseIncremental,
  createIncrementalSession,
} from "./incremental/incremental.js";

// ── Types: structural ──
export type {
  StructuralNode,
  StructuralParseOptions,
  Zone,
} from "./types/structural.js";

export type {
  IncrementalParseOptions,
  IncrementalEdit,
  IncrementalDocument,
  IncrementalSessionOptions,
  TokenDiffResult,
  IncrementalSessionApplyResult,
  IncrementalSessionApplyWithDiffResult,
} from "./types/incremental.js";

export type { PipeArgs } from "./handlerBuilders/builders.js";
export type { PipeHandlerDefinition } from "./handlerBuilders/handlerHelpers.js";
export type { EasyStableIdOptions } from "./internal/stableId.js";
