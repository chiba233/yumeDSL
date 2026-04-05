// ── Public types ──

export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

export interface TextToken {
  type: string;
  value: string | TextToken[];
  id: string;
  position?: SourceSpan;
  [key: string]: unknown;
}

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

export type CreateId = (token: TokenDraft) => string;

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
  inline?: (tokens: TextToken[], ctx?: DslContext) => TokenDraft;
  raw?: (arg: string | undefined, content: string, ctx?: DslContext) => TokenDraft;
  block?: (arg: string | undefined, content: TextToken[], ctx?: DslContext) => TokenDraft;
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
  syntax: SyntaxConfig;
  createId?: CreateId;
}

export type TagForm = "inline" | "raw" | "block";

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
  | { type: "inline"; tag: string; children: StructuralNode[]; position?: SourceSpan }
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

// ── Internal types (not re-exported from index) ──


export interface BufferState {
  content: string;
  start: number;
}


export interface TagStartInfo {
  tag: string;
  tagOpenPos: number;
  tagNameEnd: number;
  argStart: number;
}


export interface TagHead {
  tag: string;
  tagStart: number;
  tagNameEnd: number;
  argStart: number;
}
