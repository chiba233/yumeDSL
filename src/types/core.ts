import type { SyntaxInput, SyntaxConfig, TagNameConfig } from "./config.js";

// ── Source positions ──

/** Absolute source position used by `trackPositions` outputs. */
export interface SourcePosition {
  /** UTF-16 code-unit offset from the start of the original source. */
  offset: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number within the resolved line. */
  column: number;
}

/** Half-open source span (`start` inclusive, `end` exclusive). */
export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

/**
 * Precomputed line-offset table for resolving string offsets into line/column positions.
 * Build with `buildPositionTracker(text)`.
 */
export interface PositionTracker {
  /** Resolve a string offset to absolute line/column coordinates. */
  resolve(offset: number): SourcePosition;
}

// ── Tokens ──

/** Render token shape returned by `parseRichText`. */
export interface TextToken {
  /** Semantic token kind chosen by the matching handler. */
  type: string;
  /** Token payload: plain text or nested child tokens. */
  value: string | TextToken[];
  /** Stable token id used by renderers and diff-aware consumers. */
  id: string;
  /** Optional source span when `trackPositions` is enabled. */
  position?: SourceSpan;
  /** Extension slot for handler-defined metadata such as `url`, `lang`, or `title`. */
  [key: string]: unknown;
}

/** Token draft shape expected from handlers before `id` assignment. */
export interface TokenDraft {
  /** Semantic token kind chosen by the handler. */
  type: string;
  /** Draft payload before the parser attaches `id`. */
  value: string | TextToken[];
  /** Extension slot for handler-defined metadata. */
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

// ── Id generation ──

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

// ── Context ──

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

// ── Tag handling ──

/**
 * Runtime handlers for each supported tag form.
 *
 * A handler may implement any subset of forms. Missing forms degrade
 * gracefully: the parser keeps the original source as plain text rather than
 * throwing.
 */
export interface TagHandler {
  /** Inline-form handler (`$$tag(args)$$`). */
  inline?: (tokens: TextToken[], ctx?: DslContext) => TokenDraft;
  /** Raw-form handler (`$$tag(args)% ... %end$$`). */
  raw?: (arg: string | undefined, content: string, ctx?: DslContext) => TokenDraft;
  /** Block-form handler (`$$tag(args)* ... *end$$`). */
  block?: (arg: string | undefined, content: TextToken[], ctx?: DslContext) => TokenDraft;
}

/** Supported structural tag forms understood by the parser. */
export type TagForm = "inline" | "raw" | "block";
/**
 * Controls implicit inline shorthand parsing in inline-arg context.
 *
 * The shorthand form is `name(...)` without the normal `tagOpen` prefix.
 */
export type InlineShorthandOption = boolean | readonly string[];

/** @internal Alias — same union, used for line-break normalization context. */
export type MultilineForm = TagForm;

// ── Block tags ──

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

// ── Errors ──

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

/**
 * Structured parse error payload passed to `onError`.
 *
 * Errors are best-effort diagnostics: parsing continues with graceful
 * degradation whenever possible instead of aborting the whole document.
 */
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

// ── Parser options ──

/**
 * Shared base options for both `parseRichText` and `parseStructural`.
 *
 * Contains everything related to tag recognition, form gating,
 * syntax configuration, and depth limiting.
 */
export interface ParserBaseOptions {
  /**
   * Tag handler map keyed by tag name.
   *
   * When omitted, `parseRichText` treats every tag as unknown and `parseStructural`
   * accepts any syntactically valid tag without handler gating.
   */
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
  /**
   * Maximum nesting depth before the parser degrades deeper syntax to text.
   *
   * This protects against pathological nesting and accidental stack pressure.
   * Default: `50`.
   */
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
  /**
   * Called for every parse error that the parser decides to surface.
   *
   * Throwing inside `onError` does not abort parsing; the parser swallows the
   * callback failure and continues.
   */
  onError?: (error: ParseError) => void;
  /** When true, attach source position info (`position`) to every TextToken. Default: false. */
  trackPositions?: boolean;
}
