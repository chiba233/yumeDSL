// ── Public types ──

/** Absolute source position used by `trackPositions` outputs. */
export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

/** Half-open source span (`start` inclusive, `end` exclusive). */
export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

/** Render token shape returned by `parseRichText`. */
export interface TextToken {
  type: string;
  value: string | TextToken[];
  id: string;
  position?: SourceSpan;
  [key: string]: unknown;
}

/** Token draft shape expected from handlers before `id` assignment. */
export interface TokenDraft {
  type: string;
  value: string | TextToken[];
  [key: string]: unknown;
}

// ── 强类型收窄工具 ──
//
// TextToken / TokenDraft 的 index signature `[key: string]: unknown` 是故意保留的：
// handler 侧需要它来自由附加额外字段（url、lang、arg 等），不破坏现有 API。
//
// 消费侧用下面的 NarrowToken / NarrowDraft 把类型"捡回来"：
// - NarrowToken  → 配合 createTokenGuard 在 if 分支里自动收窄
// - NarrowDraft  → handler 作者标注返回类型，拿到编译期检查
// - NarrowTokenUnion → 从 token map 批量生成联合类型，用于 switch/exhaustive check

/**
 * 把 TextToken 收窄为特定 `type` 字面量 + 已知额外字段的子类型。
 *
 * 基础 TextToken 的 index signature 允许 handler 随意附加字段，
 * 但消费侧拿到的全是 `unknown`。用 NarrowToken 在消费侧恢复类型信息。
 *
 * @example
 * ```ts
 * type LinkToken = NarrowToken<'link', { url: string }>;
 * type BoldToken = NarrowToken<'bold'>;
 *
 * function renderLink(token: LinkToken) {
 *   token.type; // 'link'
 *   token.url;  // string
 *   token.id;   // string  （TextToken 的固有字段仍然可用）
 * }
 * ```
 */
export type NarrowToken<
  TType extends string,
  TExtra extends Record<string, unknown> = {},
> = TextToken & { type: TType } & TExtra;

/**
 * 把 TokenDraft 收窄为特定 `type` 字面量 + 已知额外字段的子类型。
 * 用于 handler 返回类型标注，让 handler 作者也能拿到编译期检查。
 *
 * @example
 * ```ts
 * type LinkDraft = NarrowDraft<'link', { url: string }>;
 *
 * const linkHandler: TagHandler = {
 *   inline: (tokens, ctx): LinkDraft => ({
 *     type: 'link',
 *     url: args.text(0),           // ← 漏写 url 会报错
 *     value: args.materializedTailTokens(1),
 *   }),
 * };
 * ```
 */
export type NarrowDraft<
  TType extends string,
  TExtra extends Record<string, unknown> = {},
> = TokenDraft & { type: TType } & TExtra;

/**
 * 从 token map 类型批量生成 NarrowToken 联合类型。
 *
 * 适合需要 exhaustive switch 或统一约束消费侧输入类型的场景。
 *
 * @example
 * ```ts
 * interface MyTokenMap {
 *   bold: {};
 *   link: { url: string };
 *   code: { lang: string };
 * }
 * type MyToken = NarrowTokenUnion<MyTokenMap>;
 * // = NarrowToken<'bold'> | NarrowToken<'link', { url: string }> | NarrowToken<'code', { lang: string }>
 * ```
 */
export type NarrowTokenUnion<TMap extends Record<string, Record<string, unknown>>> = {
  [K in keyof TMap & string]: NarrowToken<K, TMap[K]>;
}[keyof TMap & string];

/**
 * Token id generator used by parse/build helpers.
 *
 * Contract:
 * - Input is the token draft before `id` is attached.
 * - Must return a string id for every call.
 * - Prefer deterministic output for stable rendering/diff behavior.
 *
 * @example
 * ```ts
 * const createId: CreateId = (token) =>
 *   token.type === "text" ? `txt:${String(token.value)}` : `tok:${token.type}`;
 * ```
 */
