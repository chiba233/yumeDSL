import type {
  BlockTagInput,
  BlockTagLookup,
  MultilineForm,
  ParseOptions,
  ParserBaseOptions,
  StructuralNode,
  StructuralParseOptions,
  TextToken,
} from "../types";
import { extractText } from "../handlerBuilders/builders.js";
import { withTagNameConfig } from "../config/chars.js";
import { withCreateId } from "../handlerBuilders/createToken.js";
import { printStructural } from "../internal/print.js";
import { parseStructural, parseStructuralWithResolved } from "./structural.js";
import { withSyntax } from "../config/syntax.js";
import { type RenderContext, renderNodes } from "./render.js";
import {
  type BaseResolvedConfig,
  buildGatingContext,
  type GatingContext,
  resolveBaseOptions,
} from "../config/resolveOptions.js";

// Re-export for backward compatibility and for structural.ts which imports from here.
export { filterHandlersByForms } from "../config/resolveOptions.js";

// ── Block tag resolution ──

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

const deriveBlockTags = (
  handlers: Record<string, import("../types/index.js").TagHandler>,
): BlockTagLookup => {
  const rawSet = new Set<string>();
  const blockSet = new Set<string>();
  for (const [tag, handler] of Object.entries(handlers)) {
    if (handler.raw) rawSet.add(tag);
    if (handler.block) blockSet.add(tag);
  }
  // inline is never auto-derived — the parser cannot know rendering intent.
  // Users must explicitly declare inline normalization via blockTags.
  return {
    has: (tag: string, form: MultilineForm) =>
      form === "raw" ? rawSet.has(tag) : form === "block" ? blockSet.has(tag) : false,
  };
};

/**
 * Merge user-declared blockTags on top of auto-derived ones.
 *
 * - Auto-derivation always runs as the base.
 * - For tags explicitly listed in `userTags`, the user's declaration
 *   completely replaces auto-derivation for that tag.
 * - Tags not mentioned in `userTags` keep auto-derived behavior.
 */
const resolveBlockTags = (
  handlers: Record<string, import("../types/index.js").TagHandler>,
  userTags: readonly BlockTagInput[] | undefined,
): BlockTagLookup => {
  const derived = deriveBlockTags(handlers);
  if (!userTags || userTags.length === 0) return derived;

  const userLookup = buildBlockTagLookup(userTags);
  const userDeclared = new Set<string>();
  for (const input of userTags) {
    userDeclared.add(typeof input === "string" ? input : input.tag);
  }

  return {
    has: (tag: string, form: MultilineForm) =>
      userDeclared.has(tag) ? userLookup.has(tag, form) : derived.has(tag, form),
  };
};

// ── Legacy ambient state ──

/** Set legacy ambient state for backward-compatible handler support, suppressing deprecation warnings. */
const withLegacyAmbientState = <T>(
  syntax: import("../types/index.js").SyntaxConfig,
  tagName: import("../types/index.js").TagNameConfig,
  createId: import("../types/index.js").CreateId,
  fn: () => T,
): T => {
  // 注意：这是 compat 隔离层，不是扩功能的入口。
  // 用户旧 handler 里那些不传 ctx 的 utility 还活着，全靠这里临时灌 ambient state。
  // 如果把这层拿掉，或者漏包一个维度，legacy handler 会静悄悄产出错误的 syntax / tagName / id。
  const suppress = { suppressDeprecation: true };
  return withSyntax(
    syntax,
    () => withTagNameConfig(tagName, () => withCreateId(createId, fn, suppress), suppress),
    suppress,
  );
};

// ── Public API ──

// 硬规则，后面重构别再碰这条线：
// 1. 不要试图统一 parseRichText.position 和 parseStructural.position
// 2. 可以共享基础配置、gating、tracker
// 3. 不可以共享最终 span 结算
//
// structural 负责“源码真相”；
// render 负责“规范化后的渲染真相”。
// parseRichText 这里只复用 structural 的扫描结果，不复用它的最终位置语义。

interface ParsePipelineBase {
  gating: GatingContext;
  blockTagSet: BlockTagLookup;
  resolved: BaseResolvedConfig;
}

import type { CreateIdWithLifecycle } from "../internal/stableId.js";
import { BEGIN_PARSE, END_PARSE } from "../internal/stableId.js";

