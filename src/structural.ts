// ═══════════════════════════════════════════════════════════════
// structural.ts — 结构解析器
//
// 文件导航（行号可能因编辑微调，但顺序不变）：
//
//    ~61  IndexedStructuralNode  内部节点类型（带 _meta）
//   ~100  pushNode / stripMeta   节点工具（stripMeta 是迭代式后序遍历）
//   ~182  ScanContext            跨递归层共享的不可变配置
//   ~206  parseNodes             主入口（下面全是它的内部定义）
//
//  parseNodes 内部结构：
//   ~221  ── 帧定义 ──           ParseFrame 接口 + ReturnKind 类型
//   ~265  makeFrame              帧工厂
//   ~295  ── 缓冲区 ──           flushBuffer / appendBuf
//   ~319  ── 子帧完成分发 ──     completeChild：按 returnKind 统一组装节点
//   ~368  buildComplexMeta       raw / block 的 meta + position 构造
//   ~390  pushInlineChild        push inline 子帧（lazy close，不预扫）
//
//  主循环（~411 while）：
//   ~414  帧完成                 textEnd 到达 / inline 未闭合处理
//   ~435  转义序列               readEscapedSequence
//   ~448  inline 帧 argClose     parenDepth 追踪 + )$$ / )% / )* form 判定
//   ~570  非 inline 帧意外 endTag
//   ~578  管道分隔符             insideArgs 时的 | 处理
//   ~590  标签头识别             readTagStartInfo + 裸 ( 的 parenDepth++
//   ~602  深度限制退化           skipTagBoundary
//   ~611  inline 帧嵌套标签      gating 检查 + pushInlineChild（跳过 getTagCloserType）
//   ~630  非 inline 帧 form 判定 getTagCloserType → inline / raw / block 分发
//
//   ~727  ── Public API ──       parseStructuralInternal / parseStructural
// ═══════════════════════════════════════════════════════════════

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

  // ── 帧定义 ──
  //
  // returnKind 决定子帧完成后怎么把结果交给父帧：
  //   null           — 根帧，完成后直接 return
  //   "inline"       — 子节点是 inline 标签的 children；lazy close，不预扫
  //   "rawArgs"      — 子节点是 raw 标签的 args
  //   "blockArgs"    — 子节点是 block 标签的 args；完成后继续 push content 帧
  //   "blockContent" — 子节点是 block 标签的 children
  //
  // 没有 resume 闭包。子帧完成后由 completeChild 按 returnKind 分发。

  type ReturnKind = "inline" | "rawArgs" | "blockArgs" | "blockContent";

  interface ParseFrame {
    text: string;
    depth: number;
    insideArgs: boolean;
    baseOffset: number;
    i: number;
    textEnd: number;            // scan boundary; inline 帧初始为 text.length，其余等于 text.length
    nodes: IndexedStructuralNode[];
    buf: BufferState;

    // ── 返回槽位 ──
    returnKind: ReturnKind | null;
    parentIndex: number;        // parent 在 stack 中的 index
    tag: string;                // 标签名
    meta: TagMeta | null;       // 预算好的 meta（inline 在关闭时才算）
    tagPosition: SourceSpan | undefined;

    // ── inline 专用：lazy close ──
    closingEndTag: string | null; // non-null 表示这个帧遇到 endTag 时自行关闭
    parenDepth: number;         // 裸 ( ) 深度追踪，用于正确匹配 argClose
    tagStartI: number;          // 标签头在 text 中的起始位置
    argStartI: number;          // info.argStart
    tagOpenPos: number;         // info.tagOpenPos，用于 error span

    // ── block 专用：两阶段中间存储 ──
    pendingArgs: IndexedStructuralNode[] | null;  // blockArgs 完成后暂存
    contentText: string;        // block content 切片
    contentBaseOffset: number;  // block content 的 baseOffset
    rawContent: string;         // raw 的正文字符串
  }

  const makeFrame = (
    frameText: string,
    frameDepth: number,
    frameInsideArgs: boolean,
    frameBaseOffset: number,
  ): ParseFrame => ({
    text: frameText,
    depth: frameDepth,
    insideArgs: frameInsideArgs,
    baseOffset: frameBaseOffset,
    i: 0,
    textEnd: frameText.length,
    nodes: [],
    buf: emptyBuffer(),
    returnKind: null,
    parentIndex: -1,
    tag: "",
    meta: null,
    tagPosition: undefined,
    closingEndTag: null,
    parenDepth: 0,
    tagStartI: 0,
    argStartI: 0,
    tagOpenPos: 0,
    pendingArgs: null,
    contentText: "",
    contentBaseOffset: 0,
    rawContent: "",
  });

  // ── 缓冲区 ──

  const flushBuffer = (frame: ParseFrame) => {
    if (!frame.buf.content) return;
    const pos =
      frame.buf.start >= 0
        ? makePosition(tracker, frame.baseOffset + frame.buf.start, frame.baseOffset + frame.i)
        : undefined;
    pushNode(
      frame.nodes,
      { type: "text", value: frame.buf.content, _meta: { start: frame.baseOffset + frame.buf.start, end: frame.baseOffset + frame.i } },
      pos,
    );
    frame.buf.content = "";
    frame.buf.start = -1;
    frame.buf.sourceEnd = -1;
  };

  const appendBuf = (frame: ParseFrame, content: string, start: number) => {
    if (!content) return;
    if (frame.buf.start === -1) frame.buf.start = start;
    frame.buf.content += content;
  };

  // ── 子帧完成分发 ──

  const completeChild = (child: ParseFrame) => {
    const parent = stack[child.parentIndex];
    const childNodes = child.nodes;

    switch (child.returnKind) {
      case "inline": {
        const closeStart = child.i; // child.i 停在 endTag 的位置
        const nextI = closeStart + endTag.length;
        const meta: TagMeta = {
          start: parent.baseOffset + child.tagStartI,
          end: parent.baseOffset + nextI,
          argStart: parent.baseOffset + child.argStartI,
          argEnd: parent.baseOffset + closeStart,
          contentStart: parent.baseOffset + child.argStartI,
          contentEnd: parent.baseOffset + closeStart,
        };
        const pos = makePosition(tracker, meta.start, meta.end);
        parent.i = nextI;
        pushNode(parent.nodes, { type: "inline", tag: child.tag, children: childNodes, _meta: meta }, pos);
        break;
      }
      case "rawArgs":
        pushNode(parent.nodes, {
          type: "raw", tag: child.tag, args: childNodes, content: child.rawContent, _meta: child.meta!,
        }, child.tagPosition);
        break;
      case "blockArgs": {
        // args 完成，暂存后 push content 帧
        parent.pendingArgs = childNodes;
        const content = makeFrame(child.contentText, parent.depth + 1, false, child.contentBaseOffset);
        content.returnKind = "blockContent";
        content.parentIndex = child.parentIndex;
        content.tag = child.tag;
        content.meta = child.meta;
        content.tagPosition = child.tagPosition;
        stack.push(content);
        break;
      }
      case "blockContent":
        pushNode(parent.nodes, {
          type: "block", tag: child.tag, args: parent.pendingArgs!, children: childNodes, _meta: child.meta!,
        }, child.tagPosition);
        parent.pendingArgs = null;
        break;
    }
  };

  // ── meta 构造工具 ──

  const buildComplexMeta = (
    frame: ParseFrame,
    info: TagStartInfo,
    argClose: number,
    contentStart: number,
    closeStart: number,
    closeLength: number,
  ): { meta: TagMeta; pos: SourceSpan | undefined; nextI: number } => {
    const nextI = closeStart + closeLength;
    const meta: TagMeta = {
      start: frame.baseOffset + frame.i,
      end: frame.baseOffset + nextI,
      argStart: frame.baseOffset + info.argStart,
      argEnd: frame.baseOffset + argClose,
      contentStart: frame.baseOffset + contentStart,
      contentEnd: frame.baseOffset + closeStart,
    };
    return { meta, pos: makePosition(tracker, meta.start, meta.end), nextI };
  };

  // ── inline 子帧 push ──
  //
  // gating 检查 + flush + push 一体。返回 true 表示已 push，false 表示 gating 拒绝。
  // 子帧在父帧的 text 上继续逐字符扫描，遇到 )$$ 自动关闭。
  // 不调 findInlineClose / findTagArgClose，每个字符只被访问一次 → O(n)。
  const tryPushInlineChild = (frame: ParseFrame, tagStartI: number, info: TagStartInfo): boolean => {
    if (gating && !supportsInlineForm(gating.handlers[info.tag], gating.allowInline, gating.registeredTags.has(info.tag))) {
      return false;
    }
    flushBuffer(frame);
    const child = makeFrame(frame.text, frame.depth + 1, true, frame.baseOffset);
    child.i = info.argStart;
    child.returnKind = "inline";
    child.parentIndex = stack.length - 1;
    child.tag = info.tag;
    child.closingEndTag = endTag;
    child.tagStartI = tagStartI;
    child.argStartI = info.argStart;
    child.tagOpenPos = info.tagOpenPos;
    stack.push(child);
    return true;
  };

  // ── 主循环 ──

  const stack: ParseFrame[] = [makeFrame(text, depth, insideArgs, baseOffset)];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    // ── 帧完成 ──
    if (frame.i >= frame.textEnd) {
      if (frame.closingEndTag !== null) {
        // inline 帧走到文本末尾仍未关闭 → 未闭合错误
        emitError(tracker, onError, "INLINE_NOT_CLOSED", frame.text, frame.tagStartI, frame.argStartI - frame.tagOpenPos);
        stack.pop();
        const parent = stack[frame.parentIndex];
        appendBuf(parent, frame.text.slice(frame.tagStartI, frame.argStartI), frame.tagStartI);
        parent.i = frame.argStartI;
        continue;
      }
      flushBuffer(frame);
      stack.pop();
      if (frame.returnKind === null) return frame.nodes;
      completeChild(frame);
      continue;
    }

    const frameText = frame.text;
    const i = frame.i;

    // ── 转义序列 ──
    const [escaped, next] = readEscapedSequence(frameText, i, syntax);
    if (escaped !== null) {
      flushBuffer(frame);
      pushNode(
        frame.nodes,
        { type: "escape", raw: frameText.slice(i, next), _meta: { start: frame.baseOffset + i, end: frame.baseOffset + next } },
        makePosition(tracker, frame.baseOffset + i, frame.baseOffset + next),
      );
      frame.i = next;
      continue;
    }

    // ── inline 帧的 argClose 检测 ──
    //
    // inline 帧追踪裸 ( ) 深度。遇到 ) 且 parenDepth === 0 时，
    // 根据后缀判定真实 form：)$$ → inline close，)% → raw，)* → block。
    // 这样不需要预扫 findTagArgClose / getTagCloserType，每个字符只访问一次。
    if (frame.closingEndTag !== null) {
      const { tagClose, rawOpen, blockOpen, blockClose } = syntax;

      // ) 系列判定
      if (frameText.startsWith(tagClose, i)) {
        if (frame.parenDepth > 0) {
          // 匹配内层裸 (，不是 argClose
          frame.parenDepth--;
          appendBuf(frame, tagClose, i);
          frame.i += tagClose.length;
          continue;
        }

        // parenDepth === 0 → 这是 argClose，检查后缀确定 form
        if (frameText.startsWith(endTag, i)) {
          // )$$ → inline close
          flushBuffer(frame);
          stack.pop();
          completeChild(frame);
          continue;
        }

        if (frameText.startsWith(rawOpen, i)) {
          // )% → raw form
          const argClose = i;
          const contentStart = argClose + rawOpen.length;
          const closeStart = findRawClose(frameText, contentStart, syntax);
          const parent = stack[frame.parentIndex];
          const tagStartI = frame.tagStartI;

          if (closeStart === -1) {
            const malformed = findMalformedWholeLineTokenCandidate(frameText, contentStart, syntax.rawClose);
            emitError(tracker, onError, malformed ? "RAW_CLOSE_MALFORMED" : "RAW_NOT_CLOSED", frameText, malformed?.index ?? tagStartI, malformed?.length ?? contentStart - tagStartI);
            // 降级：回退到父帧，整段当文本
            stack.pop();
            appendBuf(parent, frameText.slice(tagStartI, contentStart), tagStartI);
            parent.i = contentStart;
            continue;
          }

          if (gating && !gating.handlers[frame.tag]?.raw) {
            // handler 不支持 raw → 整段降级为文本
            const end = closeStart + syntax.rawClose.length;
            stack.pop();
            appendBuf(parent, frameText.slice(tagStartI, end), tagStartI);
            parent.i = end;
            continue;
          }

          // raw 正常路径：当前帧的 nodes 就是 args
          flushBuffer(frame);
          const nextI = closeStart + syntax.rawClose.length;
          const meta = buildComplexMeta(parent, { tag: frame.tag, argStart: frame.argStartI, tagOpenPos: frame.tagOpenPos } as TagStartInfo, argClose, contentStart, closeStart, syntax.rawClose.length);
          // 修正 meta：start 应该是 tagStartI
          meta.meta.start = parent.baseOffset + tagStartI;
          const args = frame.nodes;
          stack.pop();
          parent.i = nextI;
          pushNode(parent.nodes, {
            type: "raw", tag: frame.tag, args, content: frameText.slice(contentStart, closeStart), _meta: meta.meta,
          }, meta.pos);
          continue;
        }

        if (frameText.startsWith(blockOpen, i)) {
          // )* → block form
          const argClose = i;
          const contentStart = argClose + blockOpen.length;
          const closeStart = findBlockClose(frameText, contentStart, syntax, tagName);
          const parent = stack[frame.parentIndex];
          const tagStartI = frame.tagStartI;

          if (closeStart === -1) {
            const malformed = findMalformedWholeLineTokenCandidate(frameText, contentStart, blockClose);
            emitError(tracker, onError, malformed ? "BLOCK_CLOSE_MALFORMED" : "BLOCK_NOT_CLOSED", frameText, malformed?.index ?? tagStartI, malformed?.length ?? contentStart - tagStartI);
            stack.pop();
            appendBuf(parent, frameText.slice(tagStartI, contentStart), tagStartI);
            parent.i = contentStart;
            continue;
          }

          if (gating && !gating.handlers[frame.tag]?.block) {
            const end = closeStart + blockClose.length;
            stack.pop();
            appendBuf(parent, frameText.slice(tagStartI, end), tagStartI);
            parent.i = end;
            continue;
          }

          // block 正常路径：当前帧的 nodes 就是 args
          flushBuffer(frame);
          const nextI = closeStart + blockClose.length;
          const metaResult = buildComplexMeta(parent, { tag: frame.tag, argStart: frame.argStartI, tagOpenPos: frame.tagOpenPos } as TagStartInfo, argClose, contentStart, closeStart, blockClose.length);
          metaResult.meta.start = parent.baseOffset + tagStartI;
          const args = frame.nodes;
          stack.pop();

          // push content 帧
          parent.i = nextI;
          parent.pendingArgs = args;
          const contentFrame = makeFrame(frameText.slice(contentStart, closeStart), parent.depth + 1, false, parent.baseOffset + contentStart);
          contentFrame.returnKind = "blockContent";
          contentFrame.parentIndex = frame.parentIndex;
          contentFrame.tag = frame.tag;
          contentFrame.meta = metaResult.meta;
          contentFrame.tagPosition = metaResult.pos;
          stack.push(contentFrame);
          continue;
        }

        // ) 后面不是 $$ / % / * → 普通文本
        appendBuf(frame, tagClose, i);
        frame.i += tagClose.length;
        continue;
      }
    }

    // ── 非 inline 帧的意外 endTag ──
    if (frameText.startsWith(endTag, i)) {
      emitError(tracker, onError, "UNEXPECTED_CLOSE", frameText, i, endTag.length);
      appendBuf(frame, endTag, i);
      frame.i += endTag.length;
      continue;
    }

    // ── 管道分隔符（仅参数区内） ──
    if (frame.insideArgs && frameText.startsWith(tagDivider, i)) {
      flushBuffer(frame);
      pushNode(
        frame.nodes,
        { type: "separator", _meta: { start: frame.baseOffset + i, end: frame.baseOffset + i + tagDivider.length } },
        makePosition(tracker, frame.baseOffset + i, frame.baseOffset + i + tagDivider.length),
      );
      frame.i += tagDivider.length;
      continue;
    }

    // ── 标签头识别 ──
    const info = readTagStartInfo(frameText, i, syntax, tagName);
    if (!info) {
      // inline 帧：裸 ( 递增 parenDepth
      if (frame.closingEndTag !== null && frameText.startsWith(tagOpen, i)) {
        frame.parenDepth++;
      }
      appendBuf(frame, frameText[i], i);
      frame.i++;
      continue;
    }

    // ── 深度限制 → 整个标签退化 ──
    if (frame.depth >= depthLimit) {
      emitError(tracker, onError, "DEPTH_LIMIT", frameText, i, info.argStart - info.tagOpenPos);
      const degradedEnd = skipTagBoundary(frameText, info, syntax, tagName);
      appendBuf(frame, frameText.slice(i, degradedEnd), i);
      frame.i = degradedEnd;
      continue;
    }

    // ── inline 帧内的嵌套标签：直接 push 子帧，跳过 getTagCloserType ──
    //
    // inline 帧自带 parenDepth 追踪，子帧遇到 ) 时会根据后缀
    // ( )$$ / )% / )* ) 判定真实 form。不需要预扫 findTagArgClose。
    // 这使得纯 inline 深嵌套保持 O(n)。
    //
    // 注意：仍需检查 gating。如果标签的 inline form 不被支持，
    // 应该当普通字符处理，而不是盲目 push 子帧。
    if (frame.closingEndTag !== null) {
      if (!tryPushInlineChild(frame, i, info)) {
        appendBuf(frame, frameText[i], i);
        frame.i++;
      }
      continue;
    }

    // ── 确定标签形态（仅非 inline 帧需要）──
    const closerInfo = getTagCloserType(frameText, info.tagNameEnd + tagOpen.length, syntax);
    if (!closerInfo) {
      const handler = gating?.handlers[info.tag];
      const isRegistered = gating?.registeredTags.has(info.tag) ?? false;
      if (gating ? supportsInlineForm(handler, gating.allowInline, isRegistered) : true) {
        emitError(tracker, onError, "INLINE_NOT_CLOSED", frameText, i, info.argStart - info.tagOpenPos);
      }
      appendBuf(frame, frameText.slice(i, info.argStart), i);
      frame.i = info.argStart;
      continue;
    }

    // ── Inline 形态 ──
    if (closerInfo.closer === endTag) {
      if (!tryPushInlineChild(frame, i, info)) {
        appendBuf(frame, frameText[i], i);
        frame.i++;
      }
      continue;
    }

    // ── Raw 形态 ──
    if (closerInfo.closer === rawClose) {
      const contentStart = closerInfo.argClose + syntax.rawOpen.length;
      const closeStart = findRawClose(frameText, contentStart, syntax);

      if (closeStart === -1) {
        const malformed = findMalformedWholeLineTokenCandidate(frameText, contentStart, syntax.rawClose);
        emitError(tracker, onError, malformed ? "RAW_CLOSE_MALFORMED" : "RAW_NOT_CLOSED", frameText, malformed?.index ?? i, malformed?.length ?? contentStart - i);
        appendBuf(frame, frameText.slice(i, contentStart), i);
        frame.i = contentStart;
        continue;
      }

      if (gating && !gating.handlers[info.tag]?.raw) {
        const end = closeStart + syntax.rawClose.length;
        appendBuf(frame, frameText.slice(i, end), i);
        frame.i = end;
        continue;
      }

      const { meta, pos, nextI } = buildComplexMeta(frame, info, closerInfo.argClose, contentStart, closeStart, syntax.rawClose.length);
      flushBuffer(frame);
      frame.i = nextI;

      const child = makeFrame(frameText.slice(info.argStart, closerInfo.argClose), frame.depth + 1, true, frame.baseOffset + info.argStart);
      child.returnKind = "rawArgs";
      child.parentIndex = stack.length - 1;
      child.tag = info.tag;
      child.meta = meta;
      child.tagPosition = pos;
      child.rawContent = frameText.slice(contentStart, closeStart);
      stack.push(child);
      continue;
    }

    // ── Block 形态 ──
    const contentStart = closerInfo.argClose + syntax.blockOpen.length;
    const closeStart = findBlockClose(frameText, contentStart, syntax, tagName);

    if (closeStart === -1) {
      const malformed = findMalformedWholeLineTokenCandidate(frameText, contentStart, syntax.blockClose);
      emitError(tracker, onError, malformed ? "BLOCK_CLOSE_MALFORMED" : "BLOCK_NOT_CLOSED", frameText, malformed?.index ?? i, malformed?.length ?? contentStart - i);
      appendBuf(frame, frameText.slice(i, contentStart), i);
      frame.i = contentStart;
      continue;
    }

    if (gating && !gating.handlers[info.tag]?.block) {
      const end = closeStart + syntax.blockClose.length;
      appendBuf(frame, frameText.slice(i, end), i);
      frame.i = end;
      continue;
    }

    const { meta, pos, nextI } = buildComplexMeta(frame, info, closerInfo.argClose, contentStart, closeStart, syntax.blockClose.length);
    flushBuffer(frame);
    frame.i = nextI;

    const child = makeFrame(frameText.slice(info.argStart, closerInfo.argClose), frame.depth + 1, true, frame.baseOffset + info.argStart);
    child.returnKind = "blockArgs";
    child.parentIndex = stack.length - 1;
    child.tag = info.tag;
    child.meta = meta;
    child.tagPosition = pos;
    child.contentText = frameText.slice(contentStart, closeStart);
    child.contentBaseOffset = frame.baseOffset + contentStart;
    stack.push(child);
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
