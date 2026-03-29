import type { SyntaxConfig, TagHead, TagNameConfig, TagStartInfo } from "./types.js";
import { getLineEnd, isWholeLineToken } from "./chars.js";
import { readEscapedSequence } from "./escape.js";

export const findTagArgClose = (
  text: string,
  start: number,
  syntax: SyntaxConfig,
): number => {
  const { tagOpen, tagClose } = syntax;
  let pos = start;
  let depth = 1;

  while (pos < text.length) {
    const [escaped, next] = readEscapedSequence(text, pos, syntax);
    if (escaped !== null) {
      pos = next;
      continue;
    }

    if (text.startsWith(tagOpen, pos)) {
      depth++;
      pos += tagOpen.length;
      continue;
    } else if (text.startsWith(tagClose, pos)) {
      depth--;
      if (depth === 0) return pos;
      pos += tagClose.length;
      continue;
    }

    pos++;
  }

  return -1;
};

const readTagHeadAt = (
  text: string,
  pos: number,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): TagHead | null => {
  // 注意：这里只负责“语法上像不像 tag 头”，不负责这个 tag 最终是否可解析。
  // 也就是说：这里只看 prefix / tagName / tagOpen，不碰 handler、不碰 form gating。
  // 一旦把职责偷偷扩进来，scanner 和 parser 的边界会直接糊掉。
  const { tagPrefix, tagOpen } = syntax;
  const { isTagChar, isTagStartChar } = tagName;
  if (!text.startsWith(tagPrefix, pos)) return null;

  const tagStart = pos + tagPrefix.length;
  if (tagStart >= text.length || !isTagStartChar(text[tagStart])) {
    return null;
  }

  let tagNameEnd = tagStart + 1;
  while (tagNameEnd < text.length && isTagChar(text[tagNameEnd])) {
    tagNameEnd++;
  }

  if (!text.startsWith(tagOpen, tagNameEnd)) {
    return null;
  }

  return {
    tag: text.slice(tagStart, tagNameEnd),
    tagStart: pos,
    tagNameEnd,
    argStart: tagNameEnd + tagOpen.length,
  };
};

interface InlineBoundaryMode {
  /** When the outermost close is found, return its start position (true) or end position (false). */
  returnCloseStart: boolean;
  /** When no close is found, return text.length (true) or -1 (false). */
  fallbackToTextEnd: boolean;
}

const scanInlineBoundary = (
  text: string,
  start: number,
  mode: InlineBoundaryMode,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): number => {
  // 注意：这是 inline 边界扫描的底层公共逻辑。
  // `findInlineClose` 和 `skipDegradedInline` 都靠它，只是返回策略不同。
  // 这里如果改了 depth、escaped 跳过、或 head 识别规则，两条路径会一起变。
  const { endTag } = syntax;
  let pos = start;
  let depth = 1;

  while (pos < text.length) {
    const [escaped, next] = readEscapedSequence(text, pos, syntax);
    if (escaped !== null) {
      pos = next;
      continue;
    }

    const head = readTagHeadAt(text, pos, syntax, tagName);
    if (head) {
      depth++;
      pos = head.argStart;
      continue;
    }

    if (text.startsWith(endTag, pos)) {
      depth--;
      const closeEnd = pos + endTag.length;

      if (depth === 0) {
        return mode.returnCloseStart ? pos : closeEnd;
      }

      pos = closeEnd;
      continue;
    }

    pos++;
  }

  return mode.fallbackToTextEnd ? text.length : -1;
};

export const getTagCloserType = (
  text: string,
  tagOpenIndex: number,
  syntax: SyntaxConfig,
): { closer: string; argClose: number } | null => {
  // 注意：这里决定“这个 tag 语法长得像 inline / raw / block 哪一种”。
  // 它只根据 arg-close 后面紧跟的 token 判断，不看 handler。
  // 一旦这里判断错，后面整条分支都会走错，而且通常不是直接报错，而是悄悄退化错位。
  const { blockOpen, blockClose, rawOpen, rawClose, endTag } = syntax;
  const argClose = findTagArgClose(text, tagOpenIndex, syntax);
  if (argClose === -1) return null;

  if (text.startsWith(blockOpen, argClose)) {
    return { closer: blockClose, argClose };
  }

  if (text.startsWith(rawOpen, argClose)) {
    return { closer: rawClose, argClose };
  }

  return { closer: endTag, argClose };
};

export const findInlineClose = (
  text: string,
  start: number,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): number => {
  return scanInlineBoundary(text, start, { returnCloseStart: true, fallbackToTextEnd: false }, syntax, tagName);
};