export type CreateId = (token: TokenDraft) => string;

/** Public parse error codes reported via `onError`. */
export type ErrorCode =
  | "DEPTH_LIMIT"
  | "UNEXPECTED_CLOSE"
  | "INLINE_NOT_CLOSED"
  | "SHORTHAND_NOT_CLOSED"
  | "BLOCK_NOT_CLOSED"
  | "BLOCK_CLOSE_MALFORMED"
  | "RAW_NOT_CLOSED"
  | "RAW_CLOSE_MALFORMED";

/** Structured parse error payload passed to `onError`. */
export interface ParseError {
  /** Machine-readable error code. */
  code: ErrorCode;
  /** Human-readable summary. */
  message: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Best-effort source snippet around the failing cursor. */
  snippet: string;
}

/** Runtime handlers for each supported tag form. */
export interface TagHandler {
  /** Inline-form handler (`$$tag(args)$$`). */
  inline?: (tokens: TextToken[], ctx?: DslContext) => TokenDraft;
  /** Raw-form handler (`$$tag(args)% ... %end$$`). */
  raw?: (arg: string | undefined, content: string, ctx?: DslContext) => TokenDraft;
  /** Block-form handler (`$$tag(args)* ... *end$$`). */
  block?: (arg: string | undefined, content: TextToken[], ctx?: DslContext) => TokenDraft;
}

/** Full syntax token set accepted by `createSyntax`. */
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

export interface TagNameConfig {
  /** Decide whether a character may start a tag name. */
  isTagStartChar: (char: string) => boolean;
  /** Decide whether a character may appear after the first tag-name character. */
  isTagChar: (char: string) => boolean;
}

/**
 * Lightweight context for public utility functions.
 *
 * Currently optional on all public APIs. When omitted:
 * - Builder utilities (`parsePipeArgs`, `splitTokensByPipe`, etc.) fall back to `getSyntax()`
 * - Escape utilities (`unescapeInline`, `readEscapedSequence`, etc.) also accept bare `SyntaxConfig`
 *   for internal scanner use, falling back to `getSyntax()` when omitted entirely
 * - `createToken` also accepts bare `CreateId` for internal context threading,
 *   falling back to `activeCreateId` / `tokenIdSeed` when omitted entirely
 *
 * Will become **required** in a future major version — adopt `DslContext` now
 * to prepare for the migration.
 */
export interface DslContext {
  /** Effective syntax in current parse/build context. */
  syntax: SyntaxConfig;
  /** Optional id generator override for token creation. */
  createId?: CreateId;
}

/** Supported structural tag forms. */
export type TagForm = "inline" | "raw" | "block";
/** Controls implicit inline shorthand parsing in inline arg context. */
export type InlineShorthandOption = boolean | readonly string[];

/** @internal Alias — same union, used for line-break normalization context. */
export type MultilineForm = TagForm;

/**
 * Entry for `blockTags` — either a plain tag name (all forms: raw + block + inline)
 * or an object restricting normalization to specific forms.
 *
 * @example
 * // All forms get normalization (raw + block + inline)
 * "center"
 *
 * // Only raw form gets normalization
 * { tag: "code", forms: ["raw"] }
 *
 * // Only inline form gets normalization (block-level rendering via inline syntax)
 * { tag: "center", forms: ["inline"] }
 */
export type BlockTagInput = string | { tag: string; forms?: readonly MultilineForm[] };

/**
 * Internal lookup that checks whether a tag receives line-break
 * normalization for a given multiline form.
 */
export interface BlockTagLookup {
  /** Returns whether the given `tag` should normalize line breaks for `form`. */
  has(tag: string, form: MultilineForm): boolean;
}

/**
 * Shared base options for both `parseRichText` and `parseStructural`.
 *
 * Contains everything related to tag recognition, form gating,
 * syntax configuration, and depth limiting.
 */
