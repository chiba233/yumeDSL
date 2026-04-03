import type {
  BufferState,
  ParseError,
  SourceSpan,
  StructuralNode,
  StructuralParseOptions,
  SyntaxConfig,
  TagNameConfig,
} from "./types.js";
import { getDefaultSyntaxInstance, getSyntax } from "./syntax.js";
import { DEFAULT_TAG_NAME, getTagNameConfig } from "./chars.js";
import { warnDeprecated } from "./deprecations.js";
import { readEscapedSequence } from "./escape.js";
import { supportsInlineForm } from "./resolveOptions.js";
import { emitError } from "./errors.js";
import {
  readTagStartInfo,
  getTagCloserType,
  findInlineClose,
  findBlockClose,
  findRawClose,
  findMalformedWholeLineTokenCandidate,
  skipTagBoundary,
} from "./scanner.js";
import { makePosition, type PositionTracker } from "./positions.js";
import { type GatingContext, buildGatingContext, resolveBaseOptions } from "./resolveOptions.js";

const emptyBuffer = (): BufferState => ({ content: "", start: -1, sourceEnd: -1 });

// ── IndexedStructuralNode ──

// 注意：_meta 分两种形状。
// LeafMeta 给 text/escape/separator——只有源码区间。
// TagMeta 给 inline/raw/block——保证 argStart/argEnd/contentStart/contentEnd 全部存在，
// render 层不需要做 === undefined 防御。
// 如果你给 tag 节点塞了 LeafMeta，render 侧会直接降级回源码原文。

export interface LeafMeta {
  start: number;
  end: number;
}

export interface TagMeta {
  start: number;
  end: number;
  argStart: number;
  argEnd: number;
  contentStart: number;
  contentEnd: number;
}

export type IndexedStructuralNode =
  | { type: "text"; value: string; _meta: LeafMeta; position?: SourceSpan }
  | { type: "escape"; raw: string; _meta: LeafMeta; position?: SourceSpan }
  | { type: "separator"; _meta: LeafMeta; position?: SourceSpan }
  | { type: "inline"; tag: string; children: IndexedStructuralNode[]; _meta: TagMeta; position?: SourceSpan }
  | { type: "raw"; tag: string; args: IndexedStructuralNode[]; content: string; _meta: TagMeta; position?: SourceSpan }
  | { type: "block"; tag: string; args: IndexedStructuralNode[]; children: IndexedStructuralNode[]; _meta: TagMeta; position?: SourceSpan };

const pushNode = (
  nodes: IndexedStructuralNode[],
  node: IndexedStructuralNode,
  position: SourceSpan | undefined,
) => {
  if (position) node.position = position;
  nodes.push(node);
};

const stripMeta = (node: IndexedStructuralNode): StructuralNode => {
  const pos = node.position;
  switch (node.type) {
    case "text":      return { type: "text", value: node.value, ...(pos && { position: pos }) };
    case "escape":    return { type: "escape", raw: node.raw, ...(pos && { position: pos }) };
    case "separator": return { type: "separator", ...(pos && { position: pos }) };
    case "inline":    return { type: "inline", tag: node.tag, children: node.children.map(stripMeta), ...(pos && { position: pos }) };
    case "raw":       return { type: "raw", tag: node.tag, args: node.args.map(stripMeta), content: node.content, ...(pos && { position: pos }) };
    case "block":     return { type: "block", tag: node.tag, args: node.args.map(stripMeta), children: node.children.map(stripMeta), ...(pos && { position: pos }) };
  }
};

// ── Structural parser ──

/** Stable config that stays the same across all recursive `parseNodes` calls. */
interface ScanContext {
  depthLimit: number;
  gating: GatingContext | null;
  tracker: PositionTracker | null;
  syntax: SyntaxConfig;
  tagName: TagNameConfig;
  onError?: (error: ParseError) => void;
}

// 注意：下面 scanInline / scanRaw / scanBlock / tryInlineFallback 四个函数
// 和 parseNodes 主循环共用同一套返回值约定：
// - 返回 nextI：调用方把 i 推进到这里
// - node !== null：调用方先 flush 再 push
// - node === null + bufferAppend：调用方把文本追加进 buffer（退化路径）
// 不要在这些函数里自己 flush 或 push，否则主循环的状态会乱。

