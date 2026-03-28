import type { SyntaxConfig } from "./types.js";
import { getSyntax } from "./syntax.js";

export const readEscapedSequence = (
  text: string,
  i: number,
  syntax?: SyntaxConfig,
): [string | null, number] => {
  const { escapeChar, escapableTokens } = syntax ?? getSyntax();
  if (!text.startsWith(escapeChar, i)) {
    return [null, i];
  }
  const start = i + escapeChar.length;
  for (const token of escapableTokens) {
    if (text.startsWith(token, start)) {
      return [token, start + token.length];
    }
  }

  return [null, i];
};

export const readEscaped = (
  text: string,
  i: number,
  syntax?: SyntaxConfig,
): [string, number] => {
  const [escaped, next] = readEscapedSequence(text, i, syntax);
  if (escaped !== null) {
    return [escaped, next];
  }
  return [text.slice(i, i + 1), i + 1];
};

export const unescapeInline = (str: string, syntax?: SyntaxConfig): string => {
  let result = "";
  let i = 0;

  while (i < str.length) {
    const [chunk, next] = readEscaped(str, i, syntax);
    result += chunk;
    i = next;
  }

  return result;
};