export interface ParserBaseOptions {
  /** Tag handler map – keys are tag names, values define how each tag is parsed. */
  handlers?: Record<string, TagHandler>;
  /**
   * Restrict which tag forms the parser will accept.
   * Forms not listed are treated as if the handler does not support them (graceful degradation).
   * Default: all forms enabled (`["inline", "raw", "block"]`).
   */
  allowForms?: readonly TagForm[];
  /**
   * Control implicit inline shorthand (`name(...)`) inside inline argument context.
   *
   * - `true`: enabled for every registered tag that supports inline form.
   * - `false`: disable shorthand entirely.
   * - `string[]`: enable shorthand only for listed tag names.
   *
   * Default: `false`.
   */
  implicitInlineShorthand?: InlineShorthandOption;
  /** Maximum nesting depth (default 50). */
  depthLimit?: number;
  /** Override DSL syntax tokens (default: `$$tag(…)$$` family). */
  syntax?: Partial<SyntaxInput>;
  /** Override how tag-name characters are recognized. */
  tagName?: Partial<TagNameConfig>;
  /**
   * Base offset added to all source positions when `trackPositions` is enabled.
   * Use this when parsing a substring that starts at a non-zero offset in the
   * original document — positions will be reported relative to the original source.
   *
   * When used alone, only `offset` is shifted; `line`/`column` are local to the substring.
   * For fully correct `line`/`column`, also pass a `tracker` built from the original
   * full document via `buildPositionTracker(fullText)`.
   *
   * Default: 0.
   */
  baseOffset?: number;
  /**
   * Pre-built position tracker from the original full document.
   * When provided together with `baseOffset`, all position fields (`offset`, `line`, `column`)
   * are resolved against the original document — not the substring being parsed.
   *
   * Build with `buildPositionTracker(fullText)`. Requires `trackPositions: true`.
   */
  tracker?: PositionTracker;
}

export interface ParseOptions extends ParserBaseOptions {
  /** Override token id generation for this parse. Defaults to a parse-local `rt-0`, `rt-1`, ... counter. */
  createId?: CreateId;
  /**
   * Tags that receive block-level line-break normalization.
   * Defaults to every tag whose handler has a `raw` or `block` parser.
   *
   * Each entry is either a plain tag name (normalization for both raw and
   * block forms) or `{ tag, forms }` to restrict normalization to specific
   * multiline forms.
   */
  blockTags?: readonly BlockTagInput[];
  /**
   * Parse mode. Currently only `"render"` is supported.
   * Use `parseStructural` for syntax-highlighting use cases.
   */
  mode?: "render";
  /** Called for every parse error. If omitted, errors are silently discarded. */
  onError?: (error: ParseError) => void;
  /** When true, attach source position info (`position`) to every TextToken. Default: false. */
  trackPositions?: boolean;
}

// ── Structural parse types ──

/**
 * A node in the structural parse tree.
 *
 * Unlike {@link TextToken}, this preserves the tag form (inline / raw / block)
 * and accepts any syntactically valid tag without handler registration.
 */
export type StructuralNode =
  | { type: "text"; value: string; position?: SourceSpan }
  | { type: "escape"; raw: string; position?: SourceSpan }
  | { type: "separator"; position?: SourceSpan }
  | {
      type: "inline";
      tag: string;
      children: StructuralNode[];
      /**
       * True when this inline node comes from implicit inline shorthand (`name(...)`)
       * inside an inline-arg context.
       */
      implicitInlineShorthand?: boolean;
      position?: SourceSpan;
    }
  | { type: "raw"; tag: string; args: StructuralNode[]; content: string; position?: SourceSpan }
  | {
      type: "block";
      tag: string;
      args: StructuralNode[];
      children: StructuralNode[];
      position?: SourceSpan;
    };

/**
 * Options for {@link parseStructural}.
 *
 * Extends {@link ParserBaseOptions} — shares tag recognition, form gating,
 * syntax, and depth-limit config with {@link ParseOptions}.
 *
 * When `handlers` is provided, gating rules are identical to `parseRichText`.
 * When omitted, all tags and forms are accepted.
 */
