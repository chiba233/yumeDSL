"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_SYNTAX: () => DEFAULT_SYNTAX,
  createSyntax: () => createSyntax,
  createToken: () => createToken,
  extractText: () => extractText,
  materializeTextTokens: () => materializeTextTokens,
  parsePipeArgs: () => parsePipeArgs,
  parsePipeTextArgs: () => parsePipeTextArgs,
  parseRichText: () => parseRichText,
  resetTokenIdSeed: () => resetTokenIdSeed,
  splitTokensByPipe: () => splitTokensByPipe,
  stripRichText: () => stripRichText,
  unescapeInline: () => unescapeInline
});
module.exports = __toCommonJS(index_exports);

// src/syntax.ts
var DEFAULT_SYNTAX = {
  tagPrefix: "$$",
  tagOpen: "(",
  tagClose: ")",
  tagDivider: "|",
  endTag: ")$$",
  rawOpen: ")%",
  blockOpen: ")*",
  blockClose: "*end$$",
  rawClose: "%end$$",
  escapeChar: "\\"
};
var createSyntax = (overrides) => {
  const s = overrides ? { ...DEFAULT_SYNTAX, ...overrides } : DEFAULT_SYNTAX;
  return {
    ...s,
    escapableTokens: [
      s.rawClose,
      s.blockClose,
      s.tagOpen,
      s.tagClose,
      s.tagDivider,
      s.escapeChar
    ].sort((a, b) => b.length - a.length)
  };
};
var activeSyntax = createSyntax();
var getSyntax = () => activeSyntax;
var withSyntax = (syntax, fn) => {
  const prev = activeSyntax;
  activeSyntax = syntax;
  try {
    return fn();
  } finally {
    activeSyntax = prev;
  }
};

// src/escape.ts
var readEscapedSequence = (text, i) => {
  const { escapeChar, escapableTokens } = getSyntax();
  if (!text.startsWith(escapeChar, i)) {
    return [null, i];
  }
  const start = i + escapeChar.length;
  for (const token of escapableTokens) {
    if (text.startsWith(token, start)) {
      return [token, start + token.length];
    }
  }
  return [null, i];
};
var readEscaped = (text, i) => {
  const [escaped, next] = readEscapedSequence(text, i);
  if (escaped !== null) {
    return [escaped, next];
  }
  return [text.slice(i, i + 1), i + 1];
};
var unescapeInline = (str) => {
  let result = "";
  let i = 0;
  while (i < str.length) {
    const [chunk, next] = readEscaped(str, i);
    result += chunk;
    i = next;
  }
  return result;
};

// src/createToken.ts
var tokenIdSeed = 0;
var createToken = (token) => {
  return { ...token, id: `rt-${tokenIdSeed++}` };
};
var resetTokenIdSeed = () => {
  tokenIdSeed = 0;
};

// src/builders.ts
var createTextToken = (value) => createToken({ type: "text", value });
var extractText = (tokens) => {
  if (!tokens?.length) return "";
  return tokens.map((t) => typeof t.value === "string" ? t.value : extractText(t.value)).join("");
};
var materializeTextTokens = (tokens) => {
  return tokens.map((token) => {
    if (typeof token.value === "string") {
      return token.type === "text" ? { ...token, value: unescapeInline(token.value) } : token;
    }
    return {
      ...token,
      value: materializeTextTokens(token.value)
    };
  });
};
var splitTokensByPipe = (tokens) => {
  const { escapeChar, tagDivider } = getSyntax();
  const parts = [[]];
  for (const token of tokens) {
    if (token.type !== "text" || typeof token.value !== "string") {
      parts[parts.length - 1].push(token);
      continue;
    }
    let buffer = "";
    let i = 0;
    const val = token.value;
    const flushText = () => {
      if (buffer) {
        parts[parts.length - 1].push(createTextToken(buffer));
        buffer = "";
      }
    };
    while (i < val.length) {
      const [escaped, next] = readEscapedSequence(val, i);
      if (escaped !== null) {
        buffer += escapeChar + escaped;
        i = next;
        continue;
      }
      if (val[i] === tagDivider) {
        flushText();
        parts.push([]);
        i++;
        while (i < val.length && val[i] === " ") i++;
        continue;
      }
      buffer += val[i];
      i++;
    }
    flushText();
  }
  return parts;
};
var parsePipeArgs = (tokens) => {
  const parts = splitTokensByPipe(tokens);
  return {
    parts,
    text: (index) => unescapeInline(extractText(parts[index] ?? [])).trim(),
    materializedTokens: (index) => materializeTextTokens(parts[index] ?? []),
    materializedTailTokens: (startIndex) => materializeTextTokens(parts.slice(startIndex).flat())
  };
};
var parsePipeTextArgs = (text) => parsePipeArgs([createTextToken(text)]);

