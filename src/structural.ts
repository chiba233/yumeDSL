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
//   ~125  pushNode / node工厂     节点工具
//   ~212  ScanContext            跨递归层共享的不可变配置
//   ~237  parseNodes             主入口（下面全是它的内部定义）
//
//  parseNodes 内部结构：
//   ~252  ── 帧定义 ──           ParseFrame 接口 + ReturnKind 类型
//   ~296  makeFrame              帧工厂
//   ~326  ── 缓冲区 ──           flushBuffer / appendBuf
//   ~354  ── 子帧完成分发 ──     completeChild：按 returnKind 统一组装节点
//   ~428  buildComplexMeta       raw / block 的 meta + position 构造
//   ~451  pushInlineChild        push inline 子帧（lazy close，不预扫）
//
//  主循环（~489 while）：
//   ~492  帧完成                 textEnd 到达 / inline 未闭合处理
//   ~520  转义序列               readEscapedSequence
//   ~537  inline 帧 argClose     )$$ / )% / )* form 判定 + shorthand 关闭
//   ~715  非 inline 帧意外 endTag
//   ~723  管道分隔符             insideArgs 时的 | 处理
//   ~738  标签头识别             readTagStartInfo + shorthand 识别
//   ~750  深度限制退化           skipTagBoundary
//   ~759  inline 帧嵌套标签      gating 检查 + pushInlineChild（跳过 getTagCloserType）
//   ~775  非 inline 帧 form 判定 getTagCloserType → inline / raw / block 分发
//
//   ~926  ── Public API ──       parseStructuralWithResolved / parseStructural
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
import {
  type BaseResolvedConfig,
  buildGatingContext,
  type GatingContext,
  resolveBaseOptions,
  supportsInlineForm,
} from "./resolveOptions.js";
import { emitError } from "./errors.js";
import {
  findBlockClose,
  findMalformedWholeLineTokenCandidate,
  findRawClose,
  getTagCloserType,
  readTagStartInfo,
  skipTagBoundary,
} from "./scanner.js";
import { makePosition, type PositionTracker } from "./positions.js";

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
  const { tagClose, tagDivider, tagOpen, endTag, rawClose } = syntax;
  const emittedErrorKeys = new Set<string>();

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
    shorthandProbeStartI: number; // 最近一次前探起点
    shorthandProbeBoundaryI: number; // 最近一次前探命中的首个边界位置（tagClose / full tag start / EOF）
    shorthandProbeReject: boolean; // 该边界是否表示“会误吃父级 endTag，需拒绝 shorthand”
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
    shorthandProbeStartI: -1,
    shorthandProbeBoundaryI: -1,
    shorthandProbeReject: false,
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
        value = frame.text.slice(segments[0], segments[1]) + frame.text.slice(segments[2], segments[3]);
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
    pushNode(
      frame.nodes,
      factory.text(value, startOff, endOff),
      makePosition(tracker, startOff, endOff),
    );
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
    child.returnKind = returnKind;
    child.parentIndex = parentIndex;
    child.tag = tag;
    child.meta = meta;
    child.tagPosition = tagPosition;
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

  type EndTagMatchState = "none" | "full" | "truncated-prefix";
  const scanEndTagAt = (text: string, start: number, endExclusive: number): EndTagMatchState => {
    if (start >= endExclusive) return "none";
    if (text[start] !== endTag[0]) return "none";
    let offset = 0;
    while (offset < endTag.length) {
      const pos = start + offset;
      if (pos >= endExclusive) return "truncated-prefix";
      if (text[pos] !== endTag[offset]) return "none";
      offset++;
    }
    return "full";
  };

  const tryPushInlineShorthandChild = (
    frame: ParseFrame,
    tagStartI: number,
    info: ShorthandStartInfo,
  ): boolean => {
    // Guard ambiguity like `=bold<bold<>=`:
    // if shorthand arg starts exactly at parent's inline close token (`endTag`),
    // this `name<` is text and the following close belongs to parent.
    if (frame.inlineCloseToken === endTag && scanEndTagAt(frame.text, info.argStart, frame.textEnd) === "full") {
      return false;
    }

    // Guard ambiguity where shorthand would consume the `tagClose` that is
    // actually the start of parent's `endTag` (e.g. `=bold<bold<<>=`).
    if (frame.inlineCloseToken === endTag) {
      const canReuseProbe =
        frame.shorthandProbeStartI >= 0 &&
        frame.shorthandProbeBoundaryI >= 0 &&
        info.argStart >= frame.shorthandProbeStartI &&
        info.argStart <= frame.shorthandProbeBoundaryI;

      if (!canReuseProbe) {
        let boundary = frame.text.length;
        let reject = false;
        let probe = info.argStart;
        while (probe < frame.text.length) {
          const [escaped, nextEsc] = readEscapedSequence(frame.text, probe, syntax);
          if (escaped !== null) {
            probe = nextEsc;
            continue;
          }
          // Full DSL structure has priority over shorthand:
          // once a full tag starts, shorthand child would end before it.
          if (readTagStartInfo(frame.text, probe, syntax, tagName)) {
            boundary = probe;
            reject = false;
            break;
          }
          if (frame.text.startsWith(tagClose, probe)) {
            boundary = probe;
            reject = scanEndTagAt(frame.text, probe, frame.textEnd) === "full";
            break;
          }
          probe++;
        }

        frame.shorthandProbeStartI = info.argStart;
        frame.shorthandProbeBoundaryI = boundary;
        frame.shorthandProbeReject = reject;
      }

      if (frame.shorthandProbeReject) {
        return false;
      }
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

  // ── 主循环 ──

  const stack: ParseFrame[] = [makeFrame(text, depth, insideArgs, baseOffset)];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    // ── 帧完成 ──
    if (frame.i >= frame.textEnd) {
      if (frame.inlineCloseToken !== null) {
        // inline 帧走到文本末尾仍未关闭 → 未闭合错误
        // 这里不要整段吞掉：只把 tag 头回退成普通文本，并把父帧 i 放回 argStart。
        // 后续正文会继续在父帧里按正常字符流扫描，这是老版本错误恢复语义。
        emitError(
          tracker,
          onError,
          frame.implicitInlineShorthand ? "SHORTHAND_NOT_CLOSED" : "INLINE_NOT_CLOSED",
          frame.text,
          frame.tagStartI,
          frame.argStartI - frame.tagOpenPos,
          emittedErrorKeys,
        );
        stack.pop();
        const parent = stack[frame.parentIndex];
        appendBuf(parent, frame.tagStartI, frame.argStartI);
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
        factory.escape(frameText.slice(i, next), frame.baseOffset + i, frame.baseOffset + next),
        makePosition(tracker, frame.baseOffset + i, frame.baseOffset + next),
      );
      frame.i = next;
      continue;
    }

    // ── inline 帧的 argClose 检测 ──
    //
    // inline 帧不再做裸括号配平。
    // 只在遇到 )$$ / )% / )* 时判定完整 form；shorthand 子帧只吃一个 )。
    if (frame.inlineCloseToken !== null) {
      const { tagClose, rawOpen, blockOpen, blockClose } = syntax;

      if (frame.inlineCloseToken === tagClose) {
        if (frameText.startsWith(tagClose, i)) {
          if (frame.implicitInlineShorthand) {
            const parent = stack[frame.parentIndex];
            if (
              parent &&
              parent.inlineCloseToken === endTag &&
              scanEndTagAt(frameText, i, frame.textEnd) === "full"
            ) {
              stack.pop();
              appendBuf(parent, frame.tagStartI, frame.argStartI);
              parent.i = frame.argStartI;
              continue;
            }
          }
          flushBuffer(frame);
          frame.inlineCloseWidth = tagClose.length;
          stack.pop();
          completeChild(frame);
          continue;
        }
      } else if (frameText.startsWith(tagClose, i)) {
        // ) 系列判定（完整 DSL inline 参数区）

        if (scanEndTagAt(frameText, i, frame.textEnd) === "full") {
          // )$$ → inline close
          flushBuffer(frame);
          frame.inlineCloseWidth = endTag.length;
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
            continue;
          }

          if (gating && !gating.handlers[frame.tag]?.raw) {
            // handler 不支持 raw → 整段降级为文本
            const end = closeStart + syntax.rawClose.length;
            stack.pop();
            appendBuf(parent, tagStartI, end);
            parent.i = end;
            continue;
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
          pushNode(
            parent.nodes,
            factory.raw(frame.tag, args, frameText.slice(contentStart, closeStart), meta.meta),
            meta.pos,
          );
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
            const malformed = findMalformedWholeLineTokenCandidate(
              frameText,
              contentStart,
              blockClose,
            );
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
            continue;
          }

          if (gating && !gating.handlers[frame.tag]?.block) {
            const end = closeStart + blockClose.length;
            stack.pop();
            appendBuf(parent, tagStartI, end);
            parent.i = end;
            continue;
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
          continue;
        }

        // ) 后面不是 $$ / % / * → 普通文本
        appendBuf(frame, i, i + tagClose.length);
        frame.i += tagClose.length;
        continue;
      }
    }

    // ── 非 inline 帧的意外 endTag ──
    if (scanEndTagAt(frameText, i, frame.textEnd) === "full") {
      emitError(tracker, onError, "UNEXPECTED_CLOSE", frameText, i, endTag.length, emittedErrorKeys);
      appendBuf(frame, i, i + endTag.length);
      frame.i += endTag.length;
      continue;
    }

    // ── 管道分隔符（仅参数区内） ──
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

    // ── 标签头识别 ──
    const info = readTagStartInfo(frameText, i, syntax, tagName);
    if (!info) {
      if (frame.inlineCloseToken !== null) {
        const shorthand = readInlineShorthandStart(frameText, i);
        if (shorthand && tryPushInlineShorthandChild(frame, i, shorthand)) {
          continue;
        }
      }
      appendBuf(frame, i, i + 1);
      frame.i++;
      continue;
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
      continue;
    }

    // ── inline 帧内的嵌套标签：直接 push 子帧，跳过 getTagCloserType ──
    //
    // inline 帧子扫描直接逐字符前进：
    // 子帧遇到 ) 时按自身 close token 判定关闭，不需要预扫 findTagArgClose。
    // 这使得纯 inline 深嵌套保持 O(n)。
    //
    // 注意：仍需检查 gating。如果标签的 inline form 不被支持，
    // 应该当普通字符处理，而不是盲目 push 子帧。
    if (frame.inlineCloseToken !== null) {
      if (!tryPushInlineChild(frame, i, info)) {
        // 完整 DSL 结构优先于文本：即使当前 tag 不支持 inline form，
        // 也要整段降级为文本，避免把内层 )$$ 误判成当前层关闭。
        const degradedEnd = skipTagBoundary(frameText, info, syntax, tagName);
        appendBuf(frame, i, degradedEnd);
        frame.i = degradedEnd;
      }
      continue;
    }

    // ── 确定标签形态（仅非 inline 帧需要）──
    const closerInfo = getTagCloserType(frameText, info.tagNameEnd + tagOpen.length, syntax);
    if (!closerInfo) {
      // findTagArgClose 因内容括号不配对返回 -1。
      // 进入 lazy inline 模式：子帧逐字符扫描 endTag，不依赖括号配对。
      // 仍需遵守 inline gating：若 gating 拒绝，降级为文本。
      if (!tryPushInlineChild(frame, i, info)) {
        const degradedEnd = skipTagBoundary(frameText, info, syntax, tagName);
        appendBuf(frame, i, degradedEnd);
        frame.i = degradedEnd;
      }
      continue;
    }

    const handler = gating?.handlers[info.tag];

    // ── Inline 形态 ──
    if (closerInfo.closer === endTag) {
      if (!tryPushInlineChild(frame, i, info)) {
        appendBuf(frame, i, i + 1);
        frame.i++;
      }
      continue;
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
        continue;
      }

      if (gating && !handler?.raw) {
        const end = closeStart + syntax.rawClose.length;
        appendBuf(frame, i, end);
        frame.i = end;
        continue;
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
      continue;
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
      continue;
    }

    if (gating && !handler?.block) {
      const end = closeStart + syntax.blockClose.length;
      appendBuf(frame, i, end);
      frame.i = end;
      continue;
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

export const parseStructuralWithResolved = (
  text: string,
  resolved: BaseResolvedConfig,
  gating: GatingContext | null,
  onError?: (error: ParseError) => void,
): IndexedStructuralNode[] => {
  if (!text) return [];

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
