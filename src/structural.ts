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
  interface StripFrame {
    node: IndexedStructuralNode;
    stage: "enter" | "build";
  }

  const completed = new Map<IndexedStructuralNode, StructuralNode>();
  const stack: StripFrame[] = [{ node, stage: "enter" }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;

    if (frame.stage === "build") {
      const current = frame.node;
      const pos = current.position;
      switch (current.type) {
        case "text":
          completed.set(current, { type: "text", value: current.value, ...(pos && { position: pos }) });
          break;
        case "escape":
          completed.set(current, { type: "escape", raw: current.raw, ...(pos && { position: pos }) });
          break;
        case "separator":
          completed.set(current, { type: "separator", ...(pos && { position: pos }) });
          break;
        case "inline":
          completed.set(current, {
            type: "inline",
            tag: current.tag,
            children: current.children.map((child) => completed.get(child) as StructuralNode),
            ...(pos && { position: pos }),
          });
          break;
        case "raw":
          completed.set(current, {
            type: "raw",
            tag: current.tag,
            args: current.args.map((child) => completed.get(child) as StructuralNode),
            content: current.content,
            ...(pos && { position: pos }),
          });
          break;
        case "block":
          completed.set(current, {
            type: "block",
            tag: current.tag,
            args: current.args.map((child) => completed.get(child) as StructuralNode),
            children: current.children.map((child) => completed.get(child) as StructuralNode),
            ...(pos && { position: pos }),
          });
          break;
      }
      continue;
    }

    stack.push({ node: frame.node, stage: "build" });
    switch (frame.node.type) {
      case "inline":
        for (let i = frame.node.children.length - 1; i >= 0; i--) {
          stack.push({ node: frame.node.children[i], stage: "enter" });
        }
        break;
      case "raw":
        for (let i = frame.node.args.length - 1; i >= 0; i--) {
          stack.push({ node: frame.node.args[i], stage: "enter" });
        }
        break;
      case "block":
        for (let i = frame.node.children.length - 1; i >= 0; i--) {
          stack.push({ node: frame.node.children[i], stage: "enter" });
        }
        for (let i = frame.node.args.length - 1; i >= 0; i--) {
          stack.push({ node: frame.node.args[i], stage: "enter" });
        }
        break;
    }
  }

  return completed.get(node) as StructuralNode;
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