interface ScanResult {
  nextI: number;
  node: IndexedStructuralNode | null;
  bufferAppend: string;
}

type TagStartInfo = NonNullable<ReturnType<typeof readTagStartInfo>>;
type CloserInfo = NonNullable<ReturnType<typeof getTagCloserType>>;

// ── Inline: $$tag(…)$$ ──

// 注意：nextI 必须覆盖完整 endTag；少吃一个字符，后面的源码 span 会整体错位。
const buildInlineResult = (
  text: string,
  i: number,
  info: TagStartInfo,
  closeStart: number,
  depth: number,
  baseOffset: number,
  ctx: ScanContext,
): ScanResult => {
  const nextI = closeStart + ctx.syntax.endTag.length;
  const node: IndexedStructuralNode = {
    type: "inline",
    tag: info.tag,
    children: parseNodes(text.slice(info.argStart, closeStart), depth + 1, ctx, true, baseOffset + info.argStart),
    _meta: {
      start: baseOffset + i,
      end: baseOffset + nextI,
      argStart: baseOffset + info.argStart,
      argEnd: baseOffset + closeStart,
      contentStart: baseOffset + info.argStart,
      contentEnd: baseOffset + closeStart,
    },
  };
  const position = makePosition(ctx.tracker, baseOffset + i, baseOffset + nextI);
  if (position) node.position = position;
  return { nextI, node, bufferAppend: "" };
};

const scanInline = (
  text: string,
  i: number,
  info: TagStartInfo,
  depth: number,
  baseOffset: number,
  ctx: ScanContext,
): ScanResult | null => {
  const { syntax, tagName, tracker, onError, gating } = ctx;

  // form gating: 不支持 inline 的标签直接跳过
  if (
    gating &&
    !supportsInlineForm(gating.handlers[info.tag], gating.allowInline, gating.registeredTags.has(info.tag))
  ) {
    return { nextI: i + 1, node: null, bufferAppend: text[i] };
  }

  const closeStart = findInlineClose(text, info.argStart, syntax, tagName);
  if (closeStart === -1) {
    emitError(tracker, onError, "INLINE_NOT_CLOSED", text, i, info.argStart - info.tagOpenPos);
    return { nextI: info.argStart, node: null, bufferAppend: text.slice(i, info.argStart) };
  }

  return buildInlineResult(text, i, info, closeStart, depth, baseOffset, ctx);
};

// ── Complex form 没有 raw/block handler 时，尝试退化为 inline ──

const tryInlineFallback = (
  text: string,
  i: number,
  info: TagStartInfo,
  depth: number,
  baseOffset: number,
  gating: GatingContext,
  ctx: ScanContext,
): ScanResult => {
  if (!supportsInlineForm(gating.handlers[info.tag], gating.allowInline, gating.registeredTags.has(info.tag))) {
    return { nextI: i + 1, node: null, bufferAppend: text[i] };
  }

  const closeStart = findInlineClose(text, info.argStart, ctx.syntax, ctx.tagName);
  if (closeStart === -1) {
    return { nextI: info.argStart, node: null, bufferAppend: text.slice(i, info.argStart) };
  }

  return buildInlineResult(text, i, info, closeStart, depth, baseOffset, ctx);
};

// ── Raw: $$tag(args)% content %end$$ ──

