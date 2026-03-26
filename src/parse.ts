import type { ParseContext, ParseOptions, TagForm, TagHandler, TextToken } from "./types.js";
import { extractText } from "./builders.js";
import { tryConsumeEscape, tryConsumeTagClose, tryConsumeTagStart } from "./consumers.js";
import { finalizeUnclosedTags, flushBuffer } from "./context.js";
import { withCreateId } from "./createToken.js";
import { createSyntax, withSyntax } from "./syntax.js";

const deriveBlockTags = (handlers: Record<string, unknown>): Set<string> => {
  const set = new Set<string>();
  for (const [tag, handler] of Object.entries(handlers)) {
    const h = handler as Record<string, unknown>;
    if (h.raw || h.block) set.add(tag);
  }
  return set;
};

/**
 * Filter handler methods by allowed tag forms.
 * Handlers that have no remaining methods after filtering are removed entirely,
 * so the parser treats those tags as unrecognized (graceful degradation).
 *
 * Passthrough handlers (empty `{}`) are treated as inline-form tags.
 */
const filterHandlersByForms = (
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
  blockTagSet: ReadonlySet<string>,
): TextToken[] => {
  if (!text) return [];

  const ctx: ParseContext = {
    text,
    depthLimit,
    mode: options?.mode ?? "render",
    allowInline,
    registeredTags,
    onError,
    handlers,
    blockTagSet,
    root: [],
    stack: [],
    buffer: "",
    i: 0,
  };

  const recursiveParse = (
    innerText: string,
    innerDepthLimit: number,
    innerOptions?: { mode?: ParseContext["mode"] },
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
    );
  };

  while (ctx.i < ctx.text.length) {
    if (tryConsumeTagStart(ctx, recursiveParse)) continue;
    if (tryConsumeTagClose(ctx)) continue;
    if (tryConsumeEscape(ctx)) continue;

    ctx.buffer += ctx.text[ctx.i];
    ctx.i++;
  }

  flushBuffer(ctx);
  finalizeUnclosedTags(ctx);
  return ctx.root;
};

export const parseRichText = (text: string, options: ParseOptions = {}): TextToken[] => {
  if (!text) return [];

  const rawHandlers = options.handlers ?? {};
  const registeredTags = new Set(Object.keys(rawHandlers));
  const handlers = options.allowForms
    ? filterHandlersByForms(rawHandlers, new Set(options.allowForms))
    : rawHandlers;
  const allowInline = !options.allowForms || options.allowForms.includes("inline");
  const blockTagSet = options.blockTags ? new Set(options.blockTags) : deriveBlockTags(handlers);
  const syntax = createSyntax(options.syntax);
  let seed = 0;
  const createId = options.createId ?? (() => `rt-${seed++}`);

  return withSyntax(syntax, () =>
    withCreateId(createId, () =>
      internalParse(
        text,
        options.depthLimit ?? 50,
        { mode: options.mode ?? "render" },
        allowInline,
        registeredTags,
        options.onError,
        handlers,
        blockTagSet,
      ),
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
}

export const createParser = (defaults: ParseOptions): Parser => ({
  parse: (text, overrides) =>
    parseRichText(text, overrides ? { ...defaults, ...overrides } : defaults),
  strip: (text, overrides) =>
    stripRichText(text, overrides ? { ...defaults, ...overrides } : defaults),
});