export interface StructuralParseOptions extends ParserBaseOptions {
  /** When true, attach source position info (`position`) to every StructuralNode. Default: false. */
  trackPositions?: boolean;
}

/**
 * Precomputed line-offset table for resolving string offsets into line/column positions.
 * Build with `buildPositionTracker(text)`.
 */
export interface PositionTracker {
  /** Resolve a string offset to absolute line/column coordinates. */
  resolve(offset: number): SourcePosition;
}

// ── Zone types ──

/**
 * A contiguous group of top-level structural nodes.
 *
 * Adjacent text / escape / separator / inline nodes merge into one zone.
 * Each top-level raw or block node gets a dedicated zone.
 *
 * Built by {@link buildZones}.
 */
export interface Zone {
  /** Start offset in the source text (inclusive). */
  startOffset: number;
  /** End offset in the source text (exclusive). */
  endOffset: number;
  /** The structural nodes belonging to this zone. */
  nodes: StructuralNode[];
}

// ── Incremental structural parse types ──

/**
 * Parse options used by incremental structural parsing.
 *
 * Position fields are always tracked internally and cannot be overridden.
 * `baseOffset` / `tracker` are also internal for incremental updates.
 * For better incremental reuse, keep `handlers` reference stable across edits.
 */
export type IncrementalParseOptions = Omit<
  StructuralParseOptions,
  "trackPositions" | "baseOffset" | "tracker"
>;

/**
 * Single text edit against the previous source.
 *
 * Offsets are based on the old source (`doc.source`) and `oldEndOffset` is exclusive.
 */
export interface IncrementalEdit {
  /** Start offset in the old source (inclusive). */
  startOffset: number;
  /** End offset in the old source (exclusive). */
  oldEndOffset: number;
  /** Replacement text inserted at `[startOffset, oldEndOffset)`. */
  newText: string;
}

/**
 * Cached document snapshot for incremental structural updates.
 */
export interface IncrementalDocument {
  /** Full source snapshot for this incremental state. */
  source: string;
  /** Top-level zones used for bounded reparsing. */
  zones: Zone[];
  /** Full structural tree of `source`. */
  tree: StructuralNode[];
  /** Optional parser config carried forward across updates. */
  parseOptions?: IncrementalParseOptions;
}

/** Error codes returned by low-level incremental update APIs. */
export type IncrementalUpdateErrorCode =
  | "INVALID_EDIT_RANGE"
  | "NEW_SOURCE_LENGTH_MISMATCH"
  | "EDIT_TEXT_MISMATCH"
  | "UNKNOWN";

/** Error object used by low-level incremental update APIs. */
export interface IncrementalUpdateError extends Error {
  /** Stable machine-readable failure code. */
  code: IncrementalUpdateErrorCode;
}

/** Discriminated result of one low-level incremental update attempt. */
export type IncrementalUpdateResult =
  | { ok: true; value: IncrementalDocument }
  | { ok: false; error: IncrementalUpdateError };

/**
 * Result mode returned by the high-level incremental session API.
 */
export type IncrementalSessionApplyMode = "incremental" | "full-fallback";

/** Strategy for high-level incremental sessions. */
export type IncrementalSessionStrategy = "auto" | "incremental-only" | "full-only";

/** Reasons recorded when session falls back to a full rebuild. */
export type IncrementalSessionFallbackReason =
  | IncrementalUpdateErrorCode
  | "INTERNAL_FULL_REBUILD"
  | "FULL_ONLY_STRATEGY"
  | "AUTO_COOLDOWN"
  | "AUTO_LARGE_EDIT";

/**
 * High-level session behavior tuning options.
 *
 * All numeric fields are optional safeguards/thresholds for adaptive fallback.
 */
