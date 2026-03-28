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