const scanRaw = (
  text: string,
  i: number,
  info: TagStartInfo,
  closerInfo: CloserInfo,
  depth: number,
  baseOffset: number,
  ctx: ScanContext,
): ScanResult => {
  const { syntax, tracker, onError, gating } = ctx;
  const { rawOpen, rawClose } = syntax;

  // 注意：raw 的 args 和 content 起点不一样。
  // `argStart` 是参数区起点，`contentStart` 才是正文起点；
  // 这俩混了以后，args 子节点和 content 整体 position 会一起偏。
  const contentStart = closerInfo.argClose + rawOpen.length;
  const closeStart = findRawClose(text, contentStart, syntax);

  if (closeStart === -1) {
    const malformed = findMalformedWholeLineTokenCandidate(text, contentStart, rawClose);
    emitError(
      tracker, onError,
      malformed ? "RAW_CLOSE_MALFORMED" : "RAW_NOT_CLOSED",
      text,
      malformed?.index ?? i,
      malformed?.length ?? contentStart - i,
    );
    return { nextI: contentStart, node: null, bufferAppend: text.slice(i, contentStart) };
  }

  // gating: handler 不支持 raw → 整段退化
  if (gating && !gating.handlers[info.tag]?.raw) {
    const end = closeStart + rawClose.length;
    return { nextI: end, node: null, bufferAppend: text.slice(i, end) };
  }

  const nextI = closeStart + rawClose.length;
  const node: IndexedStructuralNode = {
    type: "raw",
    tag: info.tag,
    args: parseNodes(text.slice(info.argStart, closerInfo.argClose), depth + 1, ctx, true, baseOffset + info.argStart),
    content: text.slice(contentStart, closeStart),
    _meta: {
      start: baseOffset + i,
      end: baseOffset + nextI,
      argStart: baseOffset + info.argStart,
      argEnd: baseOffset + closerInfo.argClose,
      contentStart: baseOffset + contentStart,
      contentEnd: baseOffset + closeStart,
    },
  };
  const position = makePosition(tracker, baseOffset + i, baseOffset + nextI);
  if (position) node.position = position;
  return { nextI, node, bufferAppend: "" };
};

// ── Block: $$tag(args)* content *end$$ ──

const scanBlock = (
  text: string,
  i: number,
  info: TagStartInfo,
  closerInfo: CloserInfo,
  depth: number,
  baseOffset: number,
  ctx: ScanContext,
): ScanResult => {
  const { syntax, tagName, tracker, onError, gating } = ctx;
  const { blockOpen, blockClose } = syntax;

  // 注意：block 同时有 args 子树和 children 子树，
  // 两边的 `baseOffset` 起点不同；一边对一边错时，表面 parse 正常，位置却会成片漂移。
  const contentStart = closerInfo.argClose + blockOpen.length;
  const closeStart = findBlockClose(text, contentStart, syntax, tagName);

  if (closeStart === -1) {
    const malformed = findMalformedWholeLineTokenCandidate(text, contentStart, blockClose);
    emitError(
      tracker, onError,
      malformed ? "BLOCK_CLOSE_MALFORMED" : "BLOCK_NOT_CLOSED",
      text,
      malformed?.index ?? i,
      malformed?.length ?? contentStart - i,
    );
    return { nextI: contentStart, node: null, bufferAppend: text.slice(i, contentStart) };
  }

  // gating: handler 不支持 block → 整段退化
  if (gating && !gating.handlers[info.tag]?.block) {
    const end = closeStart + blockClose.length;
    return { nextI: end, node: null, bufferAppend: text.slice(i, end) };
  }

  const nextI = closeStart + blockClose.length;
  const node: IndexedStructuralNode = {
    type: "block",
    tag: info.tag,
    args: parseNodes(text.slice(info.argStart, closerInfo.argClose), depth + 1, ctx, true, baseOffset + info.argStart),
    children: parseNodes(text.slice(contentStart, closeStart), depth + 1, ctx, false, baseOffset + contentStart),
    _meta: {
      start: baseOffset + i,
      end: baseOffset + nextI,
      argStart: baseOffset + info.argStart,
      argEnd: baseOffset + closerInfo.argClose,
      contentStart: baseOffset + contentStart,
      contentEnd: baseOffset + closeStart,
    },
  };
  const position = makePosition(tracker, baseOffset + i, baseOffset + nextI);
  if (position) node.position = position;
  return { nextI, node, bufferAppend: "" };
};

// ── 主循环 ──

/**
 * Core structural scanning loop.
 *
 * Exported for internal reuse (e.g. zone grouping) — not part of the
 * public API surface. Call {@link parseStructural} for normal use.
 *
 * @internal
 */
