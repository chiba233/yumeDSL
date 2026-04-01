import type { BlockTagLookup, MultilineForm, ParseMode } from "./types.js";

/** Length of the line break at `offset` (2 for \r\n, 1 for \n, 0 otherwise). */
const lineBreakLen = (text: string, offset: number): number =>
  text[offset] === "\r" && text[offset + 1] === "\n" ? 2 : text[offset] === "\n" ? 1 : 0;

/** Length of the line break ending at `offset` (2 for \r\n, 1 for \n, 0 otherwise). */
const lineBreakLenBefore = (text: string, offset: number): number =>
  text[offset - 1] === "\n" && text[offset - 2] === "\r" ? 2 : text[offset - 1] === "\n" ? 1 : 0;

export const consumeSingleTrailingLineBreak = (text: string, index: number): number =>
  index + lineBreakLen(text, index);

/**
 * Normalize a block/raw content string that has already been sliced or
 * escape-processed (i.e. cannot be addressed by source offsets).
 *
 * Strips one leading and one trailing line break if the tag is declared
 * in `blockTagSet`. Returns the trimmed string and how many bytes were
 * removed from the front (for position mapping).
 */
export interface NormalizedContent {
  content: string;
  leadingTrim: number;
}

export const normalizeBlockTagContent = (
  tag: string,
  content: string,
  mode: ParseMode,
  blockTagSet: BlockTagLookup,
  form: MultilineForm,
): NormalizedContent => {
  if (!blockTagSet.has(tag, form)) return { content, leadingTrim: 0 };
  const leading = lineBreakLen(content, 0);
  const trailing = lineBreakLenBefore(content, content.length);
  if (leading === 0 && trailing === 0) return { content, leadingTrim: 0 };
  return { content: content.slice(leading, content.length - trailing), leadingTrim: leading };
};

export const consumeBlockTagTrailingLineBreak = (
  tag: string,
  text: string,
  index: number,
  mode: ParseMode,
  blockTagSet: BlockTagLookup,
  form: MultilineForm,
): number => {
  if (!blockTagSet.has(tag, form)) return index;
  return consumeSingleTrailingLineBreak(text, index);
};

/**
 * Prepare block content for recursive inner parsing.
 *
 * Works entirely with source offsets — adjusts `contentStart` and
 * `contentEnd` for leading/trailing line breaks, then slices once.
 * No intermediate string copies.
 */
export interface PreparedBlockContent {
  content: string;
  baseOffset: number;
}

export const prepareBlockContent = (
  tag: string,
  text: string,
  contentStart: number,
  contentEnd: number,
  mode: ParseMode,
  blockTagSet: BlockTagLookup,
  form: MultilineForm,
): PreparedBlockContent => {
  if (!blockTagSet.has(tag, form)) {
    return { content: text.slice(contentStart, contentEnd), baseOffset: contentStart };
  }
  const start = contentStart + lineBreakLen(text, contentStart);
  const end = contentEnd - lineBreakLenBefore(text, contentEnd);
  return { content: text.slice(start, end), baseOffset: start };
};
