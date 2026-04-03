import type { ParseContext, PositionTracker, TagStartInfo, TextToken } from "./types.js";
import { readEscaped, unescapeInline } from "./escape.js";
import { materializeTextTokens } from "./builders.js";
import { emitError } from "./errors.js";
import { appendToBuffer, flushBuffer, getCurrentTokens, pushTextToCurrent } from "./context.js";
import {
  findBlockClose,
  findInlineClose,
  findRawClose,
  getTagCloserType,
  readTagStartInfo,
  skipDegradedInline,
} from "./scanner.js";
import { tryParseComplexTag, type ComplexTagContext } from "./complex.js";
import { createToken } from "./createToken.js";
import { consumeBlockTagTrailingLineBreak } from "./blockTagFormatting.js";
import { makePosition } from "./positions.js";

/**
 * Decide whether a tag may be consumed via the inline code path.
 *
 * Decision table (evaluated top-to-bottom, first match wins):
 *
 *  allowInline=false                          → reject  (global inline disabled)
 *  handler missing + tag NOT registered       → accept  (unknown tag → passthrough)
 *  handler missing + tag IS registered        → reject  (registered but filtered out by allowForms)
 *  handler has `inline`                       → accept  (explicit inline support)
 *  handler has only `raw` / `block`           → reject  (block/raw-only tag)
 *  handler is empty `{}`                      → accept  (passthrough handler)
 *
 * ⚠ This function is the inline-form rules centre.
 *   Changes here affect every tag in every parse mode — add tests, not shortcuts.
 */
export const supportsInlineForm = (
  handler: ParseContext["handlers"][string] | undefined,
  allowInline: boolean,
  isRegistered: boolean,
): boolean => {
  if (!allowInline) return false;
  if (!handler) return !isRegistered;
  if (handler.inline) return true;
  return !handler.raw && !handler.block;
};

/** Append text from ctx.i up to `end`, advance ctx.i to `end`. */
const bufferAndAdvance = (ctx: ParseContext, end: number) => {
  appendToBuffer(ctx, ctx.text.slice(ctx.i, end), ctx.i);
  ctx.i = end;
};

export const tryConsumeDepthLimitedTag = (ctx: ParseContext, info: TagStartInfo): boolean => {
  if (ctx.stack.length < ctx.depthLimit) return false;

  const { syntax, tagName } = ctx;
  const { endTag, blockClose, blockOpen, rawClose, rawOpen } = syntax;

  if (ctx.stack.length === ctx.depthLimit) {
    emitError(
      ctx.tracker,
      ctx.onError,
      "DEPTH_LIMIT",
      ctx.text,
      ctx.i,
      info.argStart - info.tagOpenPos,
    );
  }

  const tagInfo = getTagCloserType(ctx.text, info.argStart, syntax);

  if (!tagInfo) {
    bufferAndAdvance(ctx, info.argStart);
    return true;
  }

  if (tagInfo.closer === endTag) {
    const end = findInlineClose(ctx.text, info.argStart, syntax, tagName);
    if (end === -1) {
      bufferAndAdvance(ctx, skipDegradedInline(ctx.text, info.argStart, syntax, tagName));
      return true;
    }
    bufferAndAdvance(ctx, end + endTag.length);
    return true;
  }

  if (tagInfo.closer === blockClose) {
    const contentStart = tagInfo.argClose + blockOpen.length;
    const end = findBlockClose(ctx.text, contentStart, syntax, tagName);
    bufferAndAdvance(ctx, end === -1 ? contentStart : end + blockClose.length);
    return true;
  }

  if (tagInfo.closer === rawClose) {
    const contentStart = tagInfo.argClose + rawOpen.length;
    const end = findRawClose(ctx.text, contentStart, syntax);
    if (end === -1) {
      bufferAndAdvance(ctx, contentStart);
      return true;
    }
    bufferAndAdvance(ctx, end + rawClose.length);
    ctx.i = consumeBlockTagTrailingLineBreak(
      info.tag,
      ctx.text,
      ctx.i,
      ctx.mode,
      ctx.blockTagSet,
      "raw",
    );
    return true;
  }

  return false;
};

export const tryConsumeComplexTag = (
  ctx: ParseContext,
  info: TagStartInfo,
  inlineEnd: number,
  parseInlineContent: (
    text: string,
    depthLimit: number,
    options?: { mode?: ParseContext["mode"] },
    innerTracker?: PositionTracker | null,
  ) => TextToken[],
): boolean => {
  const result = tryParseComplexTag({
    text: ctx.text,
    tagOpenPos: info.tagOpenPos,
    tag: info.tag,
    argStart: info.argStart,
    inlineEnd,
    depthLimit: ctx.depthLimit,
    mode: ctx.mode,
    handlers: ctx.handlers,
    blockTagSet: ctx.blockTagSet,
    tracker: ctx.tracker,
    syntax: ctx.syntax,
    tagName: ctx.tagName,
    createId: ctx.createId,
    parseInlineContent,
  });

  if (!result.handled) return false;

  if (result.error) {
    emitError(ctx.tracker, ctx.onError, result.error.code, ctx.text, result.error.index, result.error.length);
  }

  if (result.fallbackText) {
    appendToBuffer(ctx, result.fallbackText, info.tagOpenPos);
  }

  if (result.token) {
    flushBuffer(ctx);
    getCurrentTokens(ctx).push(result.token);
  }

  ctx.i = result.nextIndex;
  return true;
};