export const parseNodes = (
  text: string,
  depth: number,
  ctx: ScanContext,
  insideArgs: boolean,
  baseOffset: number,
): IndexedStructuralNode[] => {
  // 注意：这是 structural parser 的主状态机。
  // 它不走 handler，也不产出运行时 token；这里只有三类核心状态：
  // `i`（扫描指针）、`buf`（待 flush 的纯文本）、`nodes`（当前层结构节点）。
  // 一旦改动"何时 flush / 何时推进 i / 何时递归"，
  // raw/block/inline 的边界和 position 映射都很容易一起偏掉。
  const { depthLimit, gating, tracker, syntax, tagName, onError } = ctx;
  const { tagDivider, tagOpen, endTag, rawClose } = syntax;

  const nodes: IndexedStructuralNode[] = [];
  let i = 0;
  const buf: BufferState = emptyBuffer();

  const flush = () => {
    if (!buf.content) return;
    const position =
      buf.start >= 0 ? makePosition(tracker, baseOffset + buf.start, baseOffset + i) : undefined;
    pushNode(
      nodes,
      {
        type: "text",
        value: buf.content,
        _meta: { start: baseOffset + buf.start, end: baseOffset + i },
      },
      position,
    );
    const reset = emptyBuffer();
    buf.content = reset.content;
    buf.start = reset.start;
    buf.sourceEnd = reset.sourceEnd;
  };

  // 注意：scan* 函数返回 ScanResult，主循环统一处理：
  // node !== null → flush + push；node === null → 追加 buffer。
  // 不要在 scan* 里自己操作 nodes/buf，保持主循环是唯一的状态写入点。
  const applyScanResult = (result: ScanResult) => {
    if (result.node) {
      flush();
      nodes.push(result.node);
    } else if (result.bufferAppend) {
      if (buf.start === -1) buf.start = i;
      buf.content += result.bufferAppend;
    }
    i = result.nextI;
  };

  // 注意：这里同样依赖固定优先级：
  // escape → unexpected close → 参数分隔符 → tag start → 普通文本。
  // 前面命中时必须先 flush，再推进指针；否则节点切分和子节点 position 会错。
  while (i < text.length) {
    // ── Escape sequence ──
    const [escaped, next] = readEscapedSequence(text, i, syntax);
    if (escaped !== null) {
      flush();
      pushNode(
        nodes,
        {
          type: "escape",
          raw: text.slice(i, next),
          _meta: { start: baseOffset + i, end: baseOffset + next },
        },
        makePosition(tracker, baseOffset + i, baseOffset + next),
      );
      i = next;
      continue;
    }

    // ── Unexpected inline close ──
    if (text.startsWith(endTag, i)) {
      emitError(tracker, onError, "UNEXPECTED_CLOSE", text, i, endTag.length);
      if (buf.start === -1) buf.start = i;
      buf.content += endTag;
      i += endTag.length;
      continue;
    }

    // ── Pipe separator (only inside tag argument sections) ──
    if (insideArgs && text.startsWith(tagDivider, i)) {
      flush();
      pushNode(
        nodes,
        {
          type: "separator",
          _meta: { start: baseOffset + i, end: baseOffset + i + tagDivider.length },
        },
        makePosition(tracker, baseOffset + i, baseOffset + i + tagDivider.length),
      );
      i += tagDivider.length;
      continue;
    }

    // ── Tag start ──
    const info = readTagStartInfo(text, i, syntax, tagName);
    if (!info) {
      if (buf.start === -1) buf.start = i;
      buf.content += text[i];
      i++;
      continue;
    }

    // ── Depth limit → skip entire tag ──
    if (depth >= depthLimit) {
      emitError(tracker, onError, "DEPTH_LIMIT", text, i, info.argStart - info.tagOpenPos);
      const degradedEnd = skipTagBoundary(text, info, syntax, tagName);
      if (buf.start === -1) buf.start = i;
      buf.content += text.slice(i, degradedEnd);
      i = degradedEnd;
      continue;
    }

    const closerInfo = getTagCloserType(text, info.tagNameEnd + tagOpen.length, syntax);
    if (!closerInfo) {
      const handler = gating?.handlers[info.tag];
      const isRegistered = gating?.registeredTags.has(info.tag) ?? false;
      const canAttemptInline = gating
        ? supportsInlineForm(handler, gating.allowInline, isRegistered)
        : true;
      if (canAttemptInline) {
        emitError(tracker, onError, "INLINE_NOT_CLOSED", text, i, info.argStart - info.tagOpenPos);
      }
      if (buf.start === -1) buf.start = i;
      buf.content += text.slice(i, info.argStart);
      i = info.argStart;
      continue;
    }

    // ── 按 closer 类型分发 ──
    // 注意：inline / raw / block 三段是并排的同构分支。
    // 如果你只修其中一段，不同步检查另外两段，位置映射和退化行为大概率会分叉。

    if (closerInfo.closer === endTag) {
      const result = scanInline(text, i, info, depth, baseOffset, ctx);
      if (!result) {
        // scanInline 返回 null 表示 gating 拒绝了，当普通字符处理
        if (buf.start === -1) buf.start = i;
        buf.content += text[i];
        i++;
      } else {
        applyScanResult(result);
      }
      continue;
    }

    // complex form 的标签如果没有 raw/block handler，尝试走 inline fallback
    if (gating) {
      const handler = gating.handlers[info.tag];
      if (!handler?.raw && !handler?.block) {
        applyScanResult(tryInlineFallback(text, i, info, depth, baseOffset, gating, ctx));
        continue;
      }
    }

    if (closerInfo.closer === rawClose) {
      applyScanResult(scanRaw(text, i, info, closerInfo, depth, baseOffset, ctx));
      continue;
    }

    applyScanResult(scanBlock(text, i, info, closerInfo, depth, baseOffset, ctx));
  }

  flush();
  return nodes;
};

