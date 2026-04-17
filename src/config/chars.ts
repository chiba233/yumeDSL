import type { TagNameConfig } from "../types";
import { warnDeprecated } from "../internal/deprecations.js";

const defaultIsTagStartChar = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const defaultIsTagChar = (c: string) =>
  (c >= "a" && c <= "z") ||
  (c >= "A" && c <= "Z") ||
  (c >= "0" && c <= "9") ||
  c === "_" ||
  c === "-";

/**
 * Default tag-name character rules.
 *
 * @example
 * ```ts
 * DEFAULT_TAG_NAME.isTagStartChar("a"); // true
 * DEFAULT_TAG_NAME.isTagStartChar("1"); // false
 * ```
 */
export const DEFAULT_TAG_NAME: TagNameConfig = {
  isTagStartChar: defaultIsTagStartChar,
  isTagChar: defaultIsTagChar,
};

/**
 * Build tag-name rules by shallow-merging overrides onto `DEFAULT_TAG_NAME`.
 *
 * @example
 * ```ts
 * const tagName = createTagNameConfig({
 *   isTagStartChar: (c) => /[a-z0-9]/i.test(c),
 * });
 * ```
 */
export const createTagNameConfig = (overrides?: Partial<TagNameConfig>): TagNameConfig =>
  overrides ? { ...DEFAULT_TAG_NAME, ...overrides } : DEFAULT_TAG_NAME;

export const getLineEnd = (text: string, pos: number): number => {
  const end = text.indexOf("\n", pos);
  if (end === -1) return text.length;
  if (end > pos && text[end - 1] === "\r") return end - 1;
  return end;
};
export const isLineStart = (text: string, pos: number): boolean => {
  return pos === 0 || text[pos - 1] === "\n";
};
export const isWholeLineToken = (text: string, pos: number, token: string): boolean => {
  if (!isLineStart(text, pos)) return false;
  if (!text.startsWith(token, pos)) return false;
  const lineEnd = getLineEnd(text, pos);
  return pos + token.length === lineEnd;
};

let activeTagName: TagNameConfig = createTagNameConfig();

export const getTagNameConfig = (): TagNameConfig => activeTagName;

export const withTagNameConfig = <T>(
  config: TagNameConfig,
  fn: () => T,
  options?: { suppressDeprecation?: boolean },
): T => {
  warnDeprecated(
    "withTagNameConfig",
    "withTagNameConfig() is deprecated. Pass tagName via ParseOptions instead.",
    {
      suppress: options?.suppressDeprecation,
    },
  );
  const prev = activeTagName;
  activeTagName = config;
  try {
    return fn();
  } finally {
    activeTagName = prev;
  }
};
