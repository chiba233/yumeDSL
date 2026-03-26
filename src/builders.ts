import type { TextToken } from "./types.js";
import { readEscapedSequence, unescapeInline } from "./escape.js";
import { getSyntax } from "./syntax.js";
import { createToken } from "./createToken.js";

const createTextToken = (value: string): TextToken => createToken({ type: "text", value });

export const extractText = (tokens?: TextToken[]): string => {
  if (!tokens?.length) return "";
  let result = "";
  for (const t of tokens) {
    result += typeof t.value === "string" ? t.value : extractText(t.value);
  }
  return result;
};

export const materializeTextTokens = (tokens: TextToken[]): TextToken[] => {
  return tokens.map((token) => {
    if (typeof token.value === "string") {
      return token.type === "text" ? { ...token, value: unescapeInline(token.value) } : token;
    }

    return {
      ...token,
      value: materializeTextTokens(token.value),
    };
  });
};

export interface PipeArgs {
  parts: TextToken[][];
  text: (index: number) => string;
  materializedTokens: (index: number) => TextToken[];
  materializedTailTokens: (startIndex: number) => TextToken[];
}

export const splitTokensByPipe = (tokens: TextToken[]): TextToken[][] => {
  const { escapeChar, tagDivider } = getSyntax();
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
      const [escaped, next] = readEscapedSequence(val, i);
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

export const parsePipeArgs = (tokens: TextToken[]): PipeArgs => {
  const parts = splitTokensByPipe(tokens);

  return {
    parts,
    text: (index) => unescapeInline(extractText(parts[index] ?? [])).trim(),
    materializedTokens: (index) => materializeTextTokens(parts[index] ?? []),
    materializedTailTokens: (startIndex) => materializeTextTokens(parts.slice(startIndex).flat()),
  };
};

export const parsePipeTextArgs = (text: string): PipeArgs => parsePipeArgs([createTextToken(text)]);