export const tryConsumeInlineTag = (
  ctx: ParseContext,
  info: TagStartInfo,
  inlineEnd: number,
): boolean => {
  const handler = ctx.handlers[info.tag];
  if (!supportsInlineForm(handler, ctx.allowInline, ctx.registeredTags.has(info.tag))) {
    return false;
  }

  if (inlineEnd === -1) {
    emitError(
      ctx.tracker,
      ctx.onError,
      "INLINE_NOT_CLOSED",
      ctx.text,
      info.tagOpenPos,
      info.argStart - info.tagOpenPos,
    );
    appendToBuffer(ctx, ctx.text.slice(ctx.i, info.argStart), info.tagOpenPos);
    ctx.i = info.argStart;
    return true;
  }

  ctx.stack.push({
    tag: info.tag,
    richType: handler ? info.tag : null,
    tokens: [],
    openPos: info.tagOpenPos,
    openLen: info.argStart - info.tagOpenPos,
  });
  ctx.i = info.argStart;
  return true;
};

export const tryConsumeTagStart = (
  ctx: ParseContext,
  parseInlineContent: (
    text: string,
    depthLimit: number,
    options?: { mode?: ParseContext["mode"] },
    innerTracker?: PositionTracker | null,
  ) => TextToken[],
): boolean => {
  const info = readTagStartInfo(ctx.text, ctx.i, ctx.syntax, ctx.tagName);
  if (!info) return false;

  flushBuffer(ctx);

  if (tryConsumeDepthLimitedTag(ctx, info)) return true;

  const inlineEnd = findInlineClose(ctx.text, info.argStart, ctx.syntax, ctx.tagName);

  if (tryConsumeComplexTag(ctx, info, inlineEnd, parseInlineContent)) return true;
  return tryConsumeInlineTag(ctx, info, inlineEnd);
};

export const finalizeClosedNode = (ctx: ParseContext, node: ParseContext["stack"][0]) => {
  const { endTag } = ctx.syntax;
  const dslCtx: import("./types.js").DslContext = { syntax: ctx.syntax, createId: ctx.createId };
  const materializedTokens = materializeTextTokens(node.tokens, dslCtx);

  if (!node.richType) {
    materializedTokens.forEach((t) => {
      if (t.type === "text" && typeof t.value === "string") {
        pushTextToCurrent(ctx, unescapeInline(t.value, ctx.syntax), t.position);
      } else {
        getCurrentTokens(ctx).push(t);
      }
    });

    return;
  }

  const handler = ctx.handlers[node.richType];
  const position = makePosition(ctx.tracker, node.openPos, ctx.i + endTag.length);

  getCurrentTokens(ctx).push(
    handler?.inline
      ? createToken(handler.inline(node.tokens, dslCtx), position, dslCtx)
      : createToken({ type: node.richType, value: materializedTokens }, position, dslCtx),
  );
};

export const tryConsumeTagClose = (ctx: ParseContext): boolean => {
  const { endTag } = ctx.syntax;
  if (!ctx.text.startsWith(endTag, ctx.i)) return false;

  if (ctx.stack.length === 0) {
    emitError(ctx.tracker, ctx.onError, "UNEXPECTED_CLOSE", ctx.text, ctx.i, endTag.length);
    appendToBuffer(ctx, endTag, ctx.i);
    ctx.i += endTag.length;
    return true;
  }

  flushBuffer(ctx);

  const node = ctx.stack.pop()!;
  finalizeClosedNode(ctx, node);

  ctx.i += endTag.length;
  ctx.i = consumeBlockTagTrailingLineBreak(
    node.tag,
    ctx.text,
    ctx.i,
    ctx.mode,
    ctx.blockTagSet,
    "inline",
  );

  return true;
};

export const tryConsumeEscape = (ctx: ParseContext): boolean => {
  const { escapeChar } = ctx.syntax;
  if (!ctx.text.startsWith(escapeChar, ctx.i) || ctx.i + escapeChar.length >= ctx.text.length) {
    return false;
  }

  const [char, next] = readEscaped(ctx.text, ctx.i, ctx.syntax);
  appendToBuffer(ctx, ctx.stack.length > 0 ? ctx.text.slice(ctx.i, next) : char, ctx.i, next);
  ctx.i = next;
  return true;
};
