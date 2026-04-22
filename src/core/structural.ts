// ═══════════════════════════════════════════════════════════════
// structural.ts — 结构解析器
//
// 硬规则，后面重构别再动这条边界：
// - 不要试图统一 parseRichText.position 和 parseStructural.position
// - 允许共享基础配置 / tracker
// - 禁止共享最终 span 结算
//
// structural parser 持有"原始源码真相"
// render layer 持有"规范化渲染真相"
// 这是同一份源码的两种合法视角，不是重复劳动。
//
// 文件导航（行号可能因编辑微调，但顺序不变）：
//
//    ~83  IndexedStructuralNode  内部节点类型（带 _meta）
//   ~138  pushNode / node工厂     节点工具
//   ~174  ScanContext            跨递归层共享的不可变配置
//   ~187  parseNodes             主入口（下面全是它的内部定义）
//
//  parseNodes 内部结构：
//   ~263  ── 帧定义 ──           ParseFrame 接口 + ReturnKind 类型
//   ~302  makeFrame              帧工厂
//   ~340  ── 缓冲区 ──           flushBuffer / appendBuf
//   ~399  ── 子帧完成分发 ──     completeChild：按 returnKind 统一组装节点
//   ~469  buildComplexMeta       raw / block 的 meta + position 构造
//   ~492  pushInlineChild        push inline 子帧（lazy close，不预扫）
//   ~670  ownership 辅助         getAncestorEndTagOwner / hasEndTagOwnerAt
//   ~690  shorthand ownership    resolveShorthandOwnershipPush（来自 structuralOwnership.ts）
//   ~752  EOF replay             buildMalformedInlineReplayPlan（来自 structuralOwnership.ts）
//
//  主循环（~1161 while）：
//  ~1120  帧完成                 textEnd 到达 / inline 未闭合处理
//  ~1173  转义序列               readEscapedSequence
//  ~1186  inline 帧 argClose     )$$ / )% / )* form 判定 + shorthand 关闭
//  ~1194  非 inline 帧意外 endTag
//  ~1215  管道分隔符             insideArgs 时的 | 处理
//  ~1226  标签头识别             readTagStartInfo + shorthand 识别
//   ~704  深度限制退化           skipTagBoundary
//   ~758  inline 帧嵌套标签      gating 检查 + pushInlineChild（跳过 getTagCloserType）
//   ~885  非 inline 帧 form 判定 getTagCloserType → inline / raw / block 分发
//
//  抽离模块：
//  structuralOwnership.ts
//   - scanEndTagAt
//   - resolveShorthandOwnershipPush / resolveShorthandOwnershipClose
//   - buildMalformedInlineReplayPlan
//
//  ~1279  ── Public API ──       parseStructuralWithResolved / parseStructural
// ═══════════════════════════════════════════════════════════════

import type {
  BufferState,
  ParseError,
  SourceSpan,
  StructuralNode,
  StructuralParseOptions,
  SyntaxConfig,
  TagNameConfig,
} from "../types";
import { getDefaultSyntaxInstance, getSyntax } from "../config/syntax.js";
import { DEFAULT_TAG_NAME, getTagNameConfig } from "../config/chars.js";
import { warnDeprecated } from "../internal/deprecations.js";
import {
  getArgEscapableTokens,
  getBlockContentEscapableTokens,
  getRootEscapableTokens,
  readEscapedSequence,
  readEscapedSequenceWithTokens,
} from "../handlerBuilders/escape.js";
import {
  type BaseResolvedConfig,
  buildGatingContext,
  type GatingContext,
  resolveBaseOptions,
  supportsInlineForm,
} from "../config/resolveOptions.js";
import { emitError } from "../internal/errors.js";
import {
  findBlockClose,
  findMalformedWholeLineTokenCandidate,
  findRawClose,
  getTagCloserType,
  getTagCloserTypeWithCache,
  readTagStartInfo,
  skipTagBoundary,
} from "./scanner.js";
import { makePosition, type PositionTracker } from "../internal/positions.js";
import {
  buildMalformedInlineReplayPlan,
  resolveShorthandOwnershipClose,
  resolveShorthandOwnershipPush,
  scanEndTagAt,
  type ShorthandProbeState,
} from "./structuralOwnership.js";

const emptyBuffer = (): BufferState => ({ start: -1, end: -1, segments: null });

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
  | {
      type: "inline";
      tag: string;
      children: IndexedStructuralNode[];
      implicitInlineShorthand?: boolean;
      _meta: TagMeta;
      position?: SourceSpan;
    }
  | {
      type: "raw";
      tag: string;
      args: IndexedStructuralNode[];
      content: string;
      _meta: TagMeta;
      position?: SourceSpan;
    }
  | {
      type: "block";
      tag: string;
      args: IndexedStructuralNode[];
      children: IndexedStructuralNode[];
      _meta: TagMeta;
      position?: SourceSpan;
    };

interface ParseNodeFactory<TNode extends StructuralNode | IndexedStructuralNode> {
  text(value: string, start: number, end: number): TNode;
  escape(raw: string, start: number, end: number): TNode;
  separator(start: number, end: number): TNode;
  inline(tag: string, children: TNode[], meta: TagMeta, implicitInlineShorthand: boolean): TNode;
  raw(tag: string, args: TNode[], content: string, meta: TagMeta): TNode;
  block(tag: string, args: TNode[], children: TNode[], meta: TagMeta): TNode;
}

// 这里故意把"扫描逻辑"和"节点 shape"拆开。
// 主状态机只负责识别 structural 语法边界；最终产出 public 还是 indexed 节点，
// 由 factory 决定。这样 public 路径不再需要先构 indexed 再 strip _meta。
const pushNode = <TNode extends StructuralNode | IndexedStructuralNode>(
  nodes: TNode[],
  node: TNode,
  position: SourceSpan | undefined,
) => {
  if (position) node.position = position;
  nodes.push(node);
};

const publicNodeFactory: ParseNodeFactory<StructuralNode> = {
  text: (value) => ({ type: "text", value }),
  escape: (raw) => ({ type: "escape", raw }),
  separator: () => ({ type: "separator" }),
  inline: (tag, children, _meta, implicitInlineShorthand) =>
    implicitInlineShorthand
      ? { type: "inline", tag, children, implicitInlineShorthand: true }
      : { type: "inline", tag, children },
  raw: (tag, args, content) => ({ type: "raw", tag, args, content }),
  block: (tag, args, children) => ({ type: "block", tag, args, children }),
};

