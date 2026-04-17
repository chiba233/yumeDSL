import type { BlockTagLookup, MultilineForm } from "../types/index.js";

/** Length of the line break at `offset` (2 for \r\n, 1 for \n, 0 otherwise). */
const lineBreakLen = (text: string, offset: number): number =>
  text[offset] === "\r" && text[offset + 1] === "\n" ? 2 : text[offset] === "\n" ? 1 : 0;

/** Length of the line break ending at `offset` (2 for \r\n, 1 for \n, 0 otherwise). */
const lineBreakLenBefore = (text: string, offset: number): number =>
  text[offset - 1] === "\n" && text[offset - 2] === "\r" ? 2 : text[offset - 1] === "\n" ? 1 : 0;

export const consumeSingleTrailingLineBreak = (text: string, index: number): number =>
  index + lineBreakLen(text, index);

export interface NormalizedContent {
  content: string;
  leadingTrim: number;
}

export const normalizeBlockTagContent = (
  tag: string,
  content: string,
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
  blockTagSet: BlockTagLookup,
  form: MultilineForm,
): number => {
  if (!blockTagSet.has(tag, form)) return index;
  return consumeSingleTrailingLineBreak(text, index);
};
