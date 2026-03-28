# Changelog

### 1.0.5

- New helper: `createPipeHandlers(definitions)`
  - Unified pipe-aware handler builder for any combination of `inline`, `raw`, and `block`
  - `inline` handlers receive parsed `PipeArgs` from inline tokens
  - `raw` / `block` handlers receive parsed `PipeArgs` from `arg`, while still preserving the original `rawArg`
- New utility: `createTextToken(value, ctx?)`
  - Shorthand for creating `{ type: "text", value }` tokens with parse-local `createId` support
- `PipeArgs` now includes convenience readers for custom handler code
  - `has(index)`
  - `text(index, fallback?)`
  - `materializedTokens(index, fallback?)`
  - `materializedTailTokens(startIndex, fallback?)`
- `createPipeBlockHandlers` and `createPipeRawHandlers` are now thin shorthands over `createPipeHandlers`
- Deprecation warnings for legacy ambient-state APIs (each warning fires once per runtime)
  - `withSyntax()`, `getSyntax()`, `withTagNameConfig()`, `withCreateId()`, `resetTokenIdSeed()` now emit a
    one-time `console.warn` when called by user code
  - Internal calls from `parseRichText` are suppressed via `withInternalCaller` — no warning noise during normal parsing
  - `parseStructural()` warns specifically when it detects ambient `withSyntax()` / `withTagNameConfig()` state that
    differs from defaults; normal calls without ambient wrapping do not warn
  - Warnings are suppressed when `NODE_ENV=production`
- Deprecated exports formally documented in a new **Deprecated API** section:
  `createPipeBlockHandlers`, `createPipeRawHandlers`, `createPassthroughTags`, `withSyntax`, `getSyntax`,
  `withTagNameConfig`, `withCreateId`, `resetTokenIdSeed`, `ParseOptions.mode`
- Deprecated APIs will **not** be removed before September 2026
- Documentation refresh
  - Promoted `createPipeHandlers` as the main pipe-aware helper
  - Reorganized handler helper docs into recommended / shorthand / advanced sections
  - Updated utility examples to use `createTextToken(...)` where appropriate
  - Consolidated same-family helpers into shared sections for better information density

### 1.0.4

- **Refactor:** Eliminate all remaining module-level implicit state reads from internal parse code
  - `ParseContext` now carries `syntax`, `tagName`, and `createId` directly — internal functions read these instead of
    calling `getSyntax()` / `getTagNameConfig()` / relying on `activeCreateId`
  - All scanner functions (`findTagArgClose`, `readTagStartInfo`, `findInlineClose`, `findBlockClose`, `findRawClose`,
    `getTagCloserType`, `skipTagBoundary`, `skipDegradedInline`) receive explicit `syntax` / `tagName` parameters
  - `parseStructural` threads `syntax` / `tagName` / `tracker` explicitly through `parseNodes` — no `withSyntax` /
    `withTagNameConfig` wrappers needed internally. Ambient `getSyntax()` / `getTagNameConfig()` are captured once at
    entry when no explicit overrides are provided
  - `parseRichText` still wraps with `withSyntax` / `withTagNameConfig` / `withCreateId` at entry for backward
    compatibility — user handlers calling public utilities (`parsePipeArgs`, `createToken`, `unescapeInline`, etc.)
    continue to work without changes
- New type: `DslContext { syntax, createId? }` — lightweight context for public utility functions
  - Builder utilities (`splitTokensByPipe`, `parsePipeArgs`, `parsePipeTextArgs`, `parsePipeTextList`,
    `materializeTextTokens`) accept `ctx?: DslContext`
  - Escape utilities (`readEscapedSequence`, `readEscaped`, `unescapeInline`) accept `ctx?: DslContext | SyntaxConfig`
    — `DslContext` for user code, bare `SyntaxConfig` for internal scanner calls
  - `createToken(..., ctx?)` accepts `ctx?: DslContext | CreateId` — `DslContext` for user code, bare `CreateId` for
    internal context threading
  - Syntax resolution (`resolveSyntax`) and createId resolution (`resolveCreateId`) are each centralized in one place
  - When `ctx` is omitted, all utilities fall back to module-level defaults (`getSyntax()` / `activeCreateId`) —
    existing code continues to work unchanged
  - A future major version will tighten this toward required `DslContext`
