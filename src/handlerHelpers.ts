import type { BlockTagInput, TagHandler, TextToken, TokenDraft } from "./types.js";
import { materializeTextTokens, parsePipeTextList } from "./builders.js";

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
      inline: (tokens: TextToken[]): TokenDraft => ({
        type: name,
        value: materializeTextTokens(tokens),
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

/**
 * Create block handlers that split the arg by pipe and expose both
 * the original arg and structured `args` array:
 * `{ type: tagName, arg, args, value: content }`.
 */
export const createPipeBlockHandlers = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => {
  const result = {} as Record<T[number], TagHandler>;
  for (const name of names) {
    result[name as T[number]] = {
      block: (arg: string | undefined, content: TextToken[]): TokenDraft => ({
        type: name,
        arg,
        args: arg === undefined ? [] : parsePipeTextList(arg),
        value: content,
      }),
    };
  }
  return result;
};

/**
 * Create raw handlers that split the arg by pipe and expose both
 * the original arg and structured `args` array:
 * `{ type: tagName, arg, args, value: content }`.
 */
export const createPipeRawHandlers = <const T extends readonly string[]>(
  names: T,
): Record<T[number], TagHandler> => {
  const result = {} as Record<T[number], TagHandler>;
  for (const name of names) {
    result[name as T[number]] = {
      raw: (arg: string | undefined, content: string): TokenDraft => ({
        type: name,
        arg,
        args: arg === undefined ? [] : parsePipeTextList(arg),
        value: content,
      }),
    };
  }
  return result;
};
