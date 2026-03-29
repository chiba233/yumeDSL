import type { DslContext, TextToken } from "./types.js";
import { readEscapedSequence, resolveSyntax, unescapeInline } from "./escape.js";
import { createToken } from "./createToken.js";

/** 创建一个最基础的 text token；id / 兼容 createId 逻辑仍然走 `createToken(...)`。 */
export const createTextToken = (value: string, ctx?: DslContext): TextToken =>
  createToken({ type: "text", value }, undefined, ctx);

/** 递归提取 token 树里的纯文本内容，不做 unescape，也不保留结构信息。 */
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

/**
 * 按 DSL 的 `tagDivider` 把一组 tokens 拆成多段参数。
 *
 * 注意：
 * - 只会在 `text` 类型且 `value` 为字符串的叶子节点里查找 divider
 * - 非 text token 会原样落到当前分段
 * - 这里识别到被转义的 divider 时，会把它按“普通文本”留在当前段里，不会切段
 * - 这里不会做最终 unescape；那是 `parsePipeArgs().text()` / `materializedTokens()` 的职责
 */
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

/**
 * 基于 token 参数树构造一个“懒处理”的 pipe-args 视图。
 *
 * 这里故意把几种常见需求拆开：
 * - `parts`：原始分段结果，结构不变
 * - `text(i)`：提取文本、unescape、trim 后的字符串
 * - `materializedTokens(i)`：只对 text 叶子做 unescape，保留 token 结构
 * - `materializedTailTokens(start)`：把尾部多个分段拍平后再 materialize
 *
 * 注意：`splitTokensByPipe(...)` 和 `text(...)` 不是同一层语义。
 * 前者负责“按 divider 切段”，后者才负责“把段变成最终字符串”。
 */
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

/** 纯文本快捷入口：先包成一个 text token，再复用 `parsePipeArgs(...)`。 */
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