- `TagHandler` callback signatures now receive an optional `ctx?: DslContext` as the last parameter
  - `inline?: (tokens, ctx?) => TokenDraft`
  - `raw?: (arg, content, ctx?) => TokenDraft`
  - `block?: (arg, content, ctx?) => TokenDraft`
  - The parser passes `DslContext` when calling handlers — existing handlers that don't accept `ctx` are unaffected
    (JS safely ignores extra arguments)
  - Handlers that opt in can pass `ctx` through to utility functions, eliminating all implicit global state dependency
- Built-in handler helpers now propagate `ctx` through the full call chain
  - `createSimpleInlineHandlers` → `materializeTextTokens(tokens, ctx)`
  - `createPipeBlockHandlers` → `parsePipeTextList(arg, ctx)`
  - `createPipeRawHandlers` → `parsePipeTextList(arg, ctx)`
- `parseStructural` reuses `emptyBuffer()` from `context.ts` for buffer initialization and reset
- All existing exports and signatures remain backward compatible; `DslContext` and optional `ctx` parameters are
  additive (non-breaking)

### 1.0.3

- **Refactor:** Position tracker moved from module-level implicit state to explicit parameter threading
  - `ParseContext` now carries `tracker: PositionTracker | null` directly
  - `parseStructural` passes tracker explicitly through `parseNodes` — no hidden globals
  - `emitError` / `getErrorContext` receive tracker as a parameter instead of reading module state
  - `complex.ts` receives tracker explicitly; inner-parse offset adjustment uses `offsetTracker` (replaces
    `withBaseOffset` + `withPositionTracker`)
- **Refactor:** Buffer accumulation state consolidated into `BufferState` object
  - `ParseContext.buffer` / `bufferStart` / `bufferSourceEnd` merged into `ParseContext.buf: BufferState`
  - `emptyBuffer()` factory for initialization and reset
- **Refactor:** Block content normalization + offset mapping encapsulated as `prepareBlockContent`
  - Returns `{ content, baseOffset }` — callers no longer manually combine `normalizeBlockTagContent` +
    `leadingTrim` + `contentStart`
- No public API changes; all changes are internal

### 1.0.2

- Add opt-in source position tracking (`trackPositions: true`) for both `parseRichText` and `parseStructural`
  - New types: `SourcePosition`, `SourceSpan`
  - `TextToken.position?` and `StructuralNode.position?` — present only when enabled
  - Pre-computed line-offset table with O(log n) binary search for line/column resolution
  - Negligible overhead when disabled (default) — no table allocation, no position objects produced
  - `parseRichText` block/raw token spans include trailing line-break normalization; `parseStructural` keeps raw
    syntax spans
  - Nested block content positions map back to the original source via base-offset adjustment
  - Error reporting reuses the line-offset table when position tracking is active
- `normalizeBlockTagContent` now returns `{ content, leadingTrim }` instead of a plain string (internal change,
  not part of the public API)

### 1.0.1

- Add `createEasySyntax(overrides)` — convenience function that auto-derives compound tokens (`endTag`, `rawOpen`,
  `blockOpen`, `rawClose`, `blockClose`) from `tagPrefix` and `tagClose`. Explicit overrides still take precedence.
  `createSyntax` is retained as the low-level plain-merge alternative
- Improve documentation readability — reduce info density in the opening sections, add recommended reading order,
  add decision guidance ("which API to use"), add ecosystem combination guide, rewrite Default Syntax section with
  ASCII diagrams and token dependency table

### 1.0.0

- **Breaking (behavior):** Remove `"highlight"` from `ParseOptions.mode` — the value is no longer accepted.
  The three internal highlight-mode branches (skip block content trimming, skip trailing line-break consumption,
  skip raw-content unescaping) have been deleted. Use `parseStructural` for syntax-highlighting use cases
