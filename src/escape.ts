import type { DslContext, SyntaxConfig } from "./types.js";
import { getSyntax } from "./syntax.js";

/** @internal Resolve syntax from DslContext, bare SyntaxConfig, or module default. */
export const resolveSyntax = (ctx?: DslContext | SyntaxConfig): SyntaxConfig => {
  if (!ctx) return getSyntax();
  return "syntax" in ctx ? ctx.syntax : ctx;
};

/**
 * 只尝试识别“当前位置是不是一个合法转义序列”。
 *
 * 返回值语义：
 * - `[escapedToken, nextIndex]`：命中了转义，`escapedToken` 是被转义出来的字面 token
 * - `[null, i]`：当前位置不是合法转义起点，调用方自己决定后续怎么处理
 *
 * 注意：这个函数不会兜底消费普通字符；它只负责“识别”，不负责“降级读取”。
 */
export const readEscapedSequence = (
  text: string,
  i: number,
  ctx?: DslContext | SyntaxConfig,
): [string | null, number] => {
  const { escapableTokens } = resolveSyntax(ctx);
  return readEscapedSequenceWithTokens(text, i, ctx, escapableTokens);
};

/**
 * 与 `readEscapedSequence` 相同，但允许调用方显式传入可转义 token 集合。
 *
 * 适用于需要“按上下文收紧转义范围”的扫描场景（如 root/raw/block content）。
 */
export const readEscapedSequenceWithTokens = (
  text: string,
  i: number,
  ctx: DslContext | SyntaxConfig | undefined,
  escapableTokens: readonly string[],
): [string | null, number] => {
  const { escapeChar } = resolveSyntax(ctx);
  if (escapableTokens.length === 0) return [null, i];
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

/**
 * 读取当前位置的“一个输出单元”：
 * - 如果是合法转义序列，返回转义后的字面值
 * - 否则返回当前位置的单个原始字符
 *
 * 注意：它比 `readEscapedSequence(...)` 多了一层兜底消费逻辑，
 * 所以调用方拿到的一定是“能追加到输出里的内容”。
 */
export const readEscaped = (
  text: string,
  i: number,
  ctx?: DslContext | SyntaxConfig,
): [string, number] => {
  const syntax = resolveSyntax(ctx);
  const [escaped, next] = readEscapedSequence(text, i, syntax);
  if (escaped !== null) {
    return [escaped, next];
  }
  return [text.slice(i, i + 1), i + 1];
};

/**
 * 把 inline 文本里所有合法转义序列还原成字面值。
 *
 * 它本质上就是：从左到右反复调用 `readEscaped(...)`，
 * 每次取一个“输出单元”拼回结果字符串。
 *
 * 注意：这里只处理 escape 语义，不负责 tag 解析，也不做位置映射。
 */
export const unescapeInline = (str: string, ctx?: DslContext | SyntaxConfig): string => {
  const syntax = resolveSyntax(ctx);
  const parts: string[] = [];
  let i = 0;
  let runStart = 0;

  while (i < str.length) {
    const [escaped, next] = readEscapedSequence(str, i, syntax);
    if (escaped !== null) {
      if (i > runStart) parts.push(str.slice(runStart, i));
      parts.push(escaped);
      i = next;
      runStart = i;
    } else {
      i++;
    }
  }

  if (runStart === 0) return str;
  if (i > runStart) parts.push(str.slice(runStart, i));
  return parts.join("");
};
