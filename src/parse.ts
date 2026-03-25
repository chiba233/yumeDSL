import type { ParseContext, ParseOptions, TextToken } from "./types.js";
import { extractText } from "./builders.js";
import { tryConsumeEscape, tryConsumeTagClose, tryConsumeTagStart } from "./consumers.js";
import { finalizeUnclosedTags, flushBuffer } from "./context.js";
import { createSyntax, withSyntax } from "./syntax.js";

const deriveBlockTags = (handlers: Record<string, unknown>): Set<string> => {
  const set = new Set<string>();
  for (const [tag, handler] of Object.entries(handlers)) {
    const h = handler as Record<string, unknown>;
    if (h.raw || h.block) set.add(tag);
  }
  return set;
};

const internalParse = (
  text: string,
  depthLimit: number,
  options: { mode?: ParseContext["mode"] } | undefined,
  onError: ParseContext["onError"],
  handlers: Record<string, import("./types").TagHandler>,
  blockTagSet: ReadonlySet<string>,
): TextToken[] => {
  if (!text) return [];

  const ctx: ParseContext = {
    text,
    depthLimit,
    mode: options?.mode ?? "render",
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
    return internalParse(innerText, innerDepthLimit, innerOptions, onError, handlers, blockTagSet);
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

  const handlers = options.handlers ?? {};
  const blockTagSet = options.blockTags ? new Set(options.blockTags) : deriveBlockTags(handlers);
  const syntax = createSyntax(options.syntax);

  return withSyntax(syntax, () =>
    internalParse(
      text,
      options.depthLimit ?? 50,
      { mode: options.mode ?? "render" },
      options.onError,
      handlers,
      blockTagSet,
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