// src/errors.ts
var ERROR_MESSAGES = {
  DEPTH_LIMIT: "Nesting too deep",
  UNEXPECTED_CLOSE: "Unexpected close tag",
  BLOCK_NOT_CLOSED: "Block tag not closed",
  BLOCK_CLOSE_MALFORMED: "Malformed block close",
  RAW_NOT_CLOSED: "Raw block not closed",
  RAW_CLOSE_MALFORMED: "Malformed raw close",
  INLINE_NOT_CLOSED: "Inline tag not closed"
};
var getErrorContext = (text, index, length = 1, range = 15) => {
  const lines = text.slice(0, index).split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  const start = Math.max(0, index - range);
  const end = Math.min(text.length, index + length + range);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  const before = text.slice(start, index);
  const content = text.slice(index, index + length);
  const after = text.slice(index + length, end);
  const highlightedSnippet = `${prefix}${before} >>>${content}<<< ${after}${suffix}`;
  return {
    line,
    column,
    snippet: highlightedSnippet.replace(/\n/g, " ")
  };
};
var emitError = (onError, code, text, index, length) => {
  if (!onError) return;
  const { line, column, snippet } = getErrorContext(text, index, length);
  const base = ERROR_MESSAGES[code] ?? code;
  const message = `(L${line}:C${column}) ${base}: ${snippet}`;
  onError({ code, message, line, column, snippet });
};

// src/context.ts
var getCurrentTokens = (ctx) => {
  return ctx.stack.length ? ctx.stack[ctx.stack.length - 1].tokens : ctx.root;
};
var pushTextToCurrent = (ctx, str) => {
  if (!str) return;
  const tokens = getCurrentTokens(ctx);
  const last = tokens[tokens.length - 1];
  if (last?.type === "text" && typeof last.value === "string") {
    last.value += str;
  } else {
    tokens.push(createToken({ type: "text", value: str }));
  }
};
var flushBuffer = (ctx) => {
  if (!ctx.buffer) return;
  pushTextToCurrent(ctx, ctx.buffer);
  ctx.buffer = "";
};
var finalizeUnclosedTags = (ctx) => {
  while (ctx.stack.length) {
    const node = ctx.stack.pop();
    emitError(ctx.onError, "INLINE_NOT_CLOSED", ctx.text, node.openPos, node.openLen);
    pushTextToCurrent(ctx, ctx.text.slice(node.openPos, node.openPos + node.openLen));
    node.tokens.forEach((t) => {
      if (t.type === "text" && typeof t.value === "string") {
        pushTextToCurrent(ctx, t.value);
      } else {
        getCurrentTokens(ctx).push(t);
      }
    });
  }
};

// src/chars.ts
var isTagStartChar = (c) => c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c === "_";
var isTagChar = (c) => c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c >= "0" && c <= "9" || c === "_" || c === "-";
var getLineEnd = (text, pos) => {
  const end = text.indexOf("\n", pos);
  if (end === -1) return text.length;
  if (end > pos && text[end - 1] === "\r") return end - 1;
  return end;
};
var isLineStart = (text, pos) => {
  return pos === 0 || text[pos - 1] === "\n";
};
var isWholeLineToken = (text, pos, token) => {
  if (!isLineStart(text, pos)) return false;
  if (!text.startsWith(token, pos)) return false;
  const lineEnd = getLineEnd(text, pos);
  return pos + token.length === lineEnd;
};

