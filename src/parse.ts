import type {
  BlockTagInput,
  BlockTagLookup,
  CreateId,
  MultilineForm,
  ParseContext,
  ParseOptions,
  ParserBaseOptions,
  StructuralNode,
  StructuralParseOptions,
  SyntaxConfig,
  TagNameConfig,
  TextToken,
} from "./types.js";
import { extractText } from "./builders.js";
import { withTagNameConfig } from "./chars.js";
import { tryConsumeEscape, tryConsumeTagClose, tryConsumeTagStart } from "./consumers.js";
import { emptyBuffer, appendToBuffer, finalizeUnclosedTags, flushBuffer } from "./context.js";
import { withCreateId } from "./createToken.js";
import { printStructural } from "./print.js";
import { parseStructural } from "./structural.js";
import { withSyntax } from "./syntax.js";
import { type PositionTracker } from "./types.ts";
import { buildGatingContext, resolveBaseOptions } from "./resolveOptions.js";

const buildBlockTagLookup = (inputs: readonly BlockTagInput[]): BlockTagLookup => {
  const rawSet = new Set<string>();
  const blockSet = new Set<string>();
  const inlineSet = new Set<string>();
  for (const input of inputs) {
    if (typeof input === "string") {
      rawSet.add(input);
      blockSet.add(input);
      inlineSet.add(input);
    } else {
      const forms: readonly MultilineForm[] = input.forms ?? ["raw", "block"];
      for (const form of forms) {
        if (form === "raw") rawSet.add(input.tag);
        else if (form === "block") blockSet.add(input.tag);
        else inlineSet.add(input.tag);
      }
    }
  }
  return {
    has: (tag: string, form: MultilineForm) =>
      form === "raw" ? rawSet.has(tag) : form === "block" ? blockSet.has(tag) : inlineSet.has(tag),
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
  // inline is never auto-derived — the parser cannot know rendering intent.
  // Users must explicitly declare inline normalization via blockTags.
  return {
    has: (tag: string, form: MultilineForm) =>
      form === "raw" ? rawSet.has(tag) : form === "block" ? blockSet.has(tag) : false,
  };
};

/**
 * Filter handler methods by allowed tag forms.
 * Handlers that have no remaining methods after filtering are removed entirely,
 * so the parser treats those tags as unrecognized (graceful degradation).
 *
 * Passthrough handlers (empty `{}`) are treated as inline-form tags.
 */
// Re-export for backward compatibility and for structural.ts which imports from here.
export { filterHandlersByForms } from "./resolveOptions.js";

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
  print: (nodes: StructuralNode[]) => string;
}

export const createParser = (defaults: ParseOptions): Parser => {
  const merge = <T extends ParserBaseOptions>(overrides: T): ParseOptions & T => {
    const merged: ParseOptions & T = { ...defaults, ...overrides };
    if (defaults.syntax && overrides.syntax) {
      merged.syntax = { ...defaults.syntax, ...overrides.syntax };
    }
    if (defaults.tagName && overrides.tagName) {
      merged.tagName = { ...defaults.tagName, ...overrides.tagName };
    }
    return merged;
  };

  return {
    parse: (text, overrides) =>
      parseRichText(text, overrides ? merge(overrides) : defaults),
    strip: (text, overrides) =>
      stripRichText(text, overrides ? merge(overrides) : defaults),
    structural: (text, overrides) =>
      parseStructural(text, overrides ? merge(overrides) : defaults),
    print: (nodes) =>
      printStructural(nodes, { syntax: defaults.syntax }),
  };
};