const indexedNodeFactory: ParseNodeFactory<IndexedStructuralNode> = {
  text: (value, start, end) => ({ type: "text", value, _meta: { start, end } }),
  escape: (raw, start, end) => ({ type: "escape", raw, _meta: { start, end } }),
  separator: (start, end) => ({ type: "separator", _meta: { start, end } }),
  inline: (tag, children, meta, implicitInlineShorthand) =>
    implicitInlineShorthand
      ? { type: "inline", tag, children, implicitInlineShorthand: true, _meta: meta }
      : { type: "inline", tag, children, _meta: meta },
  raw: (tag, args, content, meta) => ({ type: "raw", tag, args, content, _meta: meta }),
  block: (tag, args, children, meta) => ({ type: "block", tag, args, children, _meta: meta }),
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

const parseNodesWithFactory = <TNode extends StructuralNode | IndexedStructuralNode>(
  text: string,
  depth: number,
  ctx: ScanContext,
  insideArgs: boolean,
  baseOffset: number,
  factory: ParseNodeFactory<TNode>,
): TNode[] => {
  // 注意：这是 structural parser 的主状态机。
  // 它不走 handler，也不产出运行时 token；这里只有三类核心状态：
  // `i`（扫描指针）、`buf`（待 flush 的纯文本）、`nodes`（当前层结构节点）。
  // 一旦改动"何时 flush / 何时推进 i / 何时递归"，
  // raw/block/inline 的边界和 position 映射都很容易一起偏掉。
  //
  // 入口有两条：
  // 1. parseNodes       -> IndexedStructuralNode[]，给内部逻辑和 render 退化路径用
  // 2. parsePublicNodes -> StructuralNode[]，给 parseStructural() 直接返回
  //
  // 两条路径共用这一个扫描主循环，避免维护两套 form 判定规则。
  const { depthLimit, gating, tracker, syntax, tagName, onError } = ctx;
  const { escapeChar, tagClose, tagDivider, tagOpen, tagPrefix, endTag, rawClose } = syntax;
  const argEscapableTokens = getArgEscapableTokens(syntax);
  const emittedErrorKeys = new Set<string>();
  const rootEscapableTokens = getRootEscapableTokens(syntax);
  const blockContentEscapableTokens = getBlockContentEscapableTokens(syntax);
  let tagArgCloseCache: Map<number, number> | null = null;

  const isRootFrame = (frame: ParseFrame): boolean =>
    frame.parentIndex < 0 &&
    frame.returnKind === null &&
    frame.inlineCloseToken === null &&
    !frame.insideArgs;

  const canReadEscapedForFrame = (frame: ParseFrame): boolean =>
    frame.insideArgs || frame.returnKind === "blockContent" || isRootFrame(frame);

  const readEscapedForFrame = (
    frameText: string,
    index: number,
    frame: ParseFrame,
  ): [string | null, number] => {
    if (frame.insideArgs) {
      return readEscapedSequenceWithTokens(frameText, index, syntax, argEscapableTokens);
    }
    if (frame.returnKind === "blockContent") {
      return readEscapedSequenceWithTokens(
        frameText,
        index,
        syntax,
        blockContentEscapableTokens,
      );
    }
    if (isRootFrame(frame)) {
      return readEscapedSequenceWithTokens(frameText, index, syntax, rootEscapableTokens);
    }
    return [null, index];
  };

  const shouldEnableFastTextSkip = (frame: ParseFrame): boolean => {
    // fast-skip 始终开启；当 shorthand 开启时，边界扫描会额外停在 tag-name 起始字符处，
    // 避免跨过 `name(...)` 入口。
    return frame.i < frame.textEnd;
  };

  const tagPrefixLeadCode = tagPrefix.charCodeAt(0);
  // `endTag` 约束为以 `tagClose` 开头（见下方 assert），所以 `tagClose[0]` 已覆盖 `endTag[0]`。
  const tagCloseLeadCode = tagClose.charCodeAt(0);
  const tagDividerLeadCode = tagDivider.charCodeAt(0);
  const escapeLeadCode = escapeChar.charCodeAt(0);

  const findNextBoundaryChar = (frame: ParseFrame, from: number): number => {
    const hasInlineCloseToken = frame.inlineCloseToken !== null;
    const canReadEscaped = canReadEscapedForFrame(frame);
    const watchShorthandStart = Boolean(gating?.inlineShorthandEnabled && hasInlineCloseToken);
    const inlineCloseLeadCode = hasInlineCloseToken
      ? frame.inlineCloseToken!.charCodeAt(0)
      : Number.NaN;
    for (let cursor = from; cursor < frame.textEnd; cursor++) {
      const currentCode = frame.text.charCodeAt(cursor);
      if (watchShorthandStart && tagName.isTagStartChar(frame.text[cursor])) return cursor;
      if (currentCode === tagPrefixLeadCode || currentCode === tagCloseLeadCode) return cursor;
      if (frame.insideArgs && currentCode === tagDividerLeadCode) return cursor;
      if (canReadEscaped && currentCode === escapeLeadCode) return cursor;
      if (hasInlineCloseToken && currentCode === inlineCloseLeadCode) return cursor;
    }
    return frame.textEnd;
  };

  if (!endTag.startsWith(tagClose)) {
    throw new Error(
      `Invalid structural syntax: endTag "${endTag}" must start with tagClose "${tagClose}" for inline parsing.`,
    );
  }

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
    textEnd: number; // scan boundary; inline 帧初始为 text.length，其余等于 text.length
    nodes: TNode[];
    buf: BufferState;

    // ── 返回槽位 ──
    returnKind: ReturnKind | null;
    parentIndex: number; // parent 在 stack 中的 index
    tag: string; // 标签名
    meta: TagMeta | null; // 预算好的 meta（inline 在关闭时才算）
    tagPosition: SourceSpan | undefined;

    // ── inline 专用：lazy close ──
    inlineCloseToken: string | null; // non-null 表示这个帧遇到 close token 时自行关闭
    inlineCloseWidth: number; // 关闭时消费的源码长度（可为 0，用于被完整 DSL 打断）
    implicitInlineShorthand: boolean; // name(...) shorthand 子帧
    tagStartI: number; // 标签头在 text 中的起始位置
    argStartI: number; // info.argStart
    tagOpenPos: number; // info.tagOpenPos，用于 error span

    // ── block 专用：两阶段中间存储 ──
    pendingArgs: TNode[] | null; // blockArgs 完成后暂存
    contentStartI: number; // block content 起始位置
    contentEndI: number; // block/raw content 结束位置

    // ── shorthand 前探缓存（仅父 inline endTag 模式使用） ──
    // 按需创建，避免每个帧常驻 4 个探测字段。
    shorthandProbe: ShorthandProbeState | null;
    ancestorEndTagOwnerIndex: number;
  }

  const makeFrame = (
    frameText: string,
    frameDepth: number,
    frameInsideArgs: boolean,
    frameBaseOffset: number,
    frameTextStart = 0,
    frameTextEnd = frameText.length,
  ): ParseFrame => ({
    text: frameText,
    depth: frameDepth,
    insideArgs: frameInsideArgs,
    baseOffset: frameBaseOffset,
    i: frameTextStart,
    textEnd: frameTextEnd,
    nodes: [],
    buf: emptyBuffer(),
    returnKind: null,
    parentIndex: -1,
    tag: "",
    meta: null,
    tagPosition: undefined,
    inlineCloseToken: null,
    inlineCloseWidth: 0,
    implicitInlineShorthand: false,
    tagStartI: 0,
    argStartI: 0,
    tagOpenPos: 0,
    pendingArgs: null,
    contentStartI: 0,
    contentEndI: 0,
    shorthandProbe: null,
    ancestorEndTagOwnerIndex: -1,
  });

  // ── 缓冲区 ──

  const flushBuffer = (frame: ParseFrame) => {
    const bufStart = frame.buf.start;
    if (bufStart < 0) return;
    const segments = frame.buf.segments;
    let value: string;
    if (segments === null) {
      value = frame.text.slice(bufStart, frame.buf.end);
    } else {
      const segLen = segments.length;
      // 2 segments (1 pair) 或 4 segments (2 pairs) 时直接拼接，避免分配 parts 数组
      if (segLen === 2) {
        value = frame.text.slice(segments[0], segments[1]);
      } else if (segLen === 4) {
        value =
          frame.text.slice(segments[0], segments[1]) + frame.text.slice(segments[2], segments[3]);
      } else {
        let result = "";
        for (let index = 0; index < segLen; index += 2) {
          result += frame.text.slice(segments[index], segments[index + 1]);
        }
        value = result;
      }
    }
    const base = frame.baseOffset;
    const startOff = base + bufStart;
    const endOff = base + frame.i;
    pushNode(frame.nodes, factory.text(value, startOff, endOff), makePosition(tracker, startOff, endOff));
    frame.buf.start = -1;
    frame.buf.end = -1;
    frame.buf.segments = null;
  };

  const appendBuf = (frame: ParseFrame, start: number, end: number) => {
    if (start >= end) return;
    if (frame.buf.start === -1) {
      frame.buf.start = start;
      frame.buf.end = end;
      return;
    }
    if (start === frame.buf.end) {
      frame.buf.end = end;
      if (frame.buf.segments !== null) {
        frame.buf.segments[frame.buf.segments.length - 1] = end;
      }
      return;
    }
    if (frame.buf.segments === null) {
      frame.buf.segments = [frame.buf.start, frame.buf.end];
    }
    frame.buf.segments.push(start, end);
    frame.buf.end = end;
  };

  const tryMergeAdjacentTextNode = (targetNodes: TNode[], node: TNode): boolean => {
    if (node.type !== "text") return false;
    const last = targetNodes[targetNodes.length - 1];
    if (!last || last.type !== "text") return false;

    last.value += node.value;
    if ("_meta" in last && "_meta" in node) {
      last._meta.end = node._meta.end;
    }
    if (last.position && node.position) {
      last.position.end = node.position.end;
    }
    return true;
  };

  const appendNodesWithMergedText = (targetNodes: TNode[], nodes: readonly TNode[]) => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (tryMergeAdjacentTextNode(targetNodes, node)) continue;
      targetNodes.push(node);
    }
  };

  const downgradeInlineIntoParent = (frame: ParseFrame, nextParentI: number): boolean => {
    const parent = stack[frame.parentIndex];
    if (!parent) return true;
    // inline 子帧降级回父帧：
    // 1. tag 头回退成普通文本
    // 2. 已经在子帧里解析出来的正文直接挂回父帧
    // 3. 父帧从 nextParentI 继续，避免回退到 argStart 重扫整段尾巴。
    flushBuffer(frame);
    appendBuf(parent, frame.tagStartI, frame.argStartI);
    parent.i = frame.argStartI;
    flushBuffer(parent);
    appendNodesWithMergedText(parent.nodes, frame.nodes);
    parent.i = nextParentI;
    return true;
  };

  // ── 子帧完成分发 ──

  const completeChild = (child: ParseFrame) => {
    const parent = stack[child.parentIndex];
    const childNodes = child.nodes;

    // 所有子帧都在这里统一"回填"到父帧。
    // 好处是主循环只负责扫描和入栈，真正的组装策略集中在一个地方，
    // 不会在多个分支里重复写"父帧如何接 child"。
    const kind = child.returnKind;
    if (kind === "inline") {
      const closeStart = child.i; // child.i 停在 endTag 的位置
      const nextI = closeStart + child.inlineCloseWidth;
      const base = parent.baseOffset;
      const argOff = base + child.argStartI;
      const closeOff = base + closeStart;
      const meta: TagMeta = {
        start: base + child.tagStartI,
        end: base + nextI,
        argStart: argOff,
        argEnd: closeOff,
        contentStart: argOff,
        contentEnd: closeOff,
      };
      parent.i = nextI;
      pushNode(
        parent.nodes,
        factory.inline(child.tag, childNodes, meta, child.implicitInlineShorthand),
        makePosition(tracker, meta.start, meta.end),
      );
    } else if (kind === "rawArgs") {
      pushNode(
        parent.nodes,
        factory.raw(
          child.tag,
          childNodes,
          child.text.slice(child.contentStartI, child.contentEndI),
          child.meta!,
        ),
        child.tagPosition,
      );
    } else if (kind === "blockArgs") {
      // args 完成，暂存后 push content 帧
      parent.pendingArgs = childNodes;
      const content = makeFrame(
        child.text,
        parent.depth + 1,
        false,
        parent.baseOffset,
        child.contentStartI,
        child.contentEndI,
      );
      pushChildFrame(
        content,
        "blockContent",
        child.parentIndex,
        child.tag,
        child.meta,
        child.tagPosition,
      );
    } else if (kind === "blockContent") {
      pushNode(
        parent.nodes,
        factory.block(child.tag, parent.pendingArgs!, childNodes, child.meta!),
        child.tagPosition,
      );
      parent.pendingArgs = null;
    }
  };

  // ── meta 构造工具 ──

  const buildComplexMeta = (
    frame: ParseFrame,
    tagStart: number,
    argStart: number,
    argClose: number,
    contentStart: number,
    closeStart: number,
    closeLength: number,
  ): { meta: TagMeta; pos: SourceSpan | undefined; nextI: number } => {
    // raw / block 都是"先在父帧上算完整 span，再切 args/content 子帧"。
    // 这样 position 与 _meta 锚定的始终是原始源码区间，
    // 不会因为后续进入子帧扫描而丢失整体 tag 的边界。
    const nextI = closeStart + closeLength;
    const meta: TagMeta = {
      start: frame.baseOffset + tagStart,
      end: frame.baseOffset + nextI,
      argStart: frame.baseOffset + argStart,
      argEnd: frame.baseOffset + argClose,
      contentStart: frame.baseOffset + contentStart,
      contentEnd: frame.baseOffset + closeStart,
    };
    return { meta, pos: makePosition(tracker, meta.start, meta.end), nextI };
  };

  const pushChildFrame = (
    child: ParseFrame,
    returnKind: ReturnKind,
    parentIndex: number,
    tag: string,
    meta: TagMeta | null,
    tagPosition: SourceSpan | undefined,
  ) => {
    const parent = stack[parentIndex];
    child.returnKind = returnKind;
    child.parentIndex = parentIndex;
    child.tag = tag;
    child.meta = meta;
    child.tagPosition = tagPosition;
    child.ancestorEndTagOwnerIndex =
      parent.inlineCloseToken === endTag ? parentIndex : parent.ancestorEndTagOwnerIndex;
    stack.push(child);
  };

  interface InlineChildInit {
    tag: string;
    tagStartI: number;
    argStartI: number;
    tagOpenPos: number;
    closeToken: string;
    implicitInlineShorthand: boolean;
  }

  const pushInlineChildFrame = (frame: ParseFrame, init: InlineChildInit): void => {
    flushBuffer(frame);
    const child = makeFrame(frame.text, frame.depth + 1, true, frame.baseOffset);
    child.i = init.argStartI;
    child.textEnd = frame.textEnd;
    pushChildFrame(child, "inline", stack.length - 1, init.tag, null, undefined);
    child.inlineCloseToken = init.closeToken;
    child.implicitInlineShorthand = init.implicitInlineShorthand;
    child.tagStartI = init.tagStartI;
    child.argStartI = init.argStartI;
    child.tagOpenPos = init.tagOpenPos;
  };

  // ── inline 子帧 push ──
  //
  // gating 检查 + flush + push 一体。返回 true 表示已 push，false 表示 gating 拒绝。
  // 子帧在父帧的 text 上继续逐字符扫描，遇到 )$$ 自动关闭。
  // 不调 findInlineClose / findTagArgClose，每个字符只被访问一次 → O(n)。
  const tryPushInlineChild = (
    frame: ParseFrame,
    tagStartI: number,
    info: TagStartInfo,
  ): boolean => {
    if (
      gating &&
      !supportsInlineForm(
        gating.handlers[info.tag],
        gating.allowInline,
        gating.registeredTags.has(info.tag),
      )
    ) {
      return false;
    }
    pushInlineChildFrame(frame, {
      tag: info.tag,
      tagStartI,
      argStartI: info.argStart,
      tagOpenPos: info.tagOpenPos,
      closeToken: endTag,
      implicitInlineShorthand: false,
    });
    return true;
  };

  interface ShorthandStartInfo {
    tag: string;
    tagOpenPos: number;
    argStart: number;
  }

  const readInlineShorthandStart = (frameText: string, i: number): ShorthandStartInfo | null => {
    if (!gating) return null;
    if (!gating.inlineShorthandEnabled) return null;
    const { isTagChar, isTagStartChar } = tagName;
    if (i >= frameText.length || !isTagStartChar(frameText[i])) return null;

    let tagNameEnd = i + 1;
    while (tagNameEnd < frameText.length && isTagChar(frameText[tagNameEnd])) {
      tagNameEnd++;
    }
    if (!frameText.startsWith(tagOpen, tagNameEnd)) return null;

    const tag = frameText.slice(i, tagNameEnd);
    if (!gating.registeredTags.has(tag)) return null;
    if (gating.inlineShorthandTags && !gating.inlineShorthandTags.has(tag)) return null;
    const handler = gating.handlers[tag];
    if (!supportsInlineForm(handler, gating.allowInline, true)) return null;

    return {
      tag,
      tagOpenPos: i,
      argStart: tagNameEnd + tagOpen.length,
    };
  };

  const getAncestorEndTagOwner = (frame: ParseFrame | null): ParseFrame | null => {
    if (!frame) return null;
    const ownerIndex = frame.ancestorEndTagOwnerIndex;
    return ownerIndex >= 0 ? (stack[ownerIndex] ?? null) : null;
  };

  const getEndTagOwner = (frame: ParseFrame | null): ParseFrame | null => {
    if (!frame) return null;
    if (frame.inlineCloseToken === endTag) return frame;
    return getAncestorEndTagOwner(frame);
  };

  const hasEndTagOwnerAt = (frame: ParseFrame | null, at: number): boolean => {
    const owner = getEndTagOwner(frame);
    return !!owner && scanEndTagAt(owner.text, endTag, at, owner.textEnd) === "full";
  };

  const tryPushInlineShorthandChild = (
    frame: ParseFrame,
    tagStartI: number,
    info: ShorthandStartInfo,
  ): boolean => {
    const ownership = resolveShorthandOwnershipPush({
      argStart: info.argStart,
      frameInlineCloseToken: frame.inlineCloseToken,
      frameText: frame.text,
      frameTextEnd: frame.textEnd,
      endTag,
      tagClose,
      currentProbe: frame.shorthandProbe,
      hasAncestorEndTagOwnerAt: at => hasEndTagOwnerAt(getAncestorEndTagOwner(frame), at),
      readEscapedNext: at => {
        const [escaped, nextEsc] = readEscapedSequence(frame.text, at, syntax);
        return escaped !== null ? nextEsc : null;
      },
      hasTagStartAt: at => Boolean(readTagStartInfo(frame.text, at, syntax, tagName)),
    });
    frame.shorthandProbe = ownership.nextProbe;
    // 对应测试: [Coverage/Structural] shorthand ownership probe should skip escaped sequence before boundary
    if (ownership.decision === "defer-parent") {
      return false;
    }

    if (frame.depth >= depthLimit) {
      const span = info.argStart - info.tagOpenPos;
      emitError(tracker, onError, "DEPTH_LIMIT", frame.text, tagStartI, span, emittedErrorKeys);
      const degradedEnd = info.argStart;
      appendBuf(frame, tagStartI, degradedEnd);
      frame.i = degradedEnd;
      return true;
    }
    pushInlineChildFrame(frame, {
      tag: info.tag,
      tagStartI,
      argStartI: info.argStart,
      tagOpenPos: info.tagOpenPos,
      closeToken: tagClose,
      implicitInlineShorthand: true,
    });
    return true;
  };

  interface UnclosedInlineErrorFrame {
    implicitInlineShorthand: boolean;
    text: string;
    tagStartI: number;
    argStartI: number;
    tagOpenPos: number;
  }

  const emitUnclosedInlineFrameError = (frame: UnclosedInlineErrorFrame) => {
    emitError(
      tracker,
      onError,
      frame.implicitInlineShorthand ? "SHORTHAND_NOT_CLOSED" : "INLINE_NOT_CLOSED",
      frame.text,
      frame.tagStartI,
      frame.argStartI - frame.tagOpenPos,
      emittedErrorKeys,
    );
  };

  const replayMalformedInlineChainAtEof = (frame: ParseFrame): boolean => {
    const replayPlan = buildMalformedInlineReplayPlan(frame, parentIndex =>
      parentIndex >= 0 ? (stack[parentIndex] ?? null) : null,
    );

    for (let index = 0; index < replayPlan.chain.length; index++) {
      const replayFrame = replayPlan.chain[index];
      emitUnclosedInlineFrameError(replayFrame);
      stack.pop();
    }

    if (replayPlan.resumeParentIndex < 0) {
      return true;
    }
    const parent = stack[replayPlan.resumeParentIndex];
    if (!parent) {
      return true;
    }
    if (stack[stack.length - 1] !== parent) {
      throw new Error("Malformed EOF inline replay expects parent to be the current stack top.");
    }
    // 对应测试: [Coverage/Structural] malformed inline chain at EOF should replay once and degrade to full source text
    appendBuf(parent, replayPlan.resumeTagStartI, replayPlan.resumeArgStartI);
    parent.i = replayPlan.resumeArgStartI;
    return true;
  };

  // ── 主循环 ──

  const stack: ParseFrame[] = [makeFrame(text, depth, insideArgs, baseOffset)];
  // ── tryCloseShorthandFrame ──
  //
  // shorthand 子帧的关闭判定（inlineCloseToken === tagClose，只吃一个 )）。
  //
  // 决策路径：
  //   ├─ scanEndTagAt === "full" 且 ownership 判定 defer-parent
  //   │   → 当前 shorthand 帧降级回父帧（downgradeInlineIntoParent）
  //   ├─ startsWith(tagClose)
  //   │   → 正常 shorthand 关闭，completeChild
  //   └─ 否则 → return false（当前字符不是关闭 token）
  const tryCloseShorthandFrame = (
    frame: ParseFrame,
    frameText: string,
    i: number,
  ): boolean => {
    const { tagClose } = syntax;
    const parent = frame.parentIndex >= 0 ? stack[frame.parentIndex] : null;

    // full-form close 与 shorthand close 竞争时，先让 full-form close 拥有 token。
    const isFullEndTagAtCursor = scanEndTagAt(frameText, endTag, i, frame.textEnd) === "full";
    const shouldDeferToParentClose =
      isFullEndTagAtCursor &&
      resolveShorthandOwnershipClose(
        i,
        frame.implicitInlineShorthand,
        at => hasEndTagOwnerAt(parent, at),
      ) === "defer-parent";
    if (shouldDeferToParentClose) {
      stack.pop();
      // 对应测试: [Coverage/Structural] shorthand defer-parent downgrade should merge adjacent text with continuous position
      return downgradeInlineIntoParent(frame, i);
    }

    if (!frameText.startsWith(tagClose, i)) return false;
    flushBuffer(frame);
    frame.inlineCloseWidth = tagClose.length;
    stack.pop();
    completeChild(frame);
    return true;
  };

  // ── tryCloseFullInlineFrame ──
  //
  // 完整 DSL 子帧的关闭 / form 转换判定（inlineCloseToken === endTag）。
  // tagClose 是 endTag 的前缀，先确认 tagClose 存在，
  // 然后按 endTag / rawOpen / blockOpen 顺序判定具体 form。
  //
  // 决策路径：
  //   ├─ !startsWith(tagClose)          → return false（不是关闭 token）
  //   ├─ scanEndTagAt === "full"        → )$$ 关闭，completeChild
  //   ├─ startsWith(rawOpen)            → )% raw form 转换
  //   │   ├─ findRawClose 失败          → 报错，降级为文本
  //   │   ├─ gating 拒绝 raw            → 整段降级为文本
  //   │   └─ 正常 raw 路径              → buildComplexMeta + pushNode
  //   ├─ startsWith(blockOpen)          → )* block form 转换
  //   │   ├─ findBlockClose 失败        → 报错，降级为文本
  //   │   ├─ gating 拒绝 block          → 整段降级为文本
  //   │   └─ 正常 block 路径            → buildComplexMeta + pushChildFrame(blockContent)
  //   └─ 否则                           → ) 当普通文本消费
  const tryCloseFullInlineFrame = (
    frame: ParseFrame,
    frameText: string,
    i: number,
  ): boolean => {
    const { tagClose, rawOpen, blockOpen, blockClose } = syntax;

    if (!frameText.startsWith(tagClose, i)) return false;

    // )$$ → endTag 完整匹配 → inline 正常关闭
    if (scanEndTagAt(frameText, endTag, i, frame.textEnd) === "full") {
      flushBuffer(frame);
      frame.inlineCloseWidth = endTag.length;
      stack.pop();
      completeChild(frame);
      return true;
    }

    if (frameText.startsWith(rawOpen, i)) {
      // )% → raw form
      const argClose = i;
      const contentStart = argClose + rawOpen.length;
      const closeStart = findRawClose(frameText, contentStart, syntax);
      const parent = stack[frame.parentIndex];
      const tagStartI = frame.tagStartI;

      if (closeStart === -1) {
        const malformed = findMalformedWholeLineTokenCandidate(
          frameText,
          contentStart,
          syntax.rawClose,
        );
        emitError(
          tracker,
          onError,
          malformed ? "RAW_CLOSE_MALFORMED" : "RAW_NOT_CLOSED",
          frameText,
          malformed?.index ?? tagStartI,
          malformed?.length ?? contentStart - tagStartI,
          emittedErrorKeys,
        );
        // 降级：回退到父帧，整段当文本
        stack.pop();
        appendBuf(parent, tagStartI, contentStart);
        parent.i = contentStart;
        return true;
      }

      if (gating && !gating.handlers[frame.tag]?.raw) {
        // handler 不支持 raw → 整段降级为文本
        const end = closeStart + syntax.rawClose.length;
        stack.pop();
        appendBuf(parent, tagStartI, end);
        parent.i = end;
        return true;
      }

      // raw 正常路径：当前帧的 nodes 就是 args
      flushBuffer(frame);
      const nextI = closeStart + syntax.rawClose.length;
      const meta = buildComplexMeta(
        parent,
        tagStartI,
        frame.argStartI,
        argClose,
        contentStart,
        closeStart,
        syntax.rawClose.length,
      );
      const args = frame.nodes;
      stack.pop();
      parent.i = nextI;
      pushNode(parent.nodes, factory.raw(frame.tag, args, frameText.slice(contentStart, closeStart), meta.meta), meta.pos);
      return true;
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
        emitError(
          tracker,
          onError,
          malformed ? "BLOCK_CLOSE_MALFORMED" : "BLOCK_NOT_CLOSED",
          frameText,
          malformed?.index ?? tagStartI,
          malformed?.length ?? contentStart - tagStartI,
          emittedErrorKeys,
        );
        stack.pop();
        appendBuf(parent, tagStartI, contentStart);
        parent.i = contentStart;
        return true;
      }

      if (gating && !gating.handlers[frame.tag]?.block) {
        const end = closeStart + blockClose.length;
        stack.pop();
        appendBuf(parent, tagStartI, end);
        parent.i = end;
        return true;
      }

      // block 正常路径：当前帧的 nodes 就是 args
      flushBuffer(frame);
      const nextI = closeStart + blockClose.length;
      const metaResult = buildComplexMeta(
        parent,
        tagStartI,
        frame.argStartI,
        argClose,
        contentStart,
        closeStart,
        blockClose.length,
      );
      const args = frame.nodes;
      stack.pop();

      // push content 帧
      parent.i = nextI;
      parent.pendingArgs = args;
      const contentFrame = makeFrame(
        frameText,
        parent.depth + 1,
        false,
        parent.baseOffset,
        contentStart,
        closeStart,
      );
      pushChildFrame(
        contentFrame,
        "blockContent",
        frame.parentIndex,
        frame.tag,
        metaResult.meta,
        metaResult.pos,
      );
      return true;
    }

    // ) 后面不是 $$ / % / * → 普通文本
    appendBuf(frame, i, i + tagClose.length);
    frame.i += tagClose.length;
    return true;
  };

  // ── tryConsumeInlineCloseAtCursor（调度入口）──
  //
  // 根据 inlineCloseToken 类型分派到对应的关闭函数。
  // shorthand 帧必须优先判定——shorthand 的 close token 是单个 tagClose，
  // 而 endTag 以 tagClose 开头，如果先走 full inline 判定，
  // shorthand 帧的 ) 会被误匹配为 endTag 的前缀。
  const tryConsumeInlineCloseAtCursor = (
    frame: ParseFrame,
    frameText: string,
    i: number,
  ): boolean => {
    if (frame.inlineCloseToken === null) return false;
    if (frame.inlineCloseToken === syntax.tagClose) return tryCloseShorthandFrame(frame, frameText, i);
    return tryCloseFullInlineFrame(frame, frameText, i);
  };
  // ── tryConsumeTagOrTextAtCursor 决策路径 ──
  //
  // 1. readTagStartInfo 失败（不是标签头）
  //    ├─ inline 帧内 → 尝试 shorthand 识别，否则当文本
  //    └─ 非 inline 帧 → 单字符文本推进
  //
  // 2. readTagStartInfo 成功（识别到 $$tag( 开头）
  //    ├─ depth >= depthLimit → 整个标签降级为文本，报错
  //    ├─ inline 帧内（inlineCloseToken !== null）
  //    │   → 直接 tryPushInlineChild，跳过 getTagCloserType
  //    │     原因：inline 帧内的嵌套标签始终以 inline 方式解析，
  //    │     form 判定由子帧自己在遇到 )$$ / )% / )* 时决定。
  //    │   ├─ gating 允许 → push 子帧
  //    │   └─ gating 拒绝 → skipTagBoundary 降级为文本
  //    │
  //    └─ 非 inline 帧 → getTagCloserType 确定 form
  //        ├─ closerInfo === null（括号不配对）→ 退入 lazy inline 模式
  //        ├─ closer === endTag   → inline 形态，tryPushInlineChild
  //        ├─ closer === rawClose → raw 形态
  //        │   ├─ findRawClose 失败 → 报错，降级为文本
  //        │   ├─ gating 拒绝 raw  → 降级为文本
  //        │   └─ 正常 raw 路径    → buildComplexMeta + pushChildFrame(rawArgs)
  //        └─ 其它（blockClose）   → block 形态
  //            ├─ findBlockClose 失败 → 报错，降级为文本
  //            ├─ gating 拒绝 block  → 降级为文本
  //            └─ 正常 block 路径    → buildComplexMeta + pushChildFrame(blockArgs)
  const tryConsumeTagOrTextAtCursor = (
    frame: ParseFrame,
    frameText: string,
    i: number,
  ): boolean => {
    // ── 标签头识别 ──
    const info = readTagStartInfo(frameText, i, syntax, tagName);
    if (!info) {
      if (frame.inlineCloseToken !== null) {
        const shorthand = readInlineShorthandStart(frameText, i);
        if (shorthand && tryPushInlineShorthandChild(frame, i, shorthand)) {
          return true;
        }
      }
      appendBuf(frame, i, i + 1);
      frame.i++;
      return true;
    }

    // ── 深度限制 → 整个标签退化 ──
    if (frame.depth >= depthLimit) {
      emitError(
        tracker,
        onError,
        "DEPTH_LIMIT",
        frameText,
        i,
        info.argStart - info.tagOpenPos,
        emittedErrorKeys,
      );
      const degradedEnd = skipTagBoundary(frameText, info, syntax, tagName);
      appendBuf(frame, i, degradedEnd);
      frame.i = degradedEnd;
      return true;
    }

    // ── inline 帧内的嵌套标签：直接 push 子帧，跳过 getTagCloserType ──
    if (frame.inlineCloseToken !== null) {
      if (!tryPushInlineChild(frame, i, info)) {
        // 完整 DSL 结构优先于文本：即使当前 tag 不支持 inline form，
        // 也要整段降级为文本，避免把内层 )$$ 误判成当前层关闭。
        const degradedEnd = skipTagBoundary(frameText, info, syntax, tagName);
        appendBuf(frame, i, degradedEnd);
        frame.i = degradedEnd;
      }
      return true;
    }

    // ── 确定标签形态（仅非 inline 帧需要）──
    const tagOpenIndex = info.tagNameEnd + tagOpen.length;
    const closerInfo =
      frame.textEnd - tagOpenIndex <= 256
        ? getTagCloserType(frameText, tagOpenIndex, syntax)
        : getTagCloserTypeWithCache(
            frameText,
            tagOpenIndex,
            syntax,
            (tagArgCloseCache ??= new Map<number, number>()),
          );
    if (!closerInfo) {
      // findTagArgClose 因内容括号不配对返回 -1。
      // 进入 lazy inline 模式：子帧逐字符扫描 endTag，不依赖括号配对。
      // 仍需遵守 inline gating：若 gating 拒绝，降级为文本。
      if (!tryPushInlineChild(frame, i, info)) {
        const degradedEnd = skipTagBoundary(frameText, info, syntax, tagName);
        appendBuf(frame, i, degradedEnd);
        frame.i = degradedEnd;
      }
      return true;
    }

    const handler = gating?.handlers[info.tag];

    // ── Inline 形态 ──
    if (closerInfo.closer === endTag) {
      if (!tryPushInlineChild(frame, i, info)) {
        appendBuf(frame, i, i + 1);
        frame.i++;
      }
      return true;
    }

    // ── Raw 形态 ──
    if (closerInfo.closer === rawClose) {
      const contentStart = closerInfo.argClose + syntax.rawOpen.length;
      const closeStart = findRawClose(frameText, contentStart, syntax);

      if (closeStart === -1) {
        const malformed = findMalformedWholeLineTokenCandidate(
          frameText,
          contentStart,
          syntax.rawClose,
        );
        emitError(
          tracker,
          onError,
          malformed ? "RAW_CLOSE_MALFORMED" : "RAW_NOT_CLOSED",
          frameText,
          malformed?.index ?? i,
          malformed?.length ?? contentStart - i,
          emittedErrorKeys,
        );
        appendBuf(frame, i, contentStart);
        frame.i = contentStart;
        return true;
      }

      if (gating && !handler?.raw) {
        const end = closeStart + syntax.rawClose.length;
        appendBuf(frame, i, end);
        frame.i = end;
        return true;
      }

      const { meta, pos, nextI } = buildComplexMeta(
        frame,
        i,
        info.argStart,
        closerInfo.argClose,
        contentStart,
        closeStart,
        syntax.rawClose.length,
      );
      flushBuffer(frame);
      frame.i = nextI;

      // raw 正文不再递归扫描；只有参数区需要进入子帧继续产出结构节点。
      const child = makeFrame(
        frameText,
        frame.depth + 1,
        true,
        frame.baseOffset,
        info.argStart,
        closerInfo.argClose,
      );
      pushChildFrame(child, "rawArgs", stack.length - 1, info.tag, meta, pos);
      child.contentStartI = contentStart;
      child.contentEndI = closeStart;
      return true;
    }

    // ── Block 形态 ──
    const contentStart = closerInfo.argClose + syntax.blockOpen.length;
    const closeStart = findBlockClose(frameText, contentStart, syntax, tagName);

    if (closeStart === -1) {
      const malformed = findMalformedWholeLineTokenCandidate(
        frameText,
        contentStart,
        syntax.blockClose,
      );
      emitError(
        tracker,
        onError,
        malformed ? "BLOCK_CLOSE_MALFORMED" : "BLOCK_NOT_CLOSED",
        frameText,
        malformed?.index ?? i,
        malformed?.length ?? contentStart - i,
        emittedErrorKeys,
      );
      appendBuf(frame, i, contentStart);
      frame.i = contentStart;
      return true;
    }

    if (gating && !handler?.block) {
      const end = closeStart + syntax.blockClose.length;
      appendBuf(frame, i, end);
      frame.i = end;
      return true;
    }

    const { meta, pos, nextI } = buildComplexMeta(
      frame,
      i,
      info.argStart,
      closerInfo.argClose,
      contentStart,
      closeStart,
      syntax.blockClose.length,
    );
    flushBuffer(frame);
    frame.i = nextI;

    // block 需要两阶段：
    // 1. 先扫 args，得到 separator/text/inline 等结构
    // 2. 再扫正文，得到 children
    // 所以这里先压入 blockArgs 子帧，completeChild 再续推 content 帧。
    const child = makeFrame(
      frameText,
      frame.depth + 1,
      true,
      frame.baseOffset,
      info.argStart,
      closerInfo.argClose,
    );
    pushChildFrame(child, "blockArgs", stack.length - 1, info.tag, meta, pos);
    child.contentStartI = contentStart;
    child.contentEndI = closeStart;
    return true;
  };
  const tryFinalizeFrameAtEof = (frame: ParseFrame): boolean => {
    if (frame.i < frame.textEnd) return false;

    if (frame.inlineCloseToken !== null) {
      // EOF 下若连续祖先也都是未闭合 inline/shorthand，
      // 直接整条未闭合链退到第一个非 inline 容器，再只重扫一次。
      return replayMalformedInlineChainAtEof(frame);
    }

    flushBuffer(frame);
    stack.pop();
    if (frame.returnKind === null) return true;
    completeChild(frame);
    return true;
  };

  // ══════════════════════════════════════════════════════════════
  // 主循环调度优先级（高 → 低）
  //
  // 每轮迭代从栈顶取帧，按以下优先级依次尝试，命中即 continue：
  //
  //  1. 帧 EOF 收尾        — 游标到达 textEnd，收尾当前帧（含 inline 未闭合 replay）
  //  2. 快速文本跳过        — 连续非边界字符批量 appendBuf，跳过逐字符开销
  //  3. 转义序列            — escapeChar 开头，产出 escape 节点
  //  4. inline 帧关闭检测   — )$$ / )% / )* / shorthand ) 判定（见上方决策树）
  //  5. 非 inline 帧意外 endTag — 消费 tagClose 部分，留 tagPrefix 给下轮标签识别
  //  6. 管道分隔符          — 仅参数区内，产出 separator 节点
  //  7. 标签头 / 文本       — readTagStartInfo + form 分发（见上方决策树）
  //  8. 兜底                — 单字符文本推进（防御性，正常路径不应到达）
  //
  // 顺序不可随意调换——例如 inline close 必须先于标签识别，
  // 否则 )$$ 会被 readTagStartInfo 误读为新标签的起始。
  // ══════════════════════════════════════════════════════════════
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    // ── 优先级 1: 帧 EOF 收尾 ──
    if (tryFinalizeFrameAtEof(frame)) {
      if (stack.length === 0) return frame.nodes;
      continue;
    }

    const frameText = frame.text;
    const i = frame.i;

    // ── 优先级 2: 快速文本跳过 ──
    if (shouldEnableFastTextSkip(frame)) {
      const boundary = findNextBoundaryChar(frame, i);
      if (boundary > i) {
        appendBuf(frame, i, boundary);
        frame.i = boundary;
        continue;
      }
    }

    // ── 优先级 3: 转义序列 ──
    const [escaped, next] = readEscapedForFrame(frameText, i, frame);
    if (escaped !== null) {
      flushBuffer(frame);
      pushNode(
        frame.nodes,
        factory.escape(frameText.slice(i, next), frame.baseOffset + i, frame.baseOffset + next),
        makePosition(tracker, frame.baseOffset + i, frame.baseOffset + next),
      );
      frame.i = next;
      continue;
    }

    // ── 优先级 4: inline 帧关闭检测 ──
    //
    // inline 帧不再做裸括号配平。
    // 只在遇到 )$$ / )% / )* 时判定完整 form；shorthand 子帧只吃一个 )。
    if (tryConsumeInlineCloseAtCursor(frame, frameText, i)) {
      continue;
    }

    // ── 优先级 5: 非 inline 帧的意外 endTag ──
    // 非 inline 帧不存在合法 endTag 闭合；只消费 tagClose，把 tagPrefix 留给下一轮 tag 识别。
    if (scanEndTagAt(frameText, endTag, i, frame.textEnd) === "full") {
      const nextIsTag = readTagStartInfo(frameText, i + tagClose.length, syntax, tagName);
      if (!nextIsTag) {
        emitError(
          tracker,
          onError,
          "UNEXPECTED_CLOSE",
          frameText,
          i,
          tagClose.length,
          emittedErrorKeys,
        );
      }
      appendBuf(frame, i, i + tagClose.length);
      frame.i += tagClose.length;
      continue;
    }

    // ── 优先级 6: 管道分隔符（仅参数区内） ──
    if (frame.insideArgs && frameText.startsWith(tagDivider, i)) {
      flushBuffer(frame);
      pushNode(
        frame.nodes,
        factory.separator(frame.baseOffset + i, frame.baseOffset + i + tagDivider.length),
        makePosition(tracker, frame.baseOffset + i, frame.baseOffset + i + tagDivider.length),
      );
      frame.i += tagDivider.length;
      continue;
    }

    // ── 优先级 7: 标签头 / 文本 ──
    if (tryConsumeTagOrTextAtCursor(frame, frameText, i)) {
      continue;
    }

    // ── 优先级 8: 兜底 ──
    // 防御性兜底：避免未来重构导致该分支返回 false 时卡住游标。
    appendBuf(frame, i, i + 1);
    frame.i++;
  }

  return [];
};

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
): IndexedStructuralNode[] =>
  parseNodesWithFactory(text, depth, ctx, insideArgs, baseOffset, indexedNodeFactory);

