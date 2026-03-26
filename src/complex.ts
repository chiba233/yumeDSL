import type {
  BlockTagLookup,
  ComplexTagParseResult,
  ParseMode,
  TagHandler,
  TextToken,
} from "./types.js";
import {
  findBlockClose,
  findMalformedWholeLineTokenCandidate,
  findRawClose,
  findTagArgClose,
} from "./scanner.js";
import { getSyntax } from "./syntax.js";
import {
  consumeBlockTagTrailingLineBreak,
  normalizeBlockTagContent,
} from "./blockTagFormatting.js";
import { createToken } from "./createToken.js";

export const tryParseComplexTag = (
  text: string,
  tagOpenPos: number,
  tag: string,
  argStart: number,
  inlineEnd: number,
  depthLimit: number,
  mode: ParseMode,
  handlers: Record<string, TagHandler>,
  blockTagSet: BlockTagLookup,
  parseInlineContent: (
    text: string,
    depthLimit: number,
    options?: { mode?: ParseMode },
  ) => TextToken[],
): ComplexTagParseResult => {
  const handler = handlers[tag];
  if (!handler?.raw && !handler?.block) {
    return { handled: false, nextIndex: argStart };
  }

  const argClose = findTagArgClose(text, argStart);
  if (argClose === -1) {
    return { handled: false, nextIndex: argStart };
  }

  const { blockOpen, blockClose, rawOpen, rawClose, escapeChar } = getSyntax();

  const isBlock = text.startsWith(blockOpen, argClose);
  const isRaw = text.startsWith(rawOpen, argClose);

  if (!isBlock && !isRaw) {
    return { handled: false, nextIndex: argStart };
  }

  if (inlineEnd !== -1 && inlineEnd <= argClose) {
    return { handled: false, nextIndex: argStart };
  }

  if (isBlock) {
    const contentStart = argClose + blockOpen.length;
    const end = findBlockClose(text, contentStart);

    if (end === -1) {
      const malformedCloseCandidate = findMalformedWholeLineTokenCandidate(
        text,
        contentStart,
        blockClose,
      );

      return {
        handled: true,
        nextIndex: contentStart,
        fallbackText: text.slice(tagOpenPos, contentStart),
        error: malformedCloseCandidate
          ? {
              code: "BLOCK_CLOSE_MALFORMED",
              index: malformedCloseCandidate.index,
              length: malformedCloseCandidate.length,
            }
          : {
              code: "BLOCK_NOT_CLOSED",
              index: tagOpenPos,
              length: contentStart - tagOpenPos,
            },
      };
    }

    if (!handler.block) {
      return {
        handled: true,
        nextIndex: consumeBlockTagTrailingLineBreak(
          tag,
          text,
          end + blockClose.length,
          mode,
          blockTagSet,
          "block",
        ),
        fallbackText: text.slice(tagOpenPos, end + blockClose.length),
      };
    }

    const arg = text.slice(argStart, argClose).trim();
    const blockContent = normalizeBlockTagContent(
      tag,
      text.slice(contentStart, end),
      mode,
      blockTagSet,
      "block",
    );

    return {
      handled: true,
      nextIndex: consumeBlockTagTrailingLineBreak(
        tag,
        text,
        end + blockClose.length,
        mode,
        blockTagSet,
        "block",
      ),
      token: createToken(
        handler.block(arg, parseInlineContent(blockContent, Math.max(depthLimit - 1, 0), { mode })),
      ),
    };
  }

  // ── Raw ──
  const contentStart = argClose + rawOpen.length;
  const end = findRawClose(text, contentStart);

  if (end === -1) {
    const malformedCloseCandidate = findMalformedWholeLineTokenCandidate(
      text,
      contentStart,
      rawClose,
    );

    return {
      handled: true,
      nextIndex: contentStart,
      fallbackText: text.slice(tagOpenPos, contentStart),
      error: malformedCloseCandidate
        ? {
            code: "RAW_CLOSE_MALFORMED",
            index: malformedCloseCandidate.index,
            length: malformedCloseCandidate.length,
          }
        : {
            code: "RAW_NOT_CLOSED",
            index: tagOpenPos,
            length: contentStart - tagOpenPos,
          },
    };
  }

  if (!handler.raw) {
    return {
      handled: true,
      nextIndex: consumeBlockTagTrailingLineBreak(
        tag,
        text,
        end + rawClose.length,
        mode,
        blockTagSet,
        "raw",
      ),
      fallbackText: text.slice(tagOpenPos, end + rawClose.length),
    };
  }

  const arg = text.slice(argStart, argClose).trim();
  const rawContent = text.slice(contentStart, end);
  const normalizedRawContent =
    mode === "highlight" ? rawContent : rawContent.split(escapeChar + rawClose).join(rawClose);
  const content = normalizeBlockTagContent(tag, normalizedRawContent, mode, blockTagSet, "raw");

  return {
    handled: true,
    nextIndex: consumeBlockTagTrailingLineBreak(
      tag,
      text,
      end + rawClose.length,
      mode,
      blockTagSet,
      "raw",
    ),
    token: createToken(handler.raw(arg, content)),
  };
};