export interface IncrementalSessionOptions {
  /** Session strategy selector. */
  strategy?: IncrementalSessionStrategy;
  /** Number of recent samples used by adaptive strategy. */
  sampleWindowSize?: number;
  /** Minimum samples before adaptive switching is evaluated. */
  minSamplesForAdaptation?: number;
  /** Allowed fallback ratio in `auto` mode before entering cooldown. */
  maxFallbackRate?: number;
  /** Threshold multiplier for preferring full rebuild over incremental path. */
  switchToFullMultiplier?: number;
  /** Cooldown edit count when `auto` mode temporarily prefers full rebuild. */
  fullPreferenceCooldownEdits?: number;
  /** Maximum single-edit size ratio still eligible for incremental update. */
  maxEditRatioForIncremental?: number;
  /**
   * Maximum number of non-breaker nodes per soft zone.
   *
   * Controls the granularity of incremental zone splitting for documents
   * that contain few or no raw/block nodes (e.g. pure inline text).
   * Smaller values produce more zones (finer incremental windows but higher
   * overhead); larger values produce fewer zones (coarser windows).
   *
   * @default 64
   */
  softZoneNodeCap?: number;
}

/**
 * Safe update result for one edit in an incremental session.
 *
 * - `mode: "incremental"` means the update path succeeded.
 * - `mode: "full-fallback"` means the session rebuilt from `newSource`.
 */
export interface IncrementalSessionApplyResult {
  /** Updated document snapshot after this operation. */
  doc: IncrementalDocument;
  /** Whether this call used incremental path or full fallback. */
  mode: IncrementalSessionApplyMode;
  /** Populated only when `mode === "full-fallback"`. */
  fallbackReason?: IncrementalSessionFallbackReason;
}

/** Token-index patch emitted by incremental token diff. */
export interface TokenDiffPatch {
  /** Patch kind over token-index ranges. */
  kind: "insert" | "remove" | "replace";
  /** Half-open range in previous token array. */
  oldRange: { start: number; end: number };
  /** Half-open range in next token array. */
  newRange: { start: number; end: number };
}

/** Matched unchanged token-index range pair (`old` ↔ `new`). */
export interface TokenDiffUnchangedRange {
  /** Half-open range in previous token array. */
  oldRange: { start: number; end: number };
  /** Half-open range in next token array. */
  newRange: { start: number; end: number };
}

/** Container kinds addressable by structural diff operations. */
export type StructuralDiffContainerField = "root" | "children" | "args";

/** One path step in a structural diff, identifying a node inside a container. */
export interface StructuralDiffPathSegment {
  /** Container traversed at this step. */
  field: StructuralDiffContainerField;
  /** Node index inside that container. */
  index: number;
}

/** Path from the root structural node array to a specific node. */
export type StructuralDiffPath = StructuralDiffPathSegment[];

/** Array splice inside the root tree or a node's `children` / `args`. */
export interface StructuralDiffSpliceOp {
  kind: "splice";
  /** Path to the owning node. Empty path means the root token array. */
  path: StructuralDiffPath;
  /** Which array container under `path` is being modified. */
  field: StructuralDiffContainerField;
  /** Half-open range in the previous container. */
  oldRange: { start: number; end: number };
  /** Half-open range in the next container. */
  newRange: { start: number; end: number };
  /** Previous nodes covered by the splice. */
  oldNodes: StructuralNode[];
  /** Next nodes covered by the splice. */
  newNodes: StructuralNode[];
}

/** Scalar text update on a `text` node. */
export interface StructuralDiffTextOp {
  kind: "set-text";
  /** Path to the target `text` node. */
  path: StructuralDiffPath;
  oldValue: string;
  newValue: string;
}

/** Scalar raw update on an `escape` node. */
export interface StructuralDiffEscapeOp {
  kind: "set-escape";
  /** Path to the target `escape` node. */
  path: StructuralDiffPath;
  oldValue: string;
  newValue: string;
}

