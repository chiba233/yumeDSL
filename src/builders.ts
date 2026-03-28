import type { DslContext, SyntaxConfig, TextToken } from "./types.js";
import { readEscapedSequence, resolveSyntax, unescapeInline } from "./escape.js";
import { createToken } from "./createToken.js";

const createTextToken = (value: string, ctx?: DslContext | SyntaxConfig): TextToken =>
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
  ctx?: DslContext | SyntaxConfig,
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
      value: materializeTextTokens(token.value, syntax),
    };
  });
};

export interface PipeArgs {
  parts: TextToken[][];
  text: (index: number) => string;
  materializedTokens: (index: number) => TextToken[];
  materializedTailTokens: (startIndex: number) => TextToken[];
}

export const splitTokensByPipe = (
  tokens: TextToken[],
  ctx?: DslContext | SyntaxConfig,
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
  ctx?: DslContext | SyntaxConfig,
): PipeArgs => {
  const s = resolveSyntax(ctx);
  const parts = splitTokensByPipe(tokens, s);

  return {
    parts,
    text: (index) => unescapeInline(extractText(parts[index] ?? []), s).trim(),
    materializedTokens: (index) => materializeTextTokens(parts[index] ?? [], s),
    materializedTailTokens: (startIndex) =>
      materializeTextTokens(parts.slice(startIndex).flat(), s),
  };
};

export const parsePipeTextArgs = (
  text: string,
  ctx?: DslContext | SyntaxConfig,
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
  ctx?: DslContext | SyntaxConfig,
): string[] => {
  const parsed = parsePipeTextArgs(text, ctx);
  return parsed.parts.map((_, i) => parsed.text(i));
};
