import type {
  BlockTagInput,
  BlockTagLookup,
  MultilineForm,
  ParseOptions,
  ParserBaseOptions,
  StructuralNode,
  StructuralParseOptions,
  TextToken,
} from "./types.js";
import { extractText } from "./builders.js";
import { withTagNameConfig } from "./chars.js";
import { withCreateId } from "./createToken.js";
import { printStructural } from "./print.js";
import { parseStructural, parseStructuralInternal } from "./structural.js";
import { withSyntax } from "./syntax.js";
import { renderNodes, type RenderContext } from "./render.js";
import { buildGatingContext, resolveBaseOptions } from "./resolveOptions.js";

// Re-export for backward compatibility and for structural.ts which imports from here.
export { filterHandlersByForms } from "./resolveOptions.js";

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

const deriveBlockTags = (handlers: Record<string, import("./types.js").TagHandler>): BlockTagLookup => {
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
  handlers: Record<string, import("./types.js").TagHandler>,
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
  syntax: import("./types.js").SyntaxConfig,
  tagName: import("./types.js").TagNameConfig,
  createId: import("./types.js").CreateId,
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

// ── Public API ──

export const parseRichText = (text: string, options: ParseOptions = {}): TextToken[] => {
  if (!text) return [];

  const { handlers, registeredTags, allowInline } = buildGatingContext(
    options.handlers ?? {},
    options.allowForms,
  );
  const blockTagSet = resolveBlockTags(handlers, options.blockTags);
  const { syntax, tagName, depthLimit, tracker } = resolveBaseOptions(text, options);
  let seed = 0;
  const createId = options.createId ?? (() => `rt-${seed++}`);

  const renderCtx: RenderContext = {
    source: text,
    handlers,
    registeredTags,
    allowInline,
    blockTagSet,
    tracker,
    syntax,
    createId,
  };

  // with* wrappers kept for backward compatibility: user handlers may call
  // public utilities (parsePipeArgs, createToken, unescapeInline, etc.) that
  // fall back to module-level state when no explicit config is passed.
  return withLegacyAmbientState(syntax, tagName, createId, () =>
    renderNodes(
      parseStructuralInternal(text, {
        handlers,
        allowForms: options.allowForms,
        depthLimit,
        syntax,
        tagName,
        tracker: options.tracker,
        baseOffset: options.baseOffset,
        trackPositions: options.trackPositions,
        onError: options.onError,
      }),
      renderCtx,
      "root",
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
  print: (nodes: StructuralNode[], overrides?: import("./print.js").PrintOptions) => string;
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
    print: (nodes, overrides) => {
      const syntax = overrides?.syntax && defaults.syntax
        ? { ...defaults.syntax, ...overrides.syntax }
        : overrides?.syntax ?? defaults.syntax;
      return printStructural(nodes, { syntax });
    },
  };
};
