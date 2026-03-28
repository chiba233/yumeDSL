import type { CreateId, SyntaxConfig, TextToken } from "./types.js";
import { readEscapedSequence, unescapeInline } from "./escape.js";
import { getSyntax } from "./syntax.js";
import { createToken } from "./createToken.js";

const resolveSyntax = (syntax?: SyntaxConfig): SyntaxConfig => syntax ?? getSyntax();

const createTextToken = (value: string, explicitCreateId?: CreateId): TextToken =>
  createToken({ type: "text", value }, undefined, explicitCreateId);

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
export const materializeTextTokens = (tokens: TextToken[], syntax?: SyntaxConfig): TextToken[] => {
  const resolvedSyntax = resolveSyntax(syntax);
  return tokens.map((token) => {
    if (typeof token.value === "string") {
      return token.type === "text"
        ? { ...token, value: unescapeInline(token.value, resolvedSyntax) }
        : token;
    }

    return {
      ...token,
      value: materializeTextTokens(token.value, resolvedSyntax),
    };
  });
};

export interface PipeArgs {
  parts: TextToken[][];
  text: (index: number) => string;
  materializedTokens: (index: number) => TextToken[];
  materializedTailTokens: (startIndex: number) => TextToken[];
}

export const splitTokensByPipe = (tokens: TextToken[], syntax?: SyntaxConfig): TextToken[][] => {
  const s = resolveSyntax(syntax);
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
        parts[parts.length - 1].push(createTextToken(buffer));
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

export const parsePipeArgs = (tokens: TextToken[], syntax?: SyntaxConfig): PipeArgs => {
  const s = resolveSyntax(syntax);
  const parts = splitTokensByPipe(tokens, s);

  return {
    parts,
    text: (index) => unescapeInline(extractText(parts[index] ?? []), s).trim(),
    materializedTokens: (index) => materializeTextTokens(parts[index] ?? [], s),
    materializedTailTokens: (startIndex) =>
      materializeTextTokens(parts.slice(startIndex).flat(), s),
  };
};

export const parsePipeTextArgs = (text: string, syntax?: SyntaxConfig): PipeArgs =>
  parsePipeArgs([createTextToken(text)], syntax);

/**
 * Split a plain-text pipe-delimited arg string into trimmed string segments.
 * Shorthand for the common pattern of `parsePipeTextArgs(text)` followed by
 * mapping every part back to a trimmed string.
 *
 * @example
 * parsePipeTextList("ts | Demo | Label")  // → ["ts", "Demo", "Label"]
 */
export const parsePipeTextList = (text: string, syntax?: SyntaxConfig): string[] => {
  const parsed = parsePipeTextArgs(text, syntax);
  return parsed.parts.map((_, i) => parsed.text(i));
};