// ── Public API ──

export const parseStructuralInternal = (
  text: string,
  options?: StructuralParseOptions & { onError?: (error: ParseError) => void },
): IndexedStructuralNode[] => {
  if (!text) return [];

  let legacySyntax: SyntaxConfig | undefined;
  if (!options?.syntax) {
    const ambient = getSyntax({ suppressDeprecation: true });
    if (ambient !== getDefaultSyntaxInstance()) {
      warnDeprecated(
        "parseStructural.syntax",
        "parseStructural() is reading ambient withSyntax(). Pass syntax explicitly via options.syntax instead.",
      );
      legacySyntax = ambient;
    }
  }

  let legacyTagName: TagNameConfig | undefined;
  if (!options?.tagName) {
    const ambient = getTagNameConfig();
    if (ambient !== DEFAULT_TAG_NAME) {
      warnDeprecated(
        "parseStructural.tagName",
        "parseStructural() is reading ambient withTagNameConfig(). Pass tagName explicitly via options.tagName instead.",
      );
      legacyTagName = ambient;
    }
  }

  const { syntax, tagName, depthLimit, tracker } = resolveBaseOptions(text, options, {
    syntax: legacySyntax,
    tagName: legacyTagName,
  });

  const gating = options?.handlers
    ? buildGatingContext(options.handlers, options.allowForms)
    : null;

  const ctx: ScanContext = { depthLimit, gating, tracker, syntax, tagName, onError: options?.onError };
  return parseNodes(text, 0, ctx, false, 0);
};

/**
 * Parse rich-text DSL into a structural tree that preserves tag forms.
 *
 * When `handlers` is provided, tag recognition and form gating follow the
 * exact same rules as {@link parseRichText}:
 *
 * - Only registered tags are recognized; unknown tags pass through as inline.
 * - `allowForms` restricts which syntactic forms are accepted.
 * - Handler method presence (`inline` / `raw` / `block`) determines per-tag form support.
 *
 * When `handlers` is omitted, **all** tags in **all** forms are accepted.
 *
 * When `syntax` / `tagName` are omitted, defaults to {@link DEFAULT_SYNTAX} /
 * {@link DEFAULT_TAG_NAME}. Legacy `withSyntax` / `withTagNameConfig` ambient
 * wrapping is detected and used as a fallback with a deprecation warning.
 */
export const parseStructural = (
  text: string,
  options?: StructuralParseOptions,
): StructuralNode[] => {
  return parseStructuralInternal(text, options).map(stripMeta);
};
