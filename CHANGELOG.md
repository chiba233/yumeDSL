# Changelog

## 1.0.4

- **Refactor:** Eliminate all remaining module-level implicit state reads from internal parse code
  - `ParseContext` now carries `syntax`, `tagName`, and `createId` directly — internal functions read these instead of calling `getSyntax()` / `getTagNameConfig()` / relying on `activeCreateId`
  - All scanner functions (`findTagArgClose`, `readTagStartInfo`, `findInlineClose`, `findBlockClose`, `findRawClose`, `getTagCloserType`, `skipTagBoundary`, `skipDegradedInline`) receive explicit `syntax` / `tagName` parameters
  - `parseStructural` threads `syntax` / `tagName` / `tracker` explicitly through `parseNodes` — no `withSyntax` / `withTagNameConfig` wrappers needed internally. Ambient `getSyntax()` / `getTagNameConfig()` are captured once at entry when no explicit overrides are provided
  - `parseRichText` still wraps with `withSyntax` / `withTagNameConfig` / `withCreateId` at entry for backward compatibility — user handlers calling public utilities (`parsePipeArgs`, `createToken`, `unescapeInline`, etc.) continue to work without changes
- New type: `DslContext { syntax, createId? }` — lightweight context for public utility functions
  - All public utilities (`readEscapedSequence`, `readEscaped`, `unescapeInline`, `splitTokensByPipe`, `parsePipeArgs`, `parsePipeTextArgs`, `parsePipeTextList`, `materializeTextTokens`, `createToken`) now accept an optional `ctx?: DslContext | SyntaxConfig` parameter
  - Pass `DslContext` for full explicit context, or `SyntaxConfig` as a shorthand when only syntax is needed
  - `createToken(..., ctx?)` also keeps accepting a bare `CreateId` function for backward compatibility
  - When omitted, fall back to module-level defaults (`getSyntax()` / `activeCreateId`) — existing code continues to work unchanged
  - A future major version will tighten this toward explicit `DslContext`
- `parseStructural` reuses `emptyBuffer()` from `context.ts` for buffer initialization and reset
- All existing exports and signatures remain backward compatible; `DslContext` and optional `ctx` parameters are additive (non-breaking)

## 1.0.3

- **Refactor:** Position tracker moved from module-level implicit state to explicit parameter threading
  - `ParseContext` now carries `tracker: PositionTracker | null` directly
  - `parseStructural` passes tracker explicitly through `parseNodes` — no hidden globals
  - `emitError` / `getErrorContext` receive tracker as a parameter instead of reading module state
  - `complex.ts` receives tracker explicitly; inner-parse offset adjustment uses `offsetTracker` (replaces `withBaseOffset` + `withPositionTracker`)
- **Refactor:** Buffer accumulation state consolidated into `BufferState` object
  - `ParseContext.buffer` / `bufferStart` / `bufferSourceEnd` merged into `ParseContext.buf: BufferState`
  - `emptyBuffer()` factory for initialization and reset
- **Refactor:** Block content normalization + offset mapping encapsulated as `prepareBlockContent`
  - Returns `{ content, baseOffset }` — callers no longer manually combine `normalizeBlockTagContent` + `leadingTrim` + `contentStart`
- No public API changes; all changes are internal

## 1.0.2

- Add opt-in source position tracking (`trackPositions: true`) for both `parseRichText` and `parseStructural`
  - New types: `SourcePosition`, `SourceSpan`
  - `TextToken.position?` and `StructuralNode.position?` — present only when enabled
  - Pre-computed line-offset table with O(log n) binary search for line/column resolution
  - Negligible overhead when disabled (default) — no table allocation, no position objects produced
  - `parseRichText` block/raw token spans include trailing line-break normalization; `parseStructural` keeps raw syntax spans
  - Nested block content positions map back to the original source via base-offset adjustment
  - Error reporting reuses the line-offset table when position tracking is active
- `normalizeBlockTagContent` now returns `{ content, leadingTrim }` instead of a plain string (internal change, not part of the public API)

## 1.0.1

- Add `createEasySyntax(overrides)` — convenience function that auto-derives compound tokens (`endTag`, `rawOpen`, `blockOpen`, `rawClose`, `blockClose`) from `tagPrefix` and `tagClose`. Explicit overrides still take precedence. `createSyntax` is retained as the low-level plain-merge alternative
- Improve documentation readability — reduce info density in the opening sections, add recommended reading order, add decision guidance ("which API to use"), add ecosystem combination guide, rewrite Default Syntax section with ASCII diagrams and token dependency table

## 1.0.0

- **Breaking (behavior):** Remove `"highlight"` from `ParseOptions.mode` — the value is no longer accepted. The three internal highlight-mode branches (skip block content trimming, skip trailing line-break consumption, skip raw-content unescaping) have been deleted. Use `parseStructural` for syntax-highlighting use cases
- Reposition `parseStructural` as a first-class structural parse API sharing the same language configuration as `parseRichText`, not a highlighting helper
- Elevate Custom Syntax as a core feature — updated intro, design philosophy, features, and when-to-use sections
- Remove `supportsInlineForm` and `filterHandlersByForms` from public exports (internal-only, erroneously listed as exported in 0.1.18–0.1.19 changelog but never actually re-exported from `index.ts`)

## 0.1.20

- Fix documentation broken by AI-generated changes

## 0.1.18 - 0.1.19

- Add `parseStructural(text, options?)` — structural parser that preserves tag form