// public structural parser 直接产出 StructuralNode[]。
// 这条路径不再经过 stripMetaForest，也不再复制一整棵树剥离 _meta。
const parsePublicNodes = (
  text: string,
  depth: number,
  ctx: ScanContext,
  insideArgs: boolean,
  baseOffset: number,
): StructuralNode[] =>
  parseNodesWithFactory(text, depth, ctx, insideArgs, baseOffset, publicNodeFactory);

// ── Public API ──

/**
 * Parse with already-resolved syntax/tag-name config and optional gating context.
 *
 * Used by render/incremental paths to avoid resolving options repeatedly.
 *
 * @example
 * ```ts
 * const resolved = resolveBaseOptions("=bold<hello>=");
 * const nodes = parseStructuralWithResolved("=bold<hello>=", resolved, null);
 * ```
 */
export const parseStructuralWithResolved = (
  text: string,
  resolved: BaseResolvedConfig,
  gating: GatingContext | null,
  onError?: (error: ParseError) => void,
): IndexedStructuralNode[] => {
  if (!text) return [];

  // 注意：本次 parse 调用内应将 `resolved.syntax` 视为不可变对象。
  // escape token 的缓存以 syntax 对象身份作为键。
  const ctx: ScanContext = {
    depthLimit: resolved.depthLimit,
    gating,
    tracker: resolved.tracker,
    syntax: resolved.syntax,
    tagName: resolved.tagName,
    onError,
  };
  // `_meta` 必须保持"切片局部坐标"。
  // 原因：render 的退化路径会直接用 `source.slice(_meta.start, _meta.end)` 回切源码，
  // 如果这里偷改成绝对 offset，源码切片会直接错。
  //
  // tracker 可以共享，用来把公开 position 回指原文；
  // 但 raw / render 两套最终 span 语义，仍然各自结算，不能混。
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
 *
 * @example
 * ```ts
 * const nodes = parseStructural("=bold<hello>=");
 * ```
 */
export const parseStructural = (
  text: string,
  options?: StructuralParseOptions,
): StructuralNode[] => {
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

  const resolved = resolveBaseOptions(text, options, {
    syntax: legacySyntax,
    tagName: legacyTagName,
  });
  const gating = options?.handlers
    ? buildGatingContext(options.handlers, options.allowForms, options.implicitInlineShorthand)
    : null;
  // public 路径只需要 position，不需要 _meta。
  // 因此这里直接走 parsePublicNodes，避免先构内部树再做 strip/copy。
  const ctx: ScanContext = {
    depthLimit: resolved.depthLimit,
    gating,
    tracker: resolved.tracker,
    syntax: resolved.syntax,
    tagName: resolved.tagName,
  };
  return parsePublicNodes(text, 0, ctx, false, 0);
};