// src/scanner.ts
var findTagArgClose = (text, start) => {
  const { tagOpen, tagClose } = getSyntax();
  let pos = start;
  let depth = 1;
  while (pos < text.length) {
    const [escaped, next] = readEscapedSequence(text, pos);
    if (escaped !== null) {
      pos = next;
      continue;
    }
    if (text[pos] === tagOpen) {
      depth++;
    } else if (text[pos] === tagClose) {
      depth--;
      if (depth === 0) return pos;
    }
    pos++;
  }
  return -1;
};
var readTagHeadAt = (text, pos) => {
  const { tagPrefix, tagOpen } = getSyntax();
  if (!text.startsWith(tagPrefix, pos)) return null;
  const tagStart = pos + tagPrefix.length;
  if (tagStart >= text.length || !isTagStartChar(text[tagStart])) {
    return null;
  }
  let tagNameEnd = tagStart + 1;
  while (tagNameEnd < text.length && isTagChar(text[tagNameEnd])) {
    tagNameEnd++;
  }
  if (text[tagNameEnd] !== tagOpen) {
    return null;
  }
  return {
    tag: text.slice(tagStart, tagNameEnd),
    tagStart: pos,
    tagNameEnd,
    argStart: tagNameEnd + tagOpen.length
  };
};
var scanInlineBoundary = (text, start, returnCloseStart, fallbackToTextEnd) => {
  const { endTag } = getSyntax();
  let pos = start;
  let depth = 1;
  while (pos < text.length) {
    const [escaped, next] = readEscapedSequence(text, pos);
    if (escaped !== null) {
      pos = next;
      continue;
    }
    const head = readTagHeadAt(text, pos);
    if (head) {
      depth++;
      pos = head.argStart;
      continue;
    }
    if (text.startsWith(endTag, pos)) {
      depth--;
      const closeEnd = pos + endTag.length;
      if (depth === 0) {
        return returnCloseStart ? pos : closeEnd;
      }
      pos = closeEnd;
      continue;
    }
    pos++;
  }
  return fallbackToTextEnd ? text.length : -1;
};
var getTagCloserType = (text, tagOpenIndex) => {
  const { blockOpen, blockClose, rawOpen, rawClose, endTag } = getSyntax();
  const argClose = findTagArgClose(text, tagOpenIndex);
  if (argClose === -1) return null;
  if (text.startsWith(blockOpen, argClose)) {
    return { closer: blockClose, argClose };
  }
  if (text.startsWith(rawOpen, argClose)) {
    return { closer: rawClose, argClose };
  }
  return { closer: endTag, argClose };
};
var findInlineClose = (text, start) => {
  return scanInlineBoundary(text, start, true, false);
};
var findBlockClose = (text, start) => {
  const { blockClose, rawClose, rawOpen, blockOpen, endTag } = getSyntax();
  let pos = start;
  let depth = 1;
  while (pos < text.length) {
    const [escaped, next] = readEscapedSequence(text, pos);
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
    const head = readTagHeadAt(text, pos);
    if (head) {
      const tagInfo = getTagCloserType(text, head.argStart);
      if (tagInfo?.closer === rawClose) {
        const rawStart = tagInfo.argClose + rawOpen.length;
        const rawEnd = findRawClose(text, rawStart);
        if (rawEnd === -1) return -1;
        pos = rawEnd + rawClose.length;
        continue;
      }
      if (tagInfo?.closer === blockClose) {
        depth++;
        pos = tagInfo.argClose + blockOpen.length;
        continue;
      }
      if (tagInfo?.closer === endTag) {
        const inlineEnd = findInlineClose(text, head.argStart);
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
var findRawClose = (text, start) => {
  const { rawClose } = getSyntax();
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
var findMalformedWholeLineTokenCandidate = (text, start, token) => {
  let pos = start;
  while (pos < text.length) {
    const lineEnd = text.indexOf("\n", pos);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(pos, end);
    const leadingWhitespace = line.length - line.trimStart().length;
    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith(token) && line !== token) {
      return {
        index: pos + leadingWhitespace,
        length: trimmedStart.length
      };
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return null;
};
var skipDegradedInline = (text, start) => {
  return scanInlineBoundary(text, start, false, true);
};
var readTagStartInfo = (text, i) => {
  const head = readTagHeadAt(text, i);
  if (!head) return null;
  return {
    tag: head.tag,
    tagOpenPos: head.tagStart,
    tagNameEnd: head.tagNameEnd,
    inlineContentStart: head.argStart
  };
};

// src/blockTagFormatting.ts
var stripSingleLeadingLineBreak = (text) => {
  if (text.startsWith("\r\n")) return text.slice(2);
  if (text.startsWith("\n")) return text.slice(1);
  return text;
};
var consumeSingleTrailingLineBreak = (text, index) => {
  if (text.startsWith("\r\n", index)) return index + 2;
  if (text[index] === "\n") return index + 1;
  return index;
};
var normalizeBlockTagContent = (tag, content, mode, blockTagSet) => {
  if (!blockTagSet.has(tag)) return content;
  if (mode === "highlight") return content;
  return stripSingleLeadingLineBreak(content);
};
var consumeBlockTagTrailingLineBreak = (tag, text, index, mode, blockTagSet) => {
  if (!blockTagSet.has(tag)) return index;
  if (mode === "highlight") return index;
  return consumeSingleTrailingLineBreak(text, index);
};

// src/complex.ts
var tryParseComplexTag = (text, tagOpenPos, tag, tagNameEnd, inlineEnd, depthLimit, mode, handlers, blockTagSet, parseInlineContent) => {
  const handler = handlers[tag];
  if (!handler?.raw && !handler?.block) {
    return { handled: false, nextIndex: tagNameEnd };
  }
  const argClose = findTagArgClose(text, tagNameEnd + 1);
  if (argClose === -1) {
    return { handled: false, nextIndex: tagNameEnd };
  }
  const { blockOpen, blockClose, rawOpen, rawClose, escapeChar } = getSyntax();
  const isBlock = text.startsWith(blockOpen, argClose);
  const isRaw = text.startsWith(rawOpen, argClose);
  if (!isBlock && !isRaw) {
    return { handled: false, nextIndex: tagNameEnd };
  }
  if (inlineEnd !== -1 && inlineEnd <= argClose) {
    return { handled: false, nextIndex: tagNameEnd };
  }
  if (isBlock) {
    const contentStart2 = argClose + blockOpen.length;
    const end2 = findBlockClose(text, contentStart2);
    if (end2 === -1) {
      const malformedCloseCandidate = findMalformedWholeLineTokenCandidate(
        text,
        contentStart2,
        blockClose
      );
      return {
        handled: true,
        nextIndex: contentStart2,
        fallbackText: text.slice(tagOpenPos, contentStart2),
        error: malformedCloseCandidate ? {
          code: "BLOCK_CLOSE_MALFORMED",
          index: malformedCloseCandidate.index,
          length: malformedCloseCandidate.length
        } : {
          code: "BLOCK_NOT_CLOSED",
          index: tagOpenPos,
          length: contentStart2 - tagOpenPos
        }
      };
    }
    if (!handler.block) {
      return {
        handled: true,
        nextIndex: consumeBlockTagTrailingLineBreak(
          tag,
          text,
          end2 + blockClose.length,
          mode,
          blockTagSet
        ),
        fallbackText: text.slice(tagOpenPos, end2 + blockClose.length)
      };
    }
    const arg2 = text.slice(tagNameEnd + 1, argClose).trim();
    const blockContent = normalizeBlockTagContent(
      tag,
      text.slice(contentStart2, end2),
      mode,
      blockTagSet
    );
    return {
      handled: true,
      nextIndex: consumeBlockTagTrailingLineBreak(
        tag,
        text,
        end2 + blockClose.length,
        mode,
        blockTagSet
      ),
      token: createToken(
        handler.block(arg2, parseInlineContent(blockContent, Math.max(depthLimit - 1, 0), { mode }))
      )
    };
  }
  const contentStart = argClose + rawOpen.length;
  const end = findRawClose(text, contentStart);
  if (end === -1) {
    const malformedCloseCandidate = findMalformedWholeLineTokenCandidate(
      text,
      contentStart,
      rawClose
    );
    return {
      handled: true,
      nextIndex: contentStart,
      fallbackText: text.slice(tagOpenPos, contentStart),
      error: malformedCloseCandidate ? {
        code: "RAW_CLOSE_MALFORMED",
        index: malformedCloseCandidate.index,
        length: malformedCloseCandidate.length
      } : {
        code: "RAW_NOT_CLOSED",
        index: tagOpenPos,
        length: contentStart - tagOpenPos
      }
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
        blockTagSet
      ),
      fallbackText: text.slice(tagOpenPos, end + rawClose.length)
    };
  }
  const arg = text.slice(tagNameEnd + 1, argClose).trim();
  const rawContent = text.slice(contentStart, end);
  const normalizedRawContent = mode === "highlight" ? rawContent : rawContent.split(escapeChar + rawClose).join(rawClose);
  const content = normalizeBlockTagContent(tag, normalizedRawContent, mode, blockTagSet);
  return {
    handled: true,
    nextIndex: consumeBlockTagTrailingLineBreak(
      tag,
      text,
      end + rawClose.length,
      mode,
      blockTagSet
    ),
    token: createToken(handler.raw(arg, content))
  };
};

// src/consumers.ts
var tryConsumeDepthLimitedTag = (ctx, info) => {
  if (ctx.stack.length < ctx.depthLimit) return false;
  const { endTag, blockClose, blockOpen, rawClose, rawOpen } = getSyntax();
  if (ctx.stack.length === ctx.depthLimit) {
    emitError(
      ctx.onError,
      "DEPTH_LIMIT",
      ctx.text,
      ctx.i,
      info.inlineContentStart - info.tagOpenPos
    );
  }
  const tagInfo = getTagCloserType(ctx.text, info.tagNameEnd + 1);
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
      ctx.blockTagSet
    );
    return true;
  }
  return false;
};
var tryConsumeComplexTag = (ctx, info, inlineEnd, parseInlineContent) => {
  const result = tryParseComplexTag(
    ctx.text,
    info.tagOpenPos,
    info.tag,
    info.tagNameEnd,
    inlineEnd,
    ctx.depthLimit,
    ctx.mode,
    ctx.handlers,
    ctx.blockTagSet,
    parseInlineContent
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
var tryConsumeInlineTag = (ctx, info, inlineEnd) => {
  if (inlineEnd === -1) {
    emitError(
      ctx.onError,
      "INLINE_NOT_CLOSED",
      ctx.text,
      info.tagOpenPos,
      info.inlineContentStart - info.tagOpenPos
    );
    ctx.buffer += ctx.text.slice(ctx.i, info.inlineContentStart);
    ctx.i = info.inlineContentStart;
    return true;
  }
  ctx.stack.push({
    tag: info.tag,
    richType: info.tag in ctx.handlers ? info.tag : null,
    tokens: [],
    openPos: info.tagOpenPos,
    openLen: info.inlineContentStart - info.tagOpenPos
  });
  ctx.i = info.inlineContentStart;
  return true;
};
var tryConsumeTagStart = (ctx, parseInlineContent) => {
  const info = readTagStartInfo(ctx.text, ctx.i);
  if (!info) return false;
  flushBuffer(ctx);
  if (tryConsumeDepthLimitedTag(ctx, info)) return true;
  const inlineEnd = findInlineClose(ctx.text, info.inlineContentStart);
  if (tryConsumeComplexTag(ctx, info, inlineEnd, parseInlineContent)) return true;
  return tryConsumeInlineTag(ctx, info, inlineEnd);
};
var finalizeClosedNode = (ctx, node) => {
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
    handler?.inline ? createToken(handler.inline(node.tokens)) : createToken({
      type: node.richType,
      value: materializedTokens
    })
  );
};
var tryConsumeTagClose = (ctx) => {
  const { endTag } = getSyntax();
  if (!ctx.text.startsWith(endTag, ctx.i)) return false;
  if (ctx.stack.length === 0) {
    emitError(ctx.onError, "UNEXPECTED_CLOSE", ctx.text, ctx.i, endTag.length);
    ctx.buffer += endTag;
    ctx.i += endTag.length;
    return true;
  }
  flushBuffer(ctx);
  const node = ctx.stack.pop();
  finalizeClosedNode(ctx, node);
  ctx.i += endTag.length;
  ctx.i = consumeBlockTagTrailingLineBreak(node.tag, ctx.text, ctx.i, ctx.mode, ctx.blockTagSet);
  return true;
};
var tryConsumeEscape = (ctx) => {
  const { escapeChar } = getSyntax();
  if (ctx.text[ctx.i] !== escapeChar || ctx.i + 1 >= ctx.text.length) {
    return false;
  }
  const [char, next] = readEscaped(ctx.text, ctx.i);
  ctx.buffer += ctx.stack.length > 0 ? ctx.text.slice(ctx.i, next) : char;
  ctx.i = next;
  return true;
};

// src/parse.ts
var deriveBlockTags = (handlers) => {
  const set = /* @__PURE__ */ new Set();
  for (const [tag, handler] of Object.entries(handlers)) {
    const h = handler;
    if (h.raw || h.block) set.add(tag);
  }
  return set;
};
var internalParse = (text, depthLimit, options, onError, handlers, blockTagSet) => {
  if (!text) return [];
  const ctx = {
    text,
    depthLimit,
    mode: options?.mode ?? "render",
    onError,
    handlers,
    blockTagSet,
    root: [],
    stack: [],
    buffer: "",
    i: 0
  };
  const recursiveParse = (innerText, innerDepthLimit, innerOptions) => {
    return internalParse(innerText, innerDepthLimit, innerOptions, onError, handlers, blockTagSet);
  };
  while (ctx.i < ctx.text.length) {
    if (tryConsumeTagStart(ctx, recursiveParse)) continue;
    if (tryConsumeTagClose(ctx)) continue;
    if (tryConsumeEscape(ctx)) continue;
    ctx.buffer += ctx.text[ctx.i];
    ctx.i++;
  }
  flushBuffer(ctx);
  finalizeUnclosedTags(ctx);
  return ctx.root;
};
var parseRichText = (text, options = {}) => {
  if (!text) return [];
  const handlers = options.handlers ?? {};
  const blockTagSet = options.blockTags ? new Set(options.blockTags) : deriveBlockTags(handlers);
  const syntax = createSyntax(options.syntax);
  return withSyntax(
    syntax,
    () => internalParse(
      text,
      options.depthLimit ?? 50,
      { mode: options.mode ?? "render" },
      options.onError,
      handlers,
      blockTagSet
    )
  );
};
var stripRichText = (text, options = {}) => {
  if (!text) return "";
  const tokens = parseRichText(text, options);
  return extractText(tokens);
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_SYNTAX,
  createSyntax,
  createToken,
  extractText,
  materializeTextTokens,
  parsePipeArgs,
  parsePipeTextArgs,
  parseRichText,
  resetTokenIdSeed,
  splitTokensByPipe,
  stripRichText,
  unescapeInline
});
//# sourceMappingURL=index.cjs.map