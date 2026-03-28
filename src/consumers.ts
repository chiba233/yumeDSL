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
import { tryParseComplexTag } from "./complex.js";
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
      info.inlineContentStart - info.tagOpenPos,
    );
  }

  const tagInfo = getTagCloserType(ctx.text, info.inlineContentStart, syntax);

  if (!tagInfo) {
    appendToBuffer(ctx, ctx.text.slice(ctx.i, info.inlineContentStart), ctx.i);
    ctx.i = info.inlineContentStart;
    return true;
  }

  if (tagInfo.closer === endTag) {
    const end = findInlineClose(ctx.text, info.inlineContentStart, syntax, tagName);
    if (end === -1) {
      const degradedEnd = skipDegradedInline(ctx.text, info.inlineContentStart, syntax, tagName);
      appendToBuffer(ctx, ctx.text.slice(ctx.i, degradedEnd), ctx.i);
      ctx.i = degradedEnd;
      return true;
    }

    appendToBuffer(ctx, ctx.text.slice(ctx.i, end + endTag.length), ctx.i);
    ctx.i = end + endTag.length;
    return true;
  }

  if (tagInfo.closer === blockClose) {
    const contentStart = tagInfo.argClose + blockOpen.length;
    const end = findBlockClose(ctx.text, contentStart, syntax, tagName);

    if (end === -1) {
      appendToBuffer(ctx, ctx.text.slice(ctx.i, contentStart), ctx.i);
      ctx.i = contentStart;
      return true;
    }

    appendToBuffer(ctx, ctx.text.slice(ctx.i, end + blockClose.length), ctx.i);
    ctx.i = end + blockClose.length;
    return true;
  }

  if (tagInfo.closer === rawClose) {
    const contentStart = tagInfo.argClose + rawOpen.length;
    const end = findRawClose(ctx.text, contentStart, syntax);

    if (end === -1) {
      appendToBuffer(ctx, ctx.text.slice(ctx.i, contentStart), ctx.i);
      ctx.i = contentStart;
      return true;
    }

    appendToBuffer(ctx, ctx.text.slice(ctx.i, end + rawClose.length), ctx.i);
    ctx.i = consumeBlockTagTrailingLineBreak(
      info.tag,
      ctx.text,
      end + rawClose.length,
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
  const result = tryParseComplexTag(
    ctx.text,
    info.tagOpenPos,
    info.tag,
    info.inlineContentStart,
    inlineEnd,
    ctx.depthLimit,
    ctx.mode,
    ctx.handlers,
    ctx.blockTagSet,
    ctx.tracker,
    ctx.syntax,
    ctx.tagName,
    ctx.createId,
    parseInlineContent,
  );

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
      info.inlineContentStart - info.tagOpenPos,
    );
    appendToBuffer(ctx, ctx.text.slice(ctx.i, info.inlineContentStart), info.tagOpenPos);
    ctx.i = info.inlineContentStart;
    return true;
  }

  ctx.stack.push({
    tag: info.tag,
    richType: handler ? info.tag : null,
    tokens: [],
    openPos: info.tagOpenPos,
    openLen: info.inlineContentStart - info.tagOpenPos,
  });
  ctx.i = info.inlineContentStart;
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

  const inlineEnd = findInlineClose(ctx.text, info.inlineContentStart, ctx.syntax, ctx.tagName);

  if (tryConsumeComplexTag(ctx, info, inlineEnd, parseInlineContent)) return true;
  return tryConsumeInlineTag(ctx, info, inlineEnd);
};

export const finalizeClosedNode = (ctx: ParseContext, node: ParseContext["stack"][0]) => {
  const { endTag } = ctx.syntax;
  const materializedTokens = materializeTextTokens(node.tokens, ctx.syntax);

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
  const dslCtx: import("./types.js").DslContext = { syntax: ctx.syntax, createId: ctx.createId };

  getCurrentTokens(ctx).push(
    handler?.inline
      ? createToken(handler.inline(node.tokens, dslCtx), position, ctx.createId)
      : createToken({
          type: node.richType,
          value: materializedTokens,
        }, position, ctx.createId),
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
    "block",
  );

  return true;
};

export const tryConsumeEscape = (ctx: ParseContext): boolean => {
  const { escapeChar } = ctx.syntax;
  if (ctx.text[ctx.i] !== escapeChar || ctx.i + 1 >= ctx.text.length) {
    return false;
  }

  const [char, next] = readEscaped(ctx.text, ctx.i, ctx.syntax);
  appendToBuffer(ctx, ctx.stack.length > 0 ? ctx.text.slice(ctx.i, next) : char, ctx.i, next);
  ctx.i = next;
  return true;
};