- Reposition `parseStructural` as a first-class structural parse API sharing the same language configuration
  as `parseRichText`, not a highlighting helper
- Elevate Custom Syntax as a core feature — updated intro, design philosophy, features, and when-to-use sections
- Remove `supportsInlineForm` and `filterHandlersByForms` from public exports (internal-only, erroneously listed as
  exported in 0.1.18–0.1.19 changelog but never actually re-exported from `index.ts`)

### 0.1.20

- Fix documentation broken by AI-generated changes

### 0.1.18 - 0.1.19

- Add `parseStructural(text, options?)` — structural parser that preserves tag form
  (inline / raw / block) in the output tree as `StructuralNode[]`
  - Shares `ParserBaseOptions` with `parseRichText` — identical tag recognition and form gating when `handlers` is
    provided
  - Omit `handlers` to accept all tags and forms (highlight mode)
  - Inherits active `withSyntax` / `withTagNameConfig` context when called without explicit overrides
- Extract `ParserBaseOptions` — shared base for `ParseOptions` and `StructuralParseOptions`
  (`handlers`, `allowForms`, `depthLimit`, `syntax`, `tagName`)
- Add `parser.structural()` to `createParser` return type — shares base config with `parse()` / `strip()`
- Export `supportsInlineForm`, `filterHandlersByForms` from internal modules (used by structural parser, single source)
- Export `readEscapedSequence`, `withSyntax`, `getSyntax`, `withTagNameConfig`
- Export `ParserBaseOptions`, `StructuralNode`, `StructuralParseOptions` types
- Add `yume-dsl-shiki-highlight` to ecosystem

### 0.1.15 – 0.1.17