/** Scalar content update on a `raw` node. */
export interface StructuralDiffRawContentOp {
  kind: "set-raw-content";
  /** Path to the target `raw` node. */
  path: StructuralDiffPath;
  oldValue: string;
  newValue: string;
}

/** Flag update on an `inline` node. */
export interface StructuralDiffInlineFlagOp {
  kind: "set-implicit-inline-shorthand";
  /** Path to the target `inline` node. */
  path: StructuralDiffPath;
  oldValue?: boolean;
  newValue?: boolean;
}

/** Path-aware structural operations emitted alongside range-based token diff. */
export type StructuralDiffOp =
  | StructuralDiffSpliceOp
  | StructuralDiffTextOp
  | StructuralDiffEscapeOp
  | StructuralDiffRawContentOp
  | StructuralDiffInlineFlagOp;

/** Diff summary for one edit between previous and next structural token trees. */
export interface TokenDiffResult {
  /** True when this edit produced no structural token changes (`patches` and `ops` are both empty). */
  isNoop: boolean;
  /** Minimal token-index patches needed to transform old tokens to new tokens. */
  patches: TokenDiffPatch[];
  /** Unchanged token-index ranges reused across this edit. */
  unchangedRanges: TokenDiffUnchangedRange[];
  /**
   * Path-aware structural operations for nested updates and container edits.
   *
   * Returned in descending path/index order (with same-path splices first), so
   * consumers can apply `ops` in array order without later splice targets being
   * invalidated by earlier index shifts.
   */
  ops: StructuralDiffOp[];
  /** Best-effort dirty span in previous source coordinates. */
  dirtySpanOld: { startOffset: number; endOffset: number };
  /** Best-effort dirty span in next source coordinates. */
  dirtySpanNew: { startOffset: number; endOffset: number };
}

/** Session apply result extended with token diff payload. */
export interface IncrementalSessionApplyWithDiffResult extends IncrementalSessionApplyResult {
  /** Token diff payload for this edit. */
  diff: TokenDiffResult;
}

/**
 * High-level incremental parsing session.
 *
 * Provides correctness-first semantics:
 * - Apply edits via incremental update when possible.
 * - Fall back to full rebuild when validation or update fails.
 */
export interface IncrementalSession {
  /** Return current in-memory incremental document snapshot. */
  getDocument: () => IncrementalDocument;
  /** Apply one edit and return updated snapshot with selected mode. */
  applyEdit: (
    edit: IncrementalEdit,
    newSource: string,
    options?: IncrementalParseOptions,
  ) => IncrementalSessionApplyResult;
  /** Apply one edit and return updated snapshot with structural token diff payload. */
  applyEditWithDiff: (
    edit: IncrementalEdit,
    newSource: string,
    options?: IncrementalParseOptions,
  ) => IncrementalSessionApplyWithDiffResult;
  /** Force a full rebuild from `newSource`. */
  rebuild: (newSource: string, options?: IncrementalParseOptions) => IncrementalDocument;
}

// ── Internal types (not re-exported from index) ──

/** Buffered text/segment state while scanning structural frames. */
export interface BufferState {
  /** Buffered range start in frame-local source. */
  start: number;
  /** Buffered range end in frame-local source. */
  end: number;
  /** Optional escaped-segment boundaries inside buffer. */
  segments: number[] | null;
}

/** Parsed result for a complete tag start token at cursor. */
export interface TagStartInfo {
  /** Parsed tag name. */
  tag: string;
  /** Cursor position of tag-open token. */
  tagOpenPos: number;
  /** End cursor of parsed tag-name span. */
  tagNameEnd: number;
  /** Start cursor of argument content. */
  argStart: number;
}

/** Minimal tag head info used by scanner helpers. */
export interface TagHead {
  /** Parsed tag name. */
  tag: string;
  /** Cursor position where tag starts. */
  tagStart: number;
  /** End cursor of parsed tag-name span. */
  tagNameEnd: number;
  /** Start cursor of argument content. */
  argStart: number;
}
