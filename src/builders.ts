import type { DslContext, TextToken } from "./types.js";
import { readEscapedSequence, resolveSyntax, unescapeInline } from "./escape.js";
import { createToken } from "./createToken.js";

export const createTextToken = (value: string, ctx?: DslContext): TextToken =>
  createToken({ type: "text", value }, undefined, ctx);

export const extractText = (tokens?: TextToken[]): string => {
  if (!tokens?.length) return "";
  let result = "";
  for (const t of tokens) {
    result += typeof t.value === "string" ? t.value : extractText(t.value);
  }
  return result;
};

/**
 * Recursively unescapes DSL escape sequences in **text-type leaf tokens only**.
 * Non-text tokens and their string values (e.g. `raw-code` content) are left
 * untouched — only `{ type: "text", value: string }` leaves are processed.
 */
export const materializeTextTokens = (
  tokens: TextToken[],
  ctx?: DslContext,
): TextToken[] => {
  const syntax = resolveSyntax(ctx);
  return tokens.map((token) => {
    if (typeof token.value === "string") {
      return token.type === "text"
        ? { ...token, value: unescapeInline(token.value, syntax) }
        : token;
    }

    return {
      ...token,
      value: materializeTextTokens(token.value, ctx),
    };
  });
};

export interface PipeArgs {
  parts: TextToken[][];
  has: (index: number) => boolean;
  text: (index: number, fallback?: string) => string;
  materializedTokens: (index: number, fallback?: TextToken[]) => TextToken[];
  materializedTailTokens: (startIndex: number, fallback?: TextToken[]) => TextToken[];
}

export const splitTokensByPipe = (
  tokens: TextToken[],
  ctx?: DslContext,
): TextToken[][] => {
  const s = resolveSyntax(ctx);
  const { escapeChar, tagDivider } = s;
  const parts: TextToken[][] = [[]];

  for (const token of tokens) {
    if (token.type !== "text" || typeof token.value !== "string") {
      parts[parts.length - 1].push(token);
      continue;
    }

    let buffer = "";
    let i = 0;
    const val = token.value;

    const flushText = () => {
      if (buffer) {
        parts[parts.length - 1].push(createTextToken(buffer, ctx));
        buffer = "";
      }
    };

    while (i < val.length) {
      const [escaped, next] = readEscapedSequence(val, i, s);
      if (escaped !== null) {
        buffer += escapeChar + escaped;
        i = next;
        continue;
      }

      if (val.startsWith(tagDivider, i)) {
        flushText();
        parts.push([]);
        i += tagDivider.length;
        while (i < val.length && val[i] === " ") i++;
        continue;
      }

      buffer += val[i];
      i++;
    }

    flushText();
  }
  return parts;
};

export const parsePipeArgs = (
  tokens: TextToken[],
  ctx?: DslContext,
): PipeArgs => {
  const s = resolveSyntax(ctx);
  const parts = splitTokensByPipe(tokens, ctx);
  const has = (index: number): boolean => index >= 0 && index < parts.length;

  return {
    parts,
    has,
    text: (index, fallback = "") =>
      has(index) ? unescapeInline(extractText(parts[index] ?? []), s).trim() : fallback,
    materializedTokens: (index, fallback = []) =>
      has(index) ? materializeTextTokens(parts[index] ?? [], ctx) : fallback,
    materializedTailTokens: (startIndex, fallback = []) =>
      startIndex >= 0 && startIndex < parts.length
        ? materializeTextTokens(parts.slice(startIndex).flat(), ctx)
        : fallback,
  };
};

export const parsePipeTextArgs = (
  text: string,
  ctx?: DslContext,
): PipeArgs => parsePipeArgs([createTextToken(text, ctx)], ctx);

/**
 * Split a plain-text pipe-delimited arg string into trimmed string segments.
 * Shorthand for the common pattern of `parsePipeTextArgs(text)` followed by
 * mapping every part back to a trimmed string.
 *
 * @example
 * parsePipeTextList("ts | Demo | Label")  // → ["ts", "Demo", "Label"]
 */
export const parsePipeTextList = (
  text: string,
  ctx?: DslContext,
): string[] => {
  const parsed = parsePipeTextArgs(text, ctx);
  return parsed.parts.map((_, i) => parsed.text(i));
};
