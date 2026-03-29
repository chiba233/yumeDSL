import type { BlockTagInput, DslContext, TagHandler, TextToken, TokenDraft } from "./types.js";
import type { PipeArgs } from "./builders.js";
import { materializeTextTokens, parsePipeArgs, parsePipeTextArgs } from "./builders.js";

/**
 * Create passthrough tag handlers that simply register tag names
 * so they are recognized by the parser. The default finalization
 * produces `{ type: tagName, value: materializedTokens }`.
 *
 * @example
 * const handlers = {
 *   ...createPassthroughTags(["bold", "italic"]),
 *   // other handlers …
 * };
 */
export const createPassthroughTags = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => {
  const result = {} as Record<T[number], TagHandler>;
  for (const name of names) {
    result[name as T[number]] = {};
  }
  return result;
};

/**
 * Create simple inline-only tag handlers that materialize their
 * child tokens and wrap them in `{ type, value }`.
 *
 * @example
 * const handlers = {
 *   ...createSimpleInlineHandlers(["bold", "italic", "underline"]),
 *   // other handlers …
 * };
 */
export const createSimpleInlineHandlers = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => {
  const result = {} as Record<T[number], TagHandler>;
  for (const name of names) {
    result[name as T[number]] = {
      inline: (tokens: TextToken[], ctx?: DslContext): TokenDraft => ({
        type: name,
        value: materializeTextTokens(tokens, ctx),
      }),
    };
  }
  return result;
};

/**
 * Declare which already-registered tags are multiline types.
 * Returns a `BlockTagInput[]` to pass as `ParseOptions.blockTags`.
 *
 * Tags listed here receive line-break normalization:
 * the parser strips the leading `\n` after `)*` / `)%` openers
 * and the trailing `\n` before `*end$$` / `%end$$` closers.
 *
 * Each entry is either a plain tag name (normalization for **both**
 * raw and block forms — backward compatible) or an object with a
 * `forms` array to restrict normalization to specific multiline forms.
 *
 * This does NOT register tags or create handlers — use
 * `createSimpleInlineHandlers`, `createSimpleRawHandlers`,
 * or custom handlers for that.
 *
 * @example
 * const dsl = createParser({
 *   handlers: { ... },
 *   // backward compatible — all multiline forms normalized
 *   blockTags: declareMultilineTags(["info", "warning", "collapse"]),
 * });
 *
 * @example
 * const dsl = createParser({
 *   handlers: { ... },
 *   // granular — code only normalizes in raw form
 *   blockTags: declareMultilineTags([
 *     "info",
 *     { tag: "code", forms: ["raw"] },
 *   ]),
 * });
 */
export const declareMultilineTags = <const T extends readonly BlockTagInput[]>(
  names: T,
): BlockTagInput[] => [...names];

/**
 * Create simple block-only tag handlers (DSL block form: `)*...*end$$`).
 * Each handler passes through the arg and recursively-parsed content:
 * `{ type: tagName, arg, value: content }`.
 *
 * @example
 * const handlers = {
 *   ...createSimpleBlockHandlers(["info", "warning", "collapse"]),
 * };
 */
export const createSimpleBlockHandlers = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => {
  const result = {} as Record<T[number], TagHandler>;
  for (const name of names) {
    result[name as T[number]] = {
      block: (arg: string | undefined, content: TextToken[]): TokenDraft => ({
        type: name,
        arg,
        value: content,
      }),
    };
  }
  return result;
};

/**
 * Create simple raw-only tag handlers.
 * Each handler passes through the arg and raw string content as-is:
 * `{ type: tagName, arg, value: content }`.
 *
 * @example
 * const handlers = {
 *   ...createSimpleRawHandlers(["code", "math"]),
 * };
 */
export const createSimpleRawHandlers = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => {
  const result = {} as Record<T[number], TagHandler>;
  for (const name of names) {
    result[name as T[number]] = {
      raw: (arg: string | undefined, content: string): TokenDraft => ({
        type: name,
        arg,
        value: content,
      }),
    };
  }
  return result;
};

export interface PipeHandlerDefinition {
  inline?: (args: PipeArgs, ctx?: DslContext) => TokenDraft;
  raw?: (args: PipeArgs, content: string, ctx?: DslContext, rawArg?: string) => TokenDraft;
  block?: (args: PipeArgs, content: TextToken[], ctx?: DslContext, rawArg?: string) => TokenDraft;
}

/**
 * Create handlers whose `arg` / inline tokens are pre-parsed as `PipeArgs`.
 *
 * Supports any combination of `inline`, `raw`, and `block` for each tag.
 *
 * @example
 * const handlers = createPipeHandlers({
 *   link: {
 *     inline: (args) => ({ type: "link", url: args.text(0), value: args.materializedTailTokens(1) }),
 *   },
 *   panel: {
 *     block: (args, content) => ({ type: "panel", args: args.parts.map((_, i) => args.text(i)), value: content }),
 *   },
 * });
 */
export const createPipeHandlers = <
  const T extends Record<string, PipeHandlerDefinition>,
>(
  definitions: T,
): { [K in keyof T]: TagHandler } => {
  const result = {} as { [K in keyof T]: TagHandler };

  const keys = Object.keys(definitions) as (keyof T)[];
  for (const key of keys) {
    const definition = definitions[key];
    const handler: TagHandler = {};

    if (definition.inline) {
      handler.inline = (tokens: TextToken[], ctx?: DslContext): TokenDraft =>
        definition.inline!(parsePipeArgs(tokens, ctx), ctx);
    }

    if (definition.raw) {
      handler.raw = (arg: string | undefined, content: string, ctx?: DslContext): TokenDraft =>
        definition.raw!(parsePipeTextArgs(arg ?? "", ctx), content, ctx, arg);
    }

    if (definition.block) {
      handler.block = (
        arg: string | undefined,
        content: TextToken[],
        ctx?: DslContext,
      ): TokenDraft => definition.block!(parsePipeTextArgs(arg ?? "", ctx), content, ctx, arg);
    }

    result[key] = handler;
  }

  return result;
};

type PipeFormHandler = (args: PipeArgs, content: TextToken[] | string, ctx: DslContext, rawArg: string) => TokenDraft;

const createPipeFormHandlers = <const T extends readonly string[]>(
  tagNames: T,
  form: "block" | "raw",
): Record<T[number], TagHandler> => {
  const definitions = {} as Record<T[number], PipeHandlerDefinition>;
  for (const tagName of tagNames) {
    const handler: PipeFormHandler = (pipeArgs, content, _ctx, rawArg) => ({
      type: tagName,
      arg: rawArg,
      args: pipeArgs.parts.map((_: unknown, index: number) => pipeArgs.text(index)),
      value: content,
    });
    definitions[tagName as T[number]] = { [form]: handler };
  }
  return createPipeHandlers(definitions);
};

/**
 * Create block handlers that split the arg by pipe and expose both
 * the original arg and structured `args` array:
 * `{ type: tagName, arg, args, value: content }`.
 */
export const createPipeBlockHandlers = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => createPipeFormHandlers(names, "block");

/**
 * Create raw handlers that split the arg by pipe and expose both
 * the original arg and structured `args` array:
 * `{ type: tagName, arg, args, value: content }`.
 */
export const createPipeRawHandlers = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => createPipeFormHandlers(names, "raw");
