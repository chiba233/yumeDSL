import type { ParseContext, TagStartInfo, TextToken } from "./types.js";
import { getSyntax } from "./syntax.js";
import { readEscaped, unescapeInline } from "./escape.js";
import { materializeTextTokens } from "./builders.js";
import { emitError } from "./errors.js";
import { flushBuffer, getCurrentTokens, pushTextToCurrent } from "./context.js";
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

const supportsInlineForm = (
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

  const { endTag, blockClose, blockOpen, rawClose, rawOpen } = getSyntax();

  if (ctx.stack.length === ctx.depthLimit) {
    emitError(
      ctx.onError,
      "DEPTH_LIMIT",
      ctx.text,
      ctx.i,
      info.inlineContentStart - info.tagOpenPos,
    );
  }

  const tagInfo = getTagCloserType(ctx.text, info.inlineContentStart);

  if (!tagInfo) {
    ctx.buffer += ctx.text.slice(ctx.i, info.inlineContentStart);
    ctx.i = info.inlineContentStart;
    return true;
  }

  if (tagInfo.closer === endTag) {
    const end = findInlineClose(ctx.text, info.inlineContentStart);
    if (end === -1) {
      const degradedEnd = skipDegradedInline(ctx.text, info.inlineContentStart);
      ctx.buffer += ctx.text.slice(ctx.i, degradedEnd);
      ctx.i = degradedEnd;
      return true;
    }

    ctx.buffer += ctx.text.slice(ctx.i, end + endTag.length);
    ctx.i = end + endTag.length;
    return true;
  }

  if (tagInfo.closer === blockClose) {
    const contentStart = tagInfo.argClose + blockOpen.length;
    const end = findBlockClose(ctx.text, contentStart);

    if (end === -1) {
      ctx.buffer += ctx.text.slice(ctx.i, contentStart);
      ctx.i = contentStart;
      return true;
    }

    ctx.buffer += ctx.text.slice(ctx.i, end + blockClose.length);
    ctx.i = end + blockClose.length;
    return true;
  }

  if (tagInfo.closer === rawClose) {
    const contentStart = tagInfo.argClose + rawOpen.length;
    const end = findRawClose(ctx.text, contentStart);

    if (end === -1) {
      ctx.buffer += ctx.text.slice(ctx.i, contentStart);
      ctx.i = contentStart;
      return true;
    }

    ctx.buffer += ctx.text.slice(ctx.i, end + rawClose.length);
    ctx.i = consumeBlockTagTrailingLineBreak(
      info.tag,
      ctx.text,
      end + rawClose.length,
      ctx.mode,
      ctx.blockTagSet,
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
    parseInlineContent,
  );

  if (!result.handled) return false;

  if (result.error) {
    emitError(ctx.onError, result.error.code, ctx.text, result.error.index, result.error.length);
  }

  if (result.fallbackText) {
    ctx.buffer += result.fallbackText;
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
      ctx.onError,
      "INLINE_NOT_CLOSED",
      ctx.text,
      info.tagOpenPos,
      info.inlineContentStart - info.tagOpenPos,
    );
    ctx.buffer += ctx.text.slice(ctx.i, info.inlineContentStart);
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
  ) => TextToken[],
): boolean => {
  const info = readTagStartInfo(ctx.text, ctx.i);
  if (!info) return false;

  flushBuffer(ctx);

  if (tryConsumeDepthLimitedTag(ctx, info)) return true;

  const inlineEnd = findInlineClose(ctx.text, info.inlineContentStart);

  if (tryConsumeComplexTag(ctx, info, inlineEnd, parseInlineContent)) return true;
  return tryConsumeInlineTag(ctx, info, inlineEnd);
};

export const finalizeClosedNode = (ctx: ParseContext, node: ParseContext["stack"][0]) => {
  const materializedTokens = materializeTextTokens(node.tokens);

  if (!node.richType) {
    materializedTokens.forEach((t) => {
      if (t.type === "text" && typeof t.value === "string") {
        pushTextToCurrent(ctx, unescapeInline(t.value));
      } else {
        getCurrentTokens(ctx).push(t);
      }
    });

    return;
  }

  const handler = ctx.handlers[node.richType];
  getCurrentTokens(ctx).push(
    handler?.inline
      ? createToken(handler.inline(node.tokens))
      : createToken({
          type: node.richType,
          value: materializedTokens,
        }),
  );
};

export const tryConsumeTagClose = (ctx: ParseContext): boolean => {
  const { endTag } = getSyntax();
  if (!ctx.text.startsWith(endTag, ctx.i)) return false;

  if (ctx.stack.length === 0) {
    emitError(ctx.onError, "UNEXPECTED_CLOSE", ctx.text, ctx.i, endTag.length);
    ctx.buffer += endTag;
    ctx.i += endTag.length;
    return true;
  }

  flushBuffer(ctx);

  const node = ctx.stack.pop()!;
  finalizeClosedNode(ctx, node);

  ctx.i += endTag.length;
  ctx.i = consumeBlockTagTrailingLineBreak(node.tag, ctx.text, ctx.i, ctx.mode, ctx.blockTagSet);

  return true;
};

export const tryConsumeEscape = (ctx: ParseContext): boolean => {
  const { escapeChar } = getSyntax();
  if (ctx.text[ctx.i] !== escapeChar || ctx.i + 1 >= ctx.text.length) {
    return false;
  }

  const [char, next] = readEscaped(ctx.text, ctx.i);
  ctx.buffer += ctx.stack.length > 0 ? ctx.text.slice(ctx.i, next) : char;
  ctx.i = next;
  return true;
};
