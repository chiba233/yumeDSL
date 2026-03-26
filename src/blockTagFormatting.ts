import type { BlockTagLookup, MultilineForm, ParseMode } from "./types.js";

export const stripSingleLeadingLineBreak = (text: string): string => {
  if (text.startsWith("\r\n")) return text.slice(2);
  if (text.startsWith("\n")) return text.slice(1);
  return text;
};

export const consumeSingleTrailingLineBreak = (text: string, index: number): number => {
  if (text.startsWith("\r\n", index)) return index + 2;
  if (text[index] === "\n") return index + 1;
  return index;
};

export const normalizeBlockTagContent = (
  tag: string,
  content: string,
  mode: ParseMode,
  blockTagSet: BlockTagLookup,
  form: MultilineForm,
): string => {
  if (!blockTagSet.has(tag, form)) return content;
  if (mode === "highlight") return content;
  return stripSingleLeadingLineBreak(content);
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
  if (mode === "highlight") return index;
  return consumeSingleTrailingLineBreak(text, index);
};
