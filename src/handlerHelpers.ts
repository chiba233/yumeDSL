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
export const createPassthroughTags = (names: readonly string[]): Record<string, TagHandler> => {
  const result: Record<string, TagHandler> = {};
  for (const name of names) {
    result[name] = {};
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
export const createSimpleInlineHandlers = (
  names: readonly string[],
): Record<string, TagHandler> => {
  const result: Record<string, TagHandler> = {};
  for (const name of names) {
    result[name] = {
      inline: (tokens: TextToken[]): TokenDraft => ({
        type: name,
        value: materializeTextTokens(tokens),
      }),
    };
  }
  return result;
};
