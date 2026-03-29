import type { BufferState, ParseContext, ParseStackNode, SourceSpan, TextToken } from "./types.js";
import { createToken } from "./createToken.js";
import { emitError } from "./errors.js";
import { makePosition } from "./positions.js";

export const emptyBuffer = (): BufferState => ({
  content: "",
  start: -1,
  sourceEnd: -1,
});

export const getCurrentTokens = (ctx: ParseContext): TextToken[] => {
  return ctx.stack.length ? ctx.stack[ctx.stack.length - 1].tokens : ctx.root;
};

export const pushTextToCurrent = (ctx: ParseContext, str: string, position?: SourceSpan) => {
  if (!str) return;

  const tokens = getCurrentTokens(ctx);
  const last = tokens[tokens.length - 1];

  // 注意：这里不能只拼字符串，不管 position。
  // 这个入口同时维持“相邻 text 合并”和“源码 span 连续”，
  // 转义 / 退化 / 未闭合恢复 都会走到这里，改错后很容易出现位置整体偏移。
  if (last?.type === "text" && typeof last.value === "string") {
    (last as { value: string }).value += str;
    if (position && last.position) {
      last.position = { start: last.position.start, end: position.end };
    }
  } else {
    tokens.push(createToken({ type: "text", value: str }, position, ctx.createId));
  }
};

export const appendToBuffer = (ctx: ParseContext, text: string, startOffset: number, sourceEnd?: number) => {
  const buf = ctx.buf;
  if (buf.start === -1) buf.start = startOffset;
  buf.sourceEnd = sourceEnd ?? startOffset + text.length;
  buf.content += text;
};

export const flushBuffer = (ctx: ParseContext) => {
  const buf = ctx.buf;
  if (!buf.content) return;
  const position = buf.start >= 0
    ? makePosition(ctx.tracker, buf.start, buf.sourceEnd)
    : undefined;
  pushTextToCurrent(ctx, buf.content, position);
  ctx.buf = emptyBuffer();
};

export const finalizeUnclosedTags = (ctx: ParseContext) => {
  while (ctx.stack.length) {
    const node = ctx.stack.pop() as ParseStackNode;
    emitError(ctx.tracker, ctx.onError, "INLINE_NOT_CLOSED", ctx.text, node.openPos, node.openLen);

    // 注意：这里是在把未闭合的 inline 语法退回 text。
    // opening 片段和已解析子 token 会重新拼回当前层；不要随便改顺序，
    // 否则 text merge / position 恢复会一起出问题，退化路径测试会直接失败。
    const openEnd = node.openPos + node.openLen;
    pushTextToCurrent(
      ctx,
      ctx.text.slice(node.openPos, openEnd),
      makePosition(ctx.tracker, node.openPos, openEnd),
    );

    node.tokens.forEach((t) => {
      if (t.type === "text" && typeof t.value === "string") {
        pushTextToCurrent(ctx, t.value, t.position);
      } else {
        getCurrentTokens(ctx).push(t);
      }
    });
  }
};
