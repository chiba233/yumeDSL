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
import { makePosition, withBaseOffset } from "./positions.js";

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
    const { content: blockContent, leadingTrim } = normalizeBlockTagContent(
      tag,
      text.slice(contentStart, end),
      mode,
      blockTagSet,
      "block",
    );
    const innerBaseOffset = contentStart + leadingTrim;

    const nextIndex = consumeBlockTagTrailingLineBreak(
      tag,
      text,
      end + blockClose.length,
      mode,
      blockTagSet,
      "block",
    );
    const position = makePosition(tagOpenPos, nextIndex);

    return {
      handled: true,
      nextIndex,
      token: createToken(
        handler.block(
          arg,
          withBaseOffset(innerBaseOffset, () =>
            parseInlineContent(blockContent, Math.max(depthLimit - 1, 0), { mode }),
          ),
        ),
        position,
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
    rawContent.split(escapeChar + rawClose).join(rawClose);
  const { content } = normalizeBlockTagContent(tag, normalizedRawContent, mode, blockTagSet, "raw");

  const nextIndex = consumeBlockTagTrailingLineBreak(
    tag,
    text,
    end + rawClose.length,
    mode,
    blockTagSet,
    "raw",
  );
  const position = makePosition(tagOpenPos, nextIndex);

  return {
    handled: true,
    nextIndex,
    token: createToken(handler.raw(arg, content), position),
  };
};