type TagStartInfo = NonNullable<ReturnType<typeof readTagStartInfo>>;

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

  interface ParseFrame {
    text: string;
    depth: number;
    insideArgs: boolean;
    baseOffset: number;
    i: number;
    nodes: IndexedStructuralNode[];
    buf: BufferState;
    resume: ((childNodes: IndexedStructuralNode[]) => void) | null;
  }

  const createFrame = (
    frameText: string,
    frameDepth: number,
    frameInsideArgs: boolean,
    frameBaseOffset: number,
    resume: ((childNodes: IndexedStructuralNode[]) => void) | null,
  ): ParseFrame => ({
    text: frameText,
    depth: frameDepth,
    insideArgs: frameInsideArgs,
    baseOffset: frameBaseOffset,
    i: 0,
    nodes: [],
    buf: emptyBuffer(),
    resume,
  });

  const flushFrame = (frame: ParseFrame) => {
    if (!frame.buf.content) return;
    const position =
      frame.buf.start >= 0
        ? makePosition(tracker, frame.baseOffset + frame.buf.start, frame.baseOffset + frame.i)
        : undefined;
    pushNode(
      frame.nodes,
      {
        type: "text",
        value: frame.buf.content,
        _meta: { start: frame.baseOffset + frame.buf.start, end: frame.baseOffset + frame.i },
      },
      position,
    );
    const reset = emptyBuffer();
    frame.buf.content = reset.content;
    frame.buf.start = reset.start;
    frame.buf.sourceEnd = reset.sourceEnd;
  };

  const appendBuffer = (frame: ParseFrame, content: string, start: number) => {
    if (!content) return;
    if (frame.buf.start === -1) frame.buf.start = start;
    frame.buf.content += content;
  };

  const pushInlineFrame = (
    frame: ParseFrame,
    info: TagStartInfo,
    closeStart: number,
  ) => {
    const nextI = closeStart + endTag.length;
    const meta: TagMeta = {
      start: frame.baseOffset + frame.i,
      end: frame.baseOffset + nextI,
      argStart: frame.baseOffset + info.argStart,
      argEnd: frame.baseOffset + closeStart,
      contentStart: frame.baseOffset + info.argStart,
      contentEnd: frame.baseOffset + closeStart,
    };
    const position = makePosition(tracker, frame.baseOffset + frame.i, frame.baseOffset + nextI);

    flushFrame(frame);
    frame.i = nextI;
    stack.push(createFrame(frame.text.slice(info.argStart, closeStart), frame.depth + 1, true, frame.baseOffset + info.argStart, (children) => {
      pushNode(frame.nodes, { type: "inline", tag: info.tag, children, _meta: meta }, position);
    }));
  };

  const prepareComplexTag = (
    frame: ParseFrame,
    info: TagStartInfo,
    argClose: number,
    contentStart: number,
    closeStart: number,
    closeLength: number,
  ) => {
    const nextI = closeStart + closeLength;
    const meta: TagMeta = {
      start: frame.baseOffset + frame.i,
      end: frame.baseOffset + nextI,
      argStart: frame.baseOffset + info.argStart,
      argEnd: frame.baseOffset + argClose,
      contentStart: frame.baseOffset + contentStart,
      contentEnd: frame.baseOffset + closeStart,
    };
    const position = makePosition(tracker, frame.baseOffset + frame.i, frame.baseOffset + nextI);
    const argText = frame.text.slice(info.argStart, argClose);
    const contentText = frame.text.slice(contentStart, closeStart);
    flushFrame(frame);
    frame.i = nextI;
    return { meta, position, argText, contentText };
  };

  const stack: ParseFrame[] = [createFrame(text, depth, insideArgs, baseOffset, null)];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.i >= frame.text.length) {
      flushFrame(frame);
      const completedNodes = frame.nodes;
      const resume = frame.resume;
      stack.pop();
      if (!resume) return completedNodes;
      resume(completedNodes);
      continue;
    }

    const frameText = frame.text;
    const i = frame.i;

    // ── Escape sequence ──
    const [escaped, next] = readEscapedSequence(frameText, i, syntax);
    if (escaped !== null) {
      flushFrame(frame);
      pushNode(
        frame.nodes,
        {
          type: "escape",
          raw: frameText.slice(i, next),
          _meta: { start: frame.baseOffset + i, end: frame.baseOffset + next },
        },
        makePosition(tracker, frame.baseOffset + i, frame.baseOffset + next),
      );
      frame.i = next;
      continue;
    }

    // ── Unexpected inline close ──
    if (frameText.startsWith(endTag, i)) {
      emitError(tracker, onError, "UNEXPECTED_CLOSE", frameText, i, endTag.length);
      appendBuffer(frame, endTag, i);
      frame.i += endTag.length;
      continue;
    }

    // ── Pipe separator (only inside tag argument sections) ──
    if (frame.insideArgs && frameText.startsWith(tagDivider, i)) {
      flushFrame(frame);
      pushNode(
        frame.nodes,
        {
          type: "separator",
          _meta: { start: frame.baseOffset + i, end: frame.baseOffset + i + tagDivider.length },
        },
        makePosition(tracker, frame.baseOffset + i, frame.baseOffset + i + tagDivider.length),
      );
      frame.i += tagDivider.length;
      continue;
    }

    // ── Tag start ──
    const info = readTagStartInfo(frameText, i, syntax, tagName);
    if (!info) {
      appendBuffer(frame, frameText[i], i);
      frame.i++;
      continue;
    }

    // ── Depth limit → skip entire tag ──
    if (frame.depth >= depthLimit) {
      emitError(tracker, onError, "DEPTH_LIMIT", frameText, i, info.argStart - info.tagOpenPos);
      const degradedEnd = skipTagBoundary(frameText, info, syntax, tagName);
      appendBuffer(frame, frameText.slice(i, degradedEnd), i);
      frame.i = degradedEnd;
      continue;
    }

    const closerInfo = getTagCloserType(frameText, info.tagNameEnd + tagOpen.length, syntax);
    if (!closerInfo) {
      const handler = gating?.handlers[info.tag];
      const isRegistered = gating?.registeredTags.has(info.tag) ?? false;
      const canAttemptInline = gating
        ? supportsInlineForm(handler, gating.allowInline, isRegistered)
        : true;
      if (canAttemptInline) {
        emitError(tracker, onError, "INLINE_NOT_CLOSED", frameText, i, info.argStart - info.tagOpenPos);
      }
      appendBuffer(frame, frameText.slice(i, info.argStart), i);
      frame.i = info.argStart;
      continue;
    }

    if (closerInfo.closer === endTag) {
      if (
        gating &&
        !supportsInlineForm(gating.handlers[info.tag], gating.allowInline, gating.registeredTags.has(info.tag))
      ) {
        appendBuffer(frame, frameText[i], i);
        frame.i++;
        continue;
      }

      const closeStart = findInlineClose(frameText, info.argStart, syntax, tagName);
      if (closeStart === -1) {
        emitError(tracker, onError, "INLINE_NOT_CLOSED", frameText, i, info.argStart - info.tagOpenPos);
        appendBuffer(frame, frameText.slice(i, info.argStart), i);
        frame.i = info.argStart;
        continue;
      }

      pushInlineFrame(frame, info, closeStart);
      continue;
    }

    if (gating) {
      const handler = gating.handlers[info.tag];
      if (!handler?.raw && !handler?.block) {
        if (!supportsInlineForm(handler, gating.allowInline, gating.registeredTags.has(info.tag))) {
          appendBuffer(frame, frameText[i], i);
          frame.i++;
          continue;
        }

        const closeStart = findInlineClose(frameText, info.argStart, syntax, tagName);
        if (closeStart === -1) {
          appendBuffer(frame, frameText.slice(i, info.argStart), i);
          frame.i = info.argStart;
          continue;
        }

        pushInlineFrame(frame, info, closeStart);
        continue;
      }
    }

    if (closerInfo.closer === rawClose) {
      const contentStart = closerInfo.argClose + syntax.rawOpen.length;
      const closeStart = findRawClose(frameText, contentStart, syntax);

      if (closeStart === -1) {
        const malformed = findMalformedWholeLineTokenCandidate(frameText, contentStart, syntax.rawClose);
        emitError(
          tracker,
          onError,
          malformed ? "RAW_CLOSE_MALFORMED" : "RAW_NOT_CLOSED",
          frameText,
          malformed?.index ?? i,
          malformed?.length ?? contentStart - i,
        );
        appendBuffer(frame, frameText.slice(i, contentStart), i);
        frame.i = contentStart;
        continue;
      }

      if (gating && !gating.handlers[info.tag]?.raw) {
        const end = closeStart + syntax.rawClose.length;
        appendBuffer(frame, frameText.slice(i, end), i);
        frame.i = end;
        continue;
      }

      const { meta, position, argText, contentText: content } = prepareComplexTag(
        frame, info, closerInfo.argClose, contentStart, closeStart, syntax.rawClose.length,
      );
      stack.push(createFrame(argText, frame.depth + 1, true, frame.baseOffset + info.argStart, (args) => {
        pushNode(frame.nodes, {
          type: "raw",
          tag: info.tag,
          args,
          content,
          _meta: meta,
        }, position);
      }));
      continue;
    }

    const contentStart = closerInfo.argClose + syntax.blockOpen.length;
    const closeStart = findBlockClose(frameText, contentStart, syntax, tagName);

    if (closeStart === -1) {
      const malformed = findMalformedWholeLineTokenCandidate(frameText, contentStart, syntax.blockClose);
      emitError(
        tracker,
        onError,
        malformed ? "BLOCK_CLOSE_MALFORMED" : "BLOCK_NOT_CLOSED",
        frameText,
        malformed?.index ?? i,
        malformed?.length ?? contentStart - i,
      );
      appendBuffer(frame, frameText.slice(i, contentStart), i);
      frame.i = contentStart;
      continue;
    }

    if (gating && !gating.handlers[info.tag]?.block) {
      const end = closeStart + syntax.blockClose.length;
      appendBuffer(frame, frameText.slice(i, end), i);
      frame.i = end;
      continue;
    }

    const { meta, position, argText, contentText } = prepareComplexTag(
      frame, info, closerInfo.argClose, contentStart, closeStart, syntax.blockClose.length,
    );
    stack.push(createFrame(argText, frame.depth + 1, true, frame.baseOffset + info.argStart, (args) => {
      stack.push(createFrame(contentText, frame.depth + 1, false, frame.baseOffset + contentStart, (children) => {
        pushNode(frame.nodes, {
          type: "block",
          tag: info.tag,
          args,
          children,
          _meta: meta,
        }, position);
      }));
    }));
  }

  return [];
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
