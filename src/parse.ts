import type {
  BlockTagInput,
  BlockTagLookup,
  CreateId,
  MultilineForm,
  ParseContext,
  ParseOptions,
  StructuralNode,
  StructuralParseOptions,
  SyntaxConfig,
  TagForm,
  TagHandler,
  TagNameConfig,
  TextToken,
} from "./types.js";
import { extractText } from "./builders.js";
import { withTagNameConfig } from "./chars.js";
import { tryConsumeEscape, tryConsumeTagClose, tryConsumeTagStart } from "./consumers.js";
import { emptyBuffer, appendToBuffer, finalizeUnclosedTags, flushBuffer } from "./context.js";
import { withCreateId } from "./createToken.js";
import { parseStructural } from "./structural.js";
import { withSyntax } from "./syntax.js";
import { type PositionTracker } from "./positions.js";
import { buildGatingContext, resolveBaseOptions } from "./resolveOptions.js";

const buildBlockTagLookup = (inputs: readonly BlockTagInput[]): BlockTagLookup => {
  const rawSet = new Set<string>();
  const blockSet = new Set<string>();
  for (const input of inputs) {
    if (typeof input === "string") {
      rawSet.add(input);
      blockSet.add(input);
    } else {
      const forms: readonly MultilineForm[] = input.forms ?? ["raw", "block"];
      for (const form of forms) {
        if (form === "raw") rawSet.add(input.tag);
        else blockSet.add(input.tag);
      }
    }
  }
  return {
    has: (tag: string, form: MultilineForm) =>
      form === "raw" ? rawSet.has(tag) : blockSet.has(tag),
  };
};

const deriveBlockTags = (handlers: Record<string, unknown>): BlockTagLookup => {
  const rawSet = new Set<string>();
  const blockSet = new Set<string>();
  for (const [tag, handler] of Object.entries(handlers)) {
    const h = handler as Record<string, unknown>;
    if (h.raw) rawSet.add(tag);
    if (h.block) blockSet.add(tag);
  }
  return {
    has: (tag: string, form: MultilineForm) =>
      form === "raw" ? rawSet.has(tag) : blockSet.has(tag),
  };
};

/**
 * Filter handler methods by allowed tag forms.
 * Handlers that have no remaining methods after filtering are removed entirely,
 * so the parser treats those tags as unrecognized (graceful degradation).
 *
 * Passthrough handlers (empty `{}`) are treated as inline-form tags.
 */
export const filterHandlersByForms = (
  handlers: Record<string, TagHandler>,
  forms: ReadonlySet<TagForm>,
): Record<string, TagHandler> => {
  const allowInline = forms.has("inline");
  const allowRaw = forms.has("raw");
  const allowBlock = forms.has("block");

  const result: Record<string, TagHandler> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    const hasInline = !!handler.inline;
    const hasRaw = !!handler.raw;
    const hasBlock = !!handler.block;
    const isPassthrough = !hasInline && !hasRaw && !hasBlock;

    // Passthrough handlers work through the inline code path
    if (isPassthrough) {
      if (allowInline) result[name] = handler;
      continue;
    }

    const filtered: TagHandler = {};
    if (allowInline && hasInline) filtered.inline = handler.inline;
    if (allowRaw && hasRaw) filtered.raw = handler.raw;
    if (allowBlock && hasBlock) filtered.block = handler.block;

    if (filtered.inline || filtered.raw || filtered.block) {
      result[name] = filtered;
    }
  }
  return result;
};