const withCreateIdParseLifecycle = <T>(
  createId: import("../types/index.js").CreateId,
  fn: () => T,
): T => {
  const lifecycle = createId as CreateIdWithLifecycle;
  lifecycle[BEGIN_PARSE]?.();
  try {
    return fn();
  } finally {
    lifecycle[END_PARSE]?.();
  }
};

const resolveParsePipelineBase = (text: string, options: ParseOptions): ParsePipelineBase => {
  const gating = buildGatingContext(
    options.handlers ?? {},
    options.allowForms,
    options.implicitInlineShorthand,
  );
  return {
    gating,
    blockTagSet: resolveBlockTags(gating.handlers, options.blockTags),
    resolved: resolveBaseOptions(text, options),
  };
};

const createRenderContextFromBase = (
  text: string,
  base: ParsePipelineBase,
  createId: import("../types/index.js").CreateId,
): RenderContext => {
  // 这里故意只拿 tracker，不拿 structural 的最终 span。
  // 同一个 tracker 只说明“坐标查表来源一样”，不说明“position 语义一样”。
  return {
    source: text,
    handlers: base.gating.handlers,
    registeredTags: base.gating.registeredTags,
    allowInline: base.gating.allowInline,
    blockTagSet: base.blockTagSet,
    tracker: base.resolved.tracker,
    syntax: base.resolved.syntax,
    createId,
  };
};

/**
 * Parse DSL source into render-ready rich-text tokens.
 *
 * This is the primary public entry for runtime rendering.
 *
 * @example
 * ```ts
 * const tokens = parseRichText("=bold<hello>=", {
 *   handlers: { bold: { inline: (tokens) => ({ type: "bold", value: tokens }) } },
 * });
 * ```
 */
export const parseRichText = (text: string, options: ParseOptions = {}): TextToken[] => {
  if (!text) return [];

  const base = resolveParsePipelineBase(text, options);
  let seed = 0;
  const createId = options.createId ?? (() => `rt-${seed++}`);
  const renderCtx = createRenderContextFromBase(text, base, createId);

  // with* wrappers kept for backward compatibility: user handlers may call
  // public utilities (parsePipeArgs, createToken, unescapeInline, etc.) that
  // fall back to module-level state when no explicit config is passed.
  return withCreateIdParseLifecycle(createId, () =>
    withLegacyAmbientState(base.resolved.syntax, base.resolved.tagName, createId, () =>
      renderNodes(
        parseStructuralWithResolved(text, base.resolved, base.gating, options.onError),
        renderCtx,
        "root",
      ),
    ),
  );
};

/**
 * Parse then extract plain text from the resulting token tree.
 *
 * Equivalent to `extractText(parseRichText(text, options))`.
 *
 * @example
 * ```ts
 * const plain = stripRichText("=bold<hello>=");
 * // "hello"
 * ```
 */
export const stripRichText = (text: string, options: ParseOptions = {}): string => {
  if (!text) return "";
  const tokens = parseRichText(text, options);
  return extractText(tokens);
};

/** Convenience parser facade with reusable default options. */
export interface Parser {
  /** Parse source into rich-text tokens. */
  parse: (text: string, overrides?: ParseOptions) => TextToken[];
  /** Parse source and return plain text only. */
  strip: (text: string, overrides?: ParseOptions) => string;
  /** Parse source into structural nodes (form-preserving AST). */
  structural: (text: string, overrides?: StructuralParseOptions) => StructuralNode[];
  /** Serialize structural nodes back to DSL source. */
  print: (nodes: StructuralNode[], overrides?: import("../internal/print.js").PrintOptions) => string;
}

/**
 * Create a reusable parser facade bound to `defaults`.
 *
 * @example
 * ```ts
 * const parser = createParser({ handlers });
 * const ast = parser.structural("=bold<hello>=");
 * const text = parser.strip("=bold<hello>=");
 * ```
 */
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
    parse: (text, overrides) => parseRichText(text, overrides ? merge(overrides) : defaults),
    strip: (text, overrides) => stripRichText(text, overrides ? merge(overrides) : defaults),
    structural: (text, overrides) => parseStructural(text, overrides ? merge(overrides) : defaults),
    print: (nodes, overrides) => {
      const syntax =
        overrides?.syntax && defaults.syntax
          ? { ...defaults.syntax, ...overrides.syntax }
          : (overrides?.syntax ?? defaults.syntax);
      return printStructural(nodes, { syntax });
    },
  };
};