export const findBlockClose = (
  text: string,
  start: number,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): number => {
  // 注意：block close 扫描比 inline/raw 都更危险。
  // 它既要识别整行 close，又要跨过内层 raw/block/inline，而且三者的跳过策略还不一样。
  // 这里任何一个分支少吃或多吃字符，外层 depth 和最终 close 位置都会一起漂。
  const { blockClose, rawClose, rawOpen, blockOpen, endTag } = syntax;
  let pos = start;
  let depth = 1;

  while (pos < text.length) {
    const [escaped, next] = readEscapedSequence(text, pos, syntax);
    if (escaped !== null) {
      pos = next;
      continue;
    }

    if (isWholeLineToken(text, pos, blockClose)) {
      depth--;
      if (depth === 0) return pos;
      pos = getLineEnd(text, pos) + 1;
      continue;
    }

    const head = readTagHeadAt(text, pos, syntax, tagName);
    if (head) {
      const tagInfo = getTagCloserType(text, head.argStart, syntax);

      if (tagInfo?.closer === rawClose) {
        // 注意：内层 raw 不能递增 block depth，只能整段跳过。
        const rawStart = tagInfo.argClose + rawOpen.length;
        const rawEnd = findRawClose(text, rawStart, syntax);
        if (rawEnd === -1) return -1;
        pos = rawEnd + rawClose.length;
        continue;
      }

      if (tagInfo?.closer === blockClose) {
        // 注意：只有内层 block 会递增外层 block depth。
        depth++;
        pos = tagInfo.argClose + blockOpen.length;
        continue;
      }

      if (tagInfo?.closer === endTag) {
        // 注意：inline 在 block 里不会影响 depth，但必须整段跳过，不能按字符慢慢磨。
        const inlineEnd = findInlineClose(text, head.argStart, syntax, tagName);
        if (inlineEnd === -1) {
          pos = head.argStart;
          continue;
        }
        pos = inlineEnd + endTag.length;
        continue;
      }
    }

    pos++;
  }

  return -1;
};

export const findRawClose = (text: string, start: number, syntax: SyntaxConfig): number => {
  const { rawClose } = syntax;
  let pos = start;

  while (pos < text.length) {
    if (isWholeLineToken(text, pos, rawClose)) {
      return pos;
    }

    const lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }

  return -1;
};

export const findMalformedWholeLineTokenCandidate = (
  text: string,
  start: number,
  token: string,
): { index: number; length: number } | null => {
  let pos = start;

  while (pos < text.length) {
    const lineEnd = text.indexOf("\n", pos);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(pos, end);
    const trimmedStart = line.trimStart();
    const leadingWhitespace = line.length - trimmedStart.length;

    if (trimmedStart.startsWith(token) && line !== token) {
      return {
        index: pos + leadingWhitespace,
        length: trimmedStart.length,
      };
    }

    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }

  return null;
};

export const skipDegradedInline = (
  text: string,
  start: number,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): number => {
  return scanInlineBoundary(text, start, { returnCloseStart: false, fallbackToTextEnd: true }, syntax, tagName);
};

/**
 * Skip over a syntactically recognized tag boundary without parsing its internals.
 * Returns the position immediately after the tag's closing boundary, or the
 * degraded fallback boundary when the tag is malformed.
 */
export const skipTagBoundary = (
  text: string,
  info: NonNullable<ReturnType<typeof readTagStartInfo>>,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): number => {
  // 注意：这是“只跳边界、不解析内容”的兜底路径，给 depth-limit / degrade 之类的场景用。
  // 它和真正 parse 分支必须共享同一套 close 语义，否则“跳过去的位置”和“真解析的位置”会分叉。
  // 一旦分叉，最先死的是 degrade 恢复和后续 token 对齐。
  const { tagOpen, endTag, rawOpen, rawClose, blockOpen, blockClose } = syntax;

  const closerInfo = getTagCloserType(text, info.tagNameEnd + tagOpen.length, syntax);
  if (!closerInfo) return info.inlineContentStart;

  if (closerInfo.closer === endTag) {
    const closeStart = findInlineClose(text, info.inlineContentStart, syntax, tagName);
    return closeStart === -1
      ? skipDegradedInline(text, info.inlineContentStart, syntax, tagName)
      : closeStart + endTag.length;
  }

  if (closerInfo.closer === rawClose) {
    const contentStart = closerInfo.argClose + rawOpen.length;
    const closeStart = findRawClose(text, contentStart, syntax);
    return closeStart === -1 ? contentStart : closeStart + rawClose.length;
  }

  const contentStart = closerInfo.argClose + blockOpen.length;
  const closeStart = findBlockClose(text, contentStart, syntax, tagName);
  return closeStart === -1 ? contentStart : closeStart + blockClose.length;
};

export const readTagStartInfo = (
  text: string,
  i: number,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): TagStartInfo | null => {
  // 注意：这里返回的是“最小可用 tag 起始信息”。
  // 后面很多路径都会拿这个结果继续扫边界，所以字段含义别改名式重解释：
  // `inlineContentStart` 现在其实是“argStart”，不是“已经确认是 inline 后的正文起点”。
  const head = readTagHeadAt(text, i, syntax, tagName);
  if (!head) return null;

  return {
    tag: head.tag,
    tagOpenPos: head.tagStart,
    tagNameEnd: head.tagNameEnd,
    inlineContentStart: head.argStart,
  };
};