const internalParse = (
  text: string,
  depthLimit: number,
  options: { mode?: ParseContext["mode"] } | undefined,
  allowInline: boolean,
  registeredTags: ReadonlySet<string>,
  onError: ParseContext["onError"],
  handlers: Record<string, import("./types").TagHandler>,
  blockTagSet: BlockTagLookup,
  tracker: PositionTracker | null,
  syntax: import("./types").SyntaxConfig,
  tagName: import("./types").TagNameConfig,
  createId: import("./types").CreateId,
): TextToken[] => {
  if (!text) return [];

  // 注意：这是 render parser 的主状态机。
  // 真正会变的内部状态只有四块：`ctx.i`（扫描指针）、`ctx.buf`（文本缓冲）、
  // `ctx.stack`（未闭合 inline 栈）、`ctx.root`（当前层输出）。
  // 改这里时先想清楚“消费了多少源码”和“文本最终落到哪一层”，
  // 否则最先炸的是未闭合退化、相邻 text 合并、以及 position 对齐。
  const ctx: ParseContext = {
    text,
    depthLimit,
    mode: options?.mode ?? "render",
    allowInline,
    registeredTags,
    onError,
    handlers,
    blockTagSet,
    tracker,
    syntax,
    tagName,
    createId,
    root: [],
    stack: [],
    buf: emptyBuffer(),
    i: 0,
  };

  const recursiveParse = (
    innerText: string,
    innerDepthLimit: number,
    innerOptions?: { mode?: ParseContext["mode"] },
    innerTracker?: PositionTracker | null,
  ): TextToken[] => {
    return internalParse(
      innerText,
      innerDepthLimit,
      innerOptions,
      allowInline,
      registeredTags,
      onError,
      handlers,
      blockTagSet,
      innerTracker !== undefined ? innerTracker : tracker,
      syntax,
      tagName,
      createId,
    );
  };

  // 注意：这里的处理顺序不是装饰性的。
  // tag-start / tag-close / escape 都可能一次消费多个字符，
  // 只有三者都不命中时，当前字符才作为普通文本塞进 buffer。
  // 顺序乱了以后，边界恢复和源码位置都会跟着错。
  while (ctx.i < ctx.text.length) {
    if (tryConsumeTagStart(ctx, recursiveParse)) continue;
    if (tryConsumeTagClose(ctx)) continue;
    if (tryConsumeEscape(ctx)) continue;

    appendToBuffer(ctx, ctx.text[ctx.i], ctx.i);
    ctx.i++;
  }

  flushBuffer(ctx);
  finalizeUnclosedTags(ctx);
  return ctx.root;
};

/** Set legacy ambient state for backward-compatible handler support, suppressing deprecation warnings. */
const withLegacyAmbientState = <T>(
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
  createId: CreateId,
  fn: () => T,
): T => {
  // 注意：这是 compat 隔离层，不是扩功能的入口。
  // 用户旧 handler 里那些不传 ctx 的 utility 还活着，全靠这里临时灌 ambient state。
  // 如果把这层拿掉，或者漏包一个维度，legacy handler 会静悄悄产出错误的 syntax / tagName / id。
  const suppress = { suppressDeprecation: true };
  return withSyntax(syntax, () =>
    withTagNameConfig(tagName, () =>
      withCreateId(createId, fn, suppress),
    suppress),
  suppress);
};

export const parseRichText = (text: string, options: ParseOptions = {}): TextToken[] => {
  if (!text) return [];

  const { handlers, registeredTags, allowInline } = buildGatingContext(
    options.handlers ?? {},
    options.allowForms,
    filterHandlersByForms,
  );
  const blockTagSet = options.blockTags
    ? buildBlockTagLookup(options.blockTags)
    : deriveBlockTags(handlers);
  const { syntax, tagName, depthLimit, tracker } = resolveBaseOptions(text, options);
  let seed = 0;
  const createId = options.createId ?? (() => `rt-${seed++}`);

  // with* wrappers kept for backward compatibility: user handlers may call
  // public utilities (parsePipeArgs, createToken, unescapeInline, etc.) that
  // fall back to module-level state when no explicit config is passed.
  return withLegacyAmbientState(syntax, tagName, createId, () =>
    internalParse(
      text,
      depthLimit,
      { mode: options.mode ?? "render" },
      allowInline,
      registeredTags,
      options.onError,
      handlers,
      blockTagSet,
      tracker,
      syntax,
      tagName,
      createId,
    ),
  );
};

export const stripRichText = (text: string, options: ParseOptions = {}): string => {
  if (!text) return "";
  const tokens = parseRichText(text, options);
  return extractText(tokens);
};

export interface Parser {
  parse: (text: string, overrides?: ParseOptions) => TextToken[];
  strip: (text: string, overrides?: ParseOptions) => string;
  structural: (text: string, overrides?: StructuralParseOptions) => StructuralNode[];
}

export const createParser = (defaults: ParseOptions): Parser => ({
  parse: (text, overrides) =>
    parseRichText(text, overrides ? { ...defaults, ...overrides } : defaults),
  strip: (text, overrides) =>
    stripRichText(text, overrides ? { ...defaults, ...overrides } : defaults),
  structural: (text, overrides) =>
    parseStructural(text, overrides ? { ...defaults, ...overrides } : defaults),
});
