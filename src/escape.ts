import type { DslContext, SyntaxConfig } from "./types.js";
import { getSyntax } from "./syntax.js";

/** @internal */
export const resolveSyntax = (ctx?: DslContext | SyntaxConfig): SyntaxConfig => {
  if (!ctx) return getSyntax();
  return "escapableTokens" in ctx ? ctx : ctx.syntax;
};

export const readEscapedSequence = (
  text: string,
  i: number,
  ctx?: DslContext | SyntaxConfig,
): [string | null, number] => {
  const { escapeChar, escapableTokens } = resolveSyntax(ctx);
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

export const readEscaped = (text: string, i: number, ctx?: DslContext | SyntaxConfig): [string, number] => {
  const syntax = resolveSyntax(ctx);
  const [escaped, next] = readEscapedSequence(text, i, syntax);
  if (escaped !== null) {
    return [escaped, next];
  }
  return [text.slice(i, i + 1), i + 1];
};

export const unescapeInline = (str: string, ctx?: DslContext | SyntaxConfig): string => {
  const syntax = resolveSyntax(ctx);
  let result = "";
  let i = 0;

  while (i < str.length) {
    const [chunk, next] = readEscaped(str, i, syntax);
    result += chunk;
    i = next;
  }

  return result;
};