- Add [Live Demo](https://qwwq.org/blog/dsl-fallback-museum) — showcasing Shiki code-highlighting plugin, legitimate
  plugins, malformed markup, and error reporting
- Optimize npm package size by excluding non-essential docs (~30% smaller)
- Add Vue 3 rendering guide with drop-in recursive component example
- Add community docs: `CONTRIBUTING.md`, `SECURITY.md`, issue templates, PR template
- Add Chinese translations for `CONTRIBUTING.zh-CN.md`

### 0.1.14

- Update Markdown and add golden test.

### 0.1.13

- Reorganize `index.ts` exports into clearer groups: Configuration, Handler Helpers, Handler Utilities, and typed
  sub-groups
- Reorganize README "Utility Exports" section into Configuration / Handler Helpers / Handler Utilities sub-tables
- Consolidate all `tagName` documentation into a single "Custom Tag Name Characters" section
- Fix dist smoke test TS7016 in IDEA by switching to self-referencing package import + `paths` mapping

### 0.1.12

- Add `tagName` to `ParseOptions` so users can customize `isTagStartChar` / `isTagChar`
- Add `TagNameConfig`, `DEFAULT_TAG_NAME`, and `createTagNameConfig`
- Update README with `parseRichText` and `createParser` examples for custom tag-name rules
- Add per-form granularity to `declareMultilineTags` — entries can now be `{ tag, forms }` objects to restrict
  line-break normalization to specific multiline forms (`"raw"` / `"block"`)
- Plain string entries remain fully backward compatible (normalize both raw and block forms)
- Add `MultilineForm`, `BlockTagInput`, `BlockTagLookup` exported types
- Internal: replace `Set<string>` block-tag lookup with form-aware `BlockTagLookup`; `deriveBlockTags` now registers
  each handler method under its own form for more precise auto-derivation

### 0.1.11

- Make parser-generated token ids parse-local by default (`rt-0`, `rt-1`, ... per parse)
- Add `createId` option to override token id generation per parse / parser

### 0.1.10

- Add `parsePipeTextList(text)` utility — split a pipe-delimited arg string directly into `string[]` without
  intermediate token allocation
- Refactor `createPipeBlockHandlers()` / `createPipeRawHandlers()` to use `parsePipeTextList` internally
- Add decision-table comment to the inline-form gating function (`supportsInlineForm`) to guard against future
  regressions
- Add JSDoc to `materializeTextTokens` clarifying it only unescapes text-type leaf tokens

### 0.1.9

- Remove source maps to reduce package size
- Fix `allowForms` so disabling `"inline"` also blocks inline syntax for tags that still have `raw` / `block`
  handlers
- Fix `allowForms` so disabling `"inline"` also preserves unregistered `$$unknown(...)$$` tags literally
- Fix `createSimpleBlockHandlers()` / `createSimpleRawHandlers()` so block-only and raw-only helpers no longer accept
  inline syntax implicitly
- Fix custom syntax parsing for multi-character `tagOpen` / `tagClose` / `tagDivider` tokens
- Fix `allowForms: ["inline"]` so registered block/raw-only tags filtered out by form restriction keep their inline
  markup literally instead of being treated as unknown inline tags
- Guard `onError` callbacks so user-thrown exceptions do not abort parsing
- Expand custom syntax escaping so `endTag` / `rawOpen` / `blockOpen` can also be escaped literally
- Add `createPipeBlockHandlers()` and `createPipeRawHandlers()` helpers for structural pipe-arg parsing
- Add regression tests for `allowForms` and the new handler helpers
- Add custom syntax edge tests, compile-time type checks, and stronger fuzz coverage
- Clarify README wording around multiline block/raw helpers and fallback behavior

### 0.1.8

- Add `allowForms` option to `ParseOptions` — restrict which tag forms (`"inline"`, `"raw"`, `"block"`) the parser
  accepts; disallowed forms degrade gracefully
- Add `createSimpleInlineHandlers(names)` helper — register simple inline tags in bulk without writing repetitive
  handler objects
- Add `declareMultilineTags(names)` helper — declare which tags need multiline line-break normalization (`blockTags`)
- Add `createSimpleBlockHandlers(names)` helper — register simple block-form tags in bulk
- Add `createSimpleRawHandlers(names)` helper — register simple raw-form tags in bulk
- Add `createPassthroughTags(names)` helper — register tag names with empty handlers in bulk (advanced use case)
- All helpers preserve literal key types via `const` generics — `createSimpleInlineHandlers(["bold", "italic"])` infers
  `Record<"bold" | "italic", TagHandler>`
- Export `TagForm` type

### 0.1.7

- Add index signature (`[key: string]: unknown`) to `TextToken` — extra fields from handlers are now visible in the type
  system without casting
- Remove unnecessary `as TextToken` assertion in `createToken`
- Enable `allowImportingTsExtensions` in tsconfig — project now passes `tsc --noEmit` cleanly
- Update README: document `TextToken` index signature, recommend `extends TextToken` for strong typing

### 0.1.6

- Just update Markdown.

### 0.1.5

- Add `createParser()` factory for pre-bound options
- Export `Parser` interface

### 0.1.4

- Narrow `ParseError.code` from `string` to `ErrorCode` union type
- Export `ErrorCode` type
- Optimize `extractText` — replace `.map().join("")` with `for...of` loop
- Optimize `getErrorContext` — replace `slice` + `split` with single-pass line counter
- Fix duplicate `trimStart()` call in `findMalformedWholeLineTokenCandidate`

### 0.1.3

- Comprehensive README rewrite with full API documentation
- Add LICENSE file
- Add CI publish workflow for npm and GitHub Packages
- Add pre-publish README verification step

### 0.1.1

- Fix: ensure parse errors are reported correctly
- Add golden test suite (60 cases) and dist smoke tests (36 cases)
- Add CJS + ESM dual-format build

### 0.1.0

- Initial release
- Recursive DSL parser with inline, raw, and block tag forms
- Pluggable tag handlers with graceful degradation
- Configurable syntax tokens
- Utility helpers: `parsePipeArgs`, `extractText`, `materializeTextTokens`, etc.
