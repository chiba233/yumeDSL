import type { TagHandler, TextToken, TokenDraft } from "./types.js";
import { materializeTextTokens } from "./builders.js";

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
