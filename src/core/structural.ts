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
//    ~98  IndexedStructuralNode  内部节点类型（带 _meta）
//   ~161  pushNode / node工厂     节点工具
//   ~197  ScanContext            跨递归层共享的不可变配置
//   ~210  parseNodesWithFactory  主入口（下面全是它的内部定义）
//
//  parseNodesWithFactory 内部结构：
//   ~315  ── 帧定义 ──           ParseFrame 接口 + ReturnKind 类型
//   ~352  makeFrame              帧工厂
//   ~388  ── 缓冲区 ──           flushBuffer / appendBuf
//   ~482  ── 子帧完成分发 ──     completeChild：按 returnKind 统一组装节点
//   ~552  buildComplexMeta       raw / block 的 meta + position 构造
//   ~584  emitCloseNotFoundError raw / block close 未找到的统一错误发射
//   ~632  pushInlineChildFrame   push inline 子帧（lazy close，不预扫）
//   ~707  ownership 辅助         getAncestorEndTagOwner / hasEndTagOwnerAt
//   ~724  shorthand ownership    tryPushInlineShorthandChild
//   ~777  未闭合 inline 错误     emitUnclosedInlineFrameError
//   ~789  EOF replay             replayMalformedInlineChainAtEof
//
//  inline 帧关闭（拆分为三个函数）：
//   ~829  tryCloseShorthandFrame      shorthand 子帧关闭（defer-parent / 正常关闭）
//   ~878  tryCloseFullInlineFrame     完整 DSL 子帧关闭 / form 转换（endTag / raw / block）
//  ~1021  tryConsumeInlineCloseAtCursor 薄调度层，按 inlineCloseToken 类型分派
//
//  标签 / 文本消费：
//  ~1056  tryConsumeTagOrTextAtCursor  标签头识别 + form 分发（inline / raw / block）
//
//  主循环（~1267 while，优先级 1-8 见循环顶部注释）：
//  ~1234  tryFinalizeFrameAtEof       帧 EOF 收尾
//
//  抽离模块：
//  structuralOwnership.ts
//   - scanEndTagAt
//   - resolveShorthandOwnershipPush / resolveShorthandOwnershipClose
//   - buildMalformedInlineReplayPlan
//
//  ~1364  ── Public API ──       parseNodes / parseStructuralWithResolved / parseStructural
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
import { DEFAULT_TAG_NAME, getTagNameConfig, isWholeLineToken } from "../config/chars.js";
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
  getTagCloserType,
  getTagCloserTypeWithCache,
  readTagStartInfo,
  skipTagBoundary,
  skipTagBoundaryWithCache,
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
  let inlineCloseCache: Map<number, number> | null = null;

  // ── 整行 close token 的「下一处」位置表（一次性受控扫描，O(1) 查询） ──
  //
  // 未闭合 raw/block 链退化时，`findRawClose` / `findBlockClose` 会按构造数被反复调用、每次扫到 EOF
  // → 总量 O(n²)。这里用一遍**反向**受控扫描，给每个位置 p 预存「从 p 起第一处整行 rawClose /
  // blockClose 的起点」（没有则 -1）。判定整行 close 只用行首 + isWholeLineToken：不用 indexOf、不靠
  // token 长度推断有无（长度只在 isWholeLineToken 内做匹配）。按需触发、只跑一次、O(n) 建表，之后每次
  // 查 close 都是 O(1) 取值——既消掉了反复扫到 EOF 的二次方，又**不引入二分的 log 因子**，保持整体
  // Θ(n)。空间与既有的 tagArgClose / inlineClose 缓存同量级（O(n)）。
  //
  // raw 正文不嵌套 ⇒ nextRawCloseAt[start] 就是 findRawClose(start)（逐字节一致）。
  // block 会嵌套跳过内层 raw/block/inline ⇒ 表只用来判「后方有无整行 blockClose」：无则 O(1) 返回 -1
  //   （覆盖未闭合 block 链这一 DoS 主因），有则回退真正的 findBlockClose（语义不变；各 close 区间互不
  //   重叠 ⇒ 回退路径总量仍 O(n)）。
  let nextRawCloseAt: Int32Array | null = null;
  let nextBlockCloseAt: Int32Array | null = null;
  const ensureNextCloseTables = (): void => {
    if (nextRawCloseAt !== null) return;
    const n = text.length;
    const raw = new Int32Array(n + 1);
    const block = new Int32Array(n + 1);
    raw[n] = -1;
    block[n] = -1;
    for (let p = n - 1; p >= 0; p--) {
      const atLineStart = p === 0 || text[p - 1] === "\n";
      raw[p] = atLineStart && isWholeLineToken(text, p, syntax.rawClose) ? p : raw[p + 1];
      block[p] = atLineStart && isWholeLineToken(text, p, syntax.blockClose) ? p : block[p + 1];
    }
    nextRawCloseAt = raw;
    nextBlockCloseAt = block;
  };
  const findRawCloseCached = (start: number): number => {
    ensureNextCloseTables();
    return nextRawCloseAt![start];
  };
  const findBlockCloseCached = (start: number): number => {
    ensureNextCloseTables();
    return nextBlockCloseAt![start] === -1 ? -1 : findBlockClose(text, start, syntax, tagName);
  };

  const isInlineCapable = (tag: string): boolean =>
    !gating ||
    supportsInlineForm(gating.handlers[tag], gating.allowInline, gating.registeredTags.has(tag));

  // ── EOF 未闭合链单遍退化：帧命运推演（frame-fate walk）──
  //
  // walkInlineFrameFate(start, depth, boundary)：推演「参数区从 start 起、深度为 depth、扫描边界为
  // boundary 的 full-inline 子帧」最终的命运——闭合 / 转换后父帧续扫的位置，或一路悬挂到 boundary。
  // 与旧 tailResolveEnd 的本质差别：不再是一个「会漂移的平行 mini 解析器」，每条分支都直接调用
  // 真解析器同款的判定函数、按主循环同一优先级顺序镜像 cursor 行为（结点构造与错误发射除外）：
  //   · 转义：readEscapedSequenceWithTokens + argEscapableTokens（inline 子帧恒为 insideArgs）；
  //   · 关闭/转换：镜像 tryCloseFullInlineFrame——先 tagClose 门槛，再 scanEndTagAt(=boundary 截断语义)
  //     判 `)$$` 闭合，再 rawOpen/blockOpen 判转换；转换的父帧续扫位置与真分支逐字节一致
  //     （close 未找到 → contentStart；找到 → closeStart + close.length，gating 接受与否续扫位置相同）；
  //   · 管道分隔符：insideArgs 帧消费 tagDivider；
  //   · 嵌套 tag 头：gating 拒绝 inline 时走 skipTagBoundaryWithCache（与 skipTagBoundary 输出一致）；
  //     否则以 depth+1 递归推演子帧——深度达 depthLimit 的子帧进入「饱和帧」推演（见下），
  //     子帧悬挂 ⇒ 本帧悬挂（EOF replay 整链剥离），否则在子帧收尾处续扫；
  //   · shorthand 头（gating.inlineShorthandEnabled 下的 name(...)）：ownership 探测带帧状态，无法无
  //     副作用推演 → WALK_UNSAFE，整条查询退回 1.5.1 replay 级联（逐字节正确，仅慢）。
  //
  // 饱和帧（depth === depthLimit 的真帧）内所有嵌套头都走 DEPTH_LIMIT skip、永不 push——行为与
  // 具体深度无关、无栈，位置 x 之后的命运是纯后缀性质。satFrameFate 单独推演它：沿途记录决策点、
  // 收尾时把最终命运回填整条路径（后缀共享），使饱和扫描全局总量 O(n)，深链每头查询摊还 O(depthLimit)。
  // （回填条目的风险标记带上了段前缀累积值，可能高估 → 只会更保守地退回级联，不影响正确性。）
  //
  // 单遍剥离（degradeRescan 快路）只在 DANGLE 且 !hiddenRisk 时启用；其余一律退回级联。
  // hiddenRisk（错误键守恒）：剥离会跳过「被剥离帧的那次真实扫描」，其帧内发射（嵌套转换失败的
  // *_NOT_CLOSED、子链 replay 的 INLINE_NOT_CLOSED、depth-limit 后浅出补扫的发射）必须由父帧游标
  // 后续的真实重扫在同键位重发。嵌套 tag 头以 inline 子帧进入（无条件 push），而父帧重扫按根级
  // closerInfo 分发——两者仅在以下情形一致：
  //   · closerInfo 为 null / endTag：重扫同样 push inline 子帧（或对其再次剥离），递归真实；
  //   · raw/block 形态：该子帧恰好在 closerInfo.argClose 处以同形态转换（分发与转换同键同续扫位，
  //     路径立即重合），且参数区 [argStart, argClose) 内无任何嵌套帧 / depth-limit 跳过——根级 form
  //     分发在 close 未找到时把整段（含参数区）直接降级为文本、不再扫描内部，参数区里帧内发射的键
  //     只存在于被跳过的那次真实扫描。
  // 其余（form 形态但悬挂 / 在别处转换 / `)$$` 闭合 / 参数区含帧）→ hiddenRisk，退回级联。
  //
  // 记忆化：主表按 start 记条目；命中条件：boundary 一致，且（未 limitHit 且 depth+maxRel <
  //   depthLimit——深度平移不会改变任何分支）或（depth 与条目完全一致）。深度敏感条目进溢出表
  //   （start:depth:boundary 键）。整体 O(n·depthLimit) 上界、典型 O(n)。显式栈，无递归。
  // 判定全程只用可控扫描 + startsWith + 确认命中后按 token.length 消费；不用 indexOf、不用长度推断。
  const WALK_DANGLE = -1;
  const WALK_UNSAFE = -2;
  interface WalkEntry {
    verdict: number; // WALK_DANGLE / WALK_UNSAFE / 父帧续扫位置
    depth: number; // 条目推演时的帧深度
    maxRel: number; // 推演内到达的最深嵌套帧相对深度（0 = 无嵌套 push）
    limitHit: boolean; // 推演内是否发生过 depth-limit 跳过（含饱和段内的头 skip）
    hiddenRisk: boolean; // 推演内是否存在父帧重扫无法同键重发的帧内发射（见上）
    resolveKind: 0 | 1 | 2 | 3; // 0=非转换收尾(悬挂/UNSAFE) 1=raw 转换 2=block 转换 3=`)$$` 闭合
    resolvePos: number; // 转换/闭合 token 的起始位置（resolveKind>0 时有效）
    boundary: number; // 推演边界（帧的 textEnd）
  }
  const walkMemo = new Map<number, WalkEntry>();
  let walkMemoOverflow: Map<string, WalkEntry> | null = null;
  const walkMemoLookup = (start: number, depth: number, boundary: number): WalkEntry | null => {
    const primary = walkMemo.get(start);
    if (primary && primary.boundary === boundary) {
      if (!primary.limitHit && depth + primary.maxRel < depthLimit) return primary;
      if (primary.depth === depth) return primary;
    }
    return walkMemoOverflow?.get(`${start}:${depth}:${boundary}`) ?? null;
  };
  const walkMemoStore = (start: number, entry: WalkEntry): void => {
    const primary = walkMemo.get(start);
    if (!primary) {
      walkMemo.set(start, entry);
      return;
    }
    if (primary.boundary === entry.boundary && primary.depth === entry.depth) return;
    (walkMemoOverflow ??= new Map<string, WalkEntry>()).set(
      `${start}:${entry.depth}:${entry.boundary}`,
      entry,
    );
  };
  // 根级 form 分发期望：0=无（closerInfo null/endTag）；1/2=raw/block 形态（须恰在 argClose 处同形态转换）。
  const walkExpectationFor = (
    info: TagStartInfo,
  ): { form: 0 | 1 | 2; argClose: number } => {
    const rootCloser = getTagCloserTypeWithCache(
      text,
      info.tagNameEnd + tagOpen.length,
      syntax,
      (tagArgCloseCache ??= new Map<number, number>()),
    );
    if (rootCloser === null || rootCloser.closer === endTag) return { form: 0, argClose: -1 };
    return { form: rootCloser.closer === rawClose ? 1 : 2, argClose: rootCloser.argClose };
  };
  interface WalkFrame {
    start: number;
    pos: number;
    depth: number;
    maxRel: number;
    limitHit: boolean;
    hiddenRisk: boolean;
    // 父帧对「刚 push 的子帧」的重扫期望（walkExpectationFor 的暂存，子帧收尾时校验）。
    pendingExpectForm: 0 | 1 | 2;
    pendingExpectArgClose: number;
  }
  // 消费一个子帧结果（新算 / 记忆化命中 / 饱和推演）：回传标记并做重扫期望校验。
  // form 期望（expectForm 1/2）要求：恰在 argClose 处同形态转换、参数区无嵌套帧（maxRel===0）、
  // 且无 depth-limit 跳过（!limitHit——被跳过的头会在 1.5.1 的后续重扫中浅出真扫，其发射同样藏在
  // form 分发不再扫描的参数区里）。
  const walkConsumeChild = (
    frame: WalkFrame,
    child: WalkEntry,
    expectForm: 0 | 1 | 2,
    expectArgClose: number,
  ): void => {
    frame.maxRel = Math.max(frame.maxRel, 1 + child.maxRel);
    frame.limitHit ||= child.limitHit;
    frame.hiddenRisk ||=
      child.hiddenRisk ||
      (expectForm !== 0 &&
        !(
          child.resolveKind === expectForm &&
          child.resolvePos === expectArgClose &&
          child.maxRel === 0 &&
          !child.limitHit
        ));
  };
  // 饱和段中被 skip 的 raw/block 形态头的参数区干净性（与 walkConsumeChild 的 form 期望同构的静态版）：
  // [from, to) 内不得出现任何 tag 头、`)$$` 闭合、`)%`/`)*` 转换——否则该头在 1.5.1 后续重扫浅出时的
  // 帧内行为（push 子帧 / 提前闭合 / 提前转换）与根级 form 分发不一致，键无法守恒。
  const satArgSpanClean = (from: number, to: number): boolean => {
    let p = from;
    while (p < to) {
      const [escaped, nextEsc] = readEscapedSequenceWithTokens(text, p, syntax, argEscapableTokens);
      if (escaped !== null) {
        p = nextEsc;
        continue;
      }
      if (text.startsWith(tagClose, p)) {
        if (
          scanEndTagAt(text, endTag, p, to) === "full" ||
          text.startsWith(syntax.rawOpen, p) ||
          text.startsWith(syntax.blockOpen, p)
        ) {
          return false;
        }
        p += tagClose.length;
        continue;
      }
      if (readTagStartInfo(text, p, syntax, tagName) !== null) return false;
      p++;
    }
    return true;
  };
  // 饱和帧推演：模拟 depth === depthLimit 的真 inline 帧——所有嵌套头 DEPTH_LIMIT skip、永不 push。
  // 无栈无深度 → 位置命运是纯后缀性质：沿途决策点收尾时统一回填（后缀共享），全局扫描总量 O(n)。
  const satFrameFate = (rootStart: number, boundary: number): WalkEntry => {
    const cachedRoot = walkMemoLookup(rootStart, depthLimit, boundary);
    if (cachedRoot !== null) return cachedRoot;
    const { rawOpen, blockOpen, blockClose } = syntax;
    let pos = rootStart;
    let limitHit = false;
    let hiddenRisk = false;
    let verdict = WALK_DANGLE;
    let resolveKind: 0 | 1 | 2 | 3 = 0;
    let resolvePos = -1;
    const visited: number[] = [rootStart];
    while (pos < boundary) {
      const hit = walkMemoLookup(pos, depthLimit, boundary);
      if (hit !== null) {
        // 后缀命中：采用其命运，风险标记向前缀累积。
        verdict = hit.verdict;
        resolveKind = hit.resolveKind;
        resolvePos = hit.resolvePos;
        limitHit ||= hit.limitHit;
        hiddenRisk ||= hit.hiddenRisk;
        break;
      }
      visited.push(pos);
      const [escaped, nextEsc] = readEscapedSequenceWithTokens(text, pos, syntax, argEscapableTokens);
      if (escaped !== null) {
        pos = nextEsc;
        continue;
      }
      if (text.startsWith(tagClose, pos)) {
        if (scanEndTagAt(text, endTag, pos, boundary) === "full") {
          verdict = pos + endTag.length;
          resolveKind = 3;
          resolvePos = pos;
          break;
        }
        if (text.startsWith(rawOpen, pos)) {
          const contentStart = pos + rawOpen.length;
          const closeStart = findRawCloseCached(contentStart);
          verdict = closeStart === -1 ? contentStart : closeStart + rawClose.length;
          resolveKind = 1;
          resolvePos = pos;
          break;
        }
        if (text.startsWith(blockOpen, pos)) {
          const contentStart = pos + blockOpen.length;
          const closeStart = findBlockCloseCached(contentStart);
          verdict = closeStart === -1 ? contentStart : closeStart + blockClose.length;
          resolveKind = 2;
          resolvePos = pos;
          break;
        }
        pos += tagClose.length;
        continue;
      }
      if (text.startsWith(tagDivider, pos)) {
        pos += tagDivider.length;
        continue;
      }
      const info = readTagStartInfo(text, pos, syntax, tagName);
      if (!info) {
        if (readInlineShorthandStart(text, pos) !== null) {
          verdict = WALK_UNSAFE;
          break;
        }
        pos++;
        continue;
      }
      // 饱和帧内所有头（gating 接受与否）都走 skipTagBoundary(WithCache) 整段跳过。
      const skipped = skipTagBoundaryWithCache(
        text,
        info,
        syntax,
        tagName,
        (tagArgCloseCache ??= new Map<number, number>()),
        (inlineCloseCache ??= new Map<number, number>()),
        findRawCloseCached,
        findBlockCloseCached,
      );
      if (isInlineCapable(info.tag)) {
        // gating 接受的头：真帧在此发 DEPTH_LIMIT 并 skip；1.5.1 的后续重扫会让它逐层浅出真扫。
        limitHit = true;
      }
      if (skipped !== info.argStart) {
        // 「跳过了内容」的 skip：只有 raw/block 形态、且参数区干净时，skip / 根级 form 分发 /
        // 浅出后的帧内转换三者才同键同续扫位（无论 gating 接受与否——分发的 close-fail /
        // gating-reject 分支与 skip 的落点逐字节一致）。其余（endTag 形态的 head-balance skip
        // 与浅出 push / root 单字符推进错位；参数区含帧）在 1.5.1 的相邻深度重扫下会翻转命运
        // 或把帧内发射吞进不再扫描的区间 → 键无法守恒。
        const expectation = walkExpectationFor(info);
        if (
          expectation.form === 0 ||
          !satArgSpanClean(info.argStart, expectation.argClose)
        ) {
          hiddenRisk = true;
        }
      }
      // lazy skip（仅越过 tag 头）：任何 scan 任何深度都同款推进，键守恒天然成立。
      pos = skipped;
      continue;
    }
    const entry: WalkEntry = {
      verdict,
      depth: depthLimit,
      maxRel: 0,
      limitHit,
      hiddenRisk,
      resolveKind,
      resolvePos,
      boundary,
    };
    for (let k = 0; k < visited.length; k++) {
      walkMemoStore(visited[k], entry);
    }
    return entry;
  };
  const walkInlineFrameFate = (
    rootStart: number,
    rootDepth: number,
    boundary: number,
  ): WalkEntry => {
    if (rootDepth >= depthLimit) return satFrameFate(rootStart, boundary);
    const cachedRoot = walkMemoLookup(rootStart, rootDepth, boundary);
    if (cachedRoot !== null) return cachedRoot;
    const { rawOpen, blockOpen, blockClose } = syntax;
    const stack: WalkFrame[] = [
      {
        start: rootStart,
        pos: rootStart,
        depth: rootDepth,
        maxRel: 0,
        limitHit: false,
        hiddenRisk: false,
        pendingExpectForm: 0,
        pendingExpectArgClose: -1,
      },
    ];
    let completed: WalkEntry | null = null;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      // 子帧刚收尾：把命运与标记回传给当前帧（镜像真解析器 completeChild 后父帧续扫）。
      if (completed !== null) {
        walkConsumeChild(frame, completed, frame.pendingExpectForm, frame.pendingExpectArgClose);
        if (completed.verdict === WALK_DANGLE || completed.verdict === WALK_UNSAFE) {
          // 子帧悬挂 ⇒ EOF replay 整链剥离，本帧同样悬挂；UNSAFE 向外传播。
          const entry: WalkEntry = {
            verdict: completed.verdict,
            depth: frame.depth,
            maxRel: frame.maxRel,
            limitHit: frame.limitHit,
            hiddenRisk: frame.hiddenRisk,
            resolveKind: 0,
            resolvePos: -1,
            boundary,
          };
          walkMemoStore(frame.start, entry);
          stack.pop();
          completed = entry;
          continue;
        }
        frame.pos = completed.verdict;
        completed = null;
      }
      let pos = frame.pos;
      let result = WALK_DANGLE; // 内层循环自然扫到 boundary 即悬挂
      let resolveKind: 0 | 1 | 2 | 3 = 0;
      let resolvePos = -1;
      let paused = false;
      while (pos < boundary) {
        // 优先级镜像主循环：转义 → inline 关闭/转换 → 管道 → tag 头/文本。
        const [escaped, nextEsc] = readEscapedSequenceWithTokens(
          text,
          pos,
          syntax,
          argEscapableTokens,
        );
        if (escaped !== null) {
          pos = nextEsc;
          continue;
        }
        if (text.startsWith(tagClose, pos)) {
          if (scanEndTagAt(text, endTag, pos, boundary) === "full") {
            result = pos + endTag.length; // `)$$` 闭合，父帧在其后续扫
            resolveKind = 3;
            resolvePos = pos;
            break;
          }
          if (text.startsWith(rawOpen, pos)) {
            // `)%` raw 转换：无论 close 是否找到 / gating 是否接受，父帧续扫位置与真分支一致。
            const contentStart = pos + rawOpen.length;
            const closeStart = findRawCloseCached(contentStart);
            result = closeStart === -1 ? contentStart : closeStart + rawClose.length;
            resolveKind = 1;
            resolvePos = pos;
            break;
          }
          if (text.startsWith(blockOpen, pos)) {
            // `)*` block 转换：同上；转换成功时 content 帧独立收尾，父帧直接跳到 close 之后。
            const contentStart = pos + blockOpen.length;
            const closeStart = findBlockCloseCached(contentStart);
            result = closeStart === -1 ? contentStart : closeStart + blockClose.length;
            resolveKind = 2;
            resolvePos = pos;
            break;
          }
          pos += tagClose.length; // `)` 后不是 $$/%/* → 普通文本
          continue;
        }
        if (text.startsWith(tagDivider, pos)) {
          pos += tagDivider.length; // insideArgs 帧的分隔符只推进 cursor
          continue;
        }
        const info = readTagStartInfo(text, pos, syntax, tagName);
        if (!info) {
          if (readInlineShorthandStart(text, pos) !== null) {
            result = WALK_UNSAFE; // shorthand ownership 探测带帧状态，无法无副作用推演
            break;
          }
          pos++;
          continue;
        }
        if (!isInlineCapable(info.tag)) {
          // gating 拒绝 inline：真分支为 skipTagBoundary(WithCache) 整段静默跳过（与深度无关）。
          const skipped = skipTagBoundaryWithCache(
            text,
            info,
            syntax,
            tagName,
            (tagArgCloseCache ??= new Map<number, number>()),
            (inlineCloseCache ??= new Map<number, number>()),
            findRawCloseCached,
            findBlockCloseCached,
          );
          if (skipped !== info.argStart) {
            // 「跳过了内容」的 reject-skip：raw/block 形态的根级分发（close-fail / gating-reject
            // 分支）与 skip 落点逐字节一致 → 安全；endTag 形态的根级 reject 是**单字符推进**，
            // 与整段 skip 错位——root 可在错位区间撞上重叠 tag 头改走完全不同的消费路径，把
            // 推演悬挂路径上会真实发射的结构吞进文本 → 键无法守恒。lazy（=argStart）恒安全。
            const expectation = walkExpectationFor(info);
            if (expectation.form === 0) frame.hiddenRisk = true;
          }
          pos = skipped;
          continue;
        }
        const expectation = walkExpectationFor(info);
        if (frame.depth + 1 >= depthLimit) {
          // 子帧深度达 depthLimit → 饱和帧推演（后缀共享，见 satFrameFate）。
          const sat = satFrameFate(info.argStart, boundary);
          walkConsumeChild(frame, sat, expectation.form, expectation.argClose);
          if (sat.verdict === WALK_DANGLE || sat.verdict === WALK_UNSAFE) {
            result = sat.verdict;
            break;
          }
          pos = sat.verdict;
          continue;
        }
        const nested = walkMemoLookup(info.argStart, frame.depth + 1, boundary);
        if (nested !== null) {
          walkConsumeChild(frame, nested, expectation.form, expectation.argClose);
          if (nested.verdict === WALK_DANGLE || nested.verdict === WALK_UNSAFE) {
            result = nested.verdict;
            break;
          }
          pos = nested.verdict;
          continue;
        }
        frame.pos = pos;
        frame.pendingExpectForm = expectation.form;
        frame.pendingExpectArgClose = expectation.argClose;
        stack.push({
          start: info.argStart,
          pos: info.argStart,
          depth: frame.depth + 1,
          maxRel: 0,
          limitHit: false,
          hiddenRisk: false,
          pendingExpectForm: 0,
          pendingExpectArgClose: -1,
        });
        paused = true;
        break;
      }
      if (paused) continue;
      const entry: WalkEntry = {
        verdict: result,
        depth: frame.depth,
        maxRel: frame.maxRel,
        limitHit: frame.limitHit,
        hiddenRisk: frame.hiddenRisk,
        resolveKind,
        resolvePos,
        boundary,
      };
      walkMemoStore(frame.start, entry);
      stack.pop();
      completed = entry;
    }
    return completed!;
  };
  // 单遍剥离守恒条件（详见上方注释）：悬挂、无 shorthand（UNSAFE）、无帧内发射键丢失风险。
  const inlineIsPlainDangling = (start: number, childDepth: number, boundary: number): boolean => {
    const fate = walkInlineFrameFate(start, childDepth, boundary);
    return fate.verdict === WALK_DANGLE && !fate.hiddenRisk;
  };

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
    // 循环内 frame.* 均为不变量（本次扫描只读不改 frame），提到循环外避免每字符的属性链访问。
    const frameText = frame.text;
    const frameTextEnd = frame.textEnd;
    const frameInsideArgs = frame.insideArgs;
    for (let cursor = from; cursor < frameTextEnd; cursor++) {
      const currentCode = frameText.charCodeAt(cursor);
      if (watchShorthandStart && tagName.isTagStartChar(frameText[cursor])) return cursor;
      if (currentCode === tagPrefixLeadCode || currentCode === tagCloseLeadCode) return cursor;
      if (frameInsideArgs && currentCode === tagDividerLeadCode) return cursor;
      if (canReadEscaped && currentCode === escapeLeadCode) return cursor;
      if (hasInlineCloseToken && currentCode === inlineCloseLeadCode) return cursor;
    }
    return frameTextEnd;
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

    // ── EOF 未闭合链单遍退化标记 ──
    // replay 把非 inline 父帧（根 / blockContent / args）标记 degradeRescan 后，主循环重扫时对
    // 「守恒悬挂」的 inline（walkInlineFrameFate 判定悬挂到 frame.textEnd 且无键丢失风险）直接
    // 退化为文本，不再 push 子帧 / 触发回退重扫。
    degradeRescan: boolean;
    // 单遍退化期间收集的未闭合 inline 错误 (tagStartI, span) 扁平对；该帧 EOF 收尾时倒序发出，
    // 复刻原 replay 的 innermost-first 顺序。按需创建。
    degradeTailErr: number[] | null;
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
    degradeRescan: false,
    degradeTailErr: null,
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
      // args 完成，挂到 content 帧上，不再借 parent 临时槽
      const content = makeFrame(
        child.text,
        parent.depth + 1,
        false,
        parent.baseOffset,
        child.contentStartI,
        child.contentEndI,
      );
      content.pendingArgs = childNodes;
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
        factory.block(child.tag, child.pendingArgs!, childNodes, child.meta!),
        child.tagPosition,
      );
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

  // ── close-not-found 错误发射 ──
  //
  // raw / block 的 close 查找失败时，统一走这个路径：
  // 1. 尝试 findMalformedWholeLineTokenCandidate 定位"长得像但格式不对"的候选
  // 2. 根据是否找到候选选择 MALFORMED / NOT_CLOSED 错误码
  // 3. 通过 emitError 上报，emittedErrorKeys 防重复
  //
  // 调用方自行处理降级逻辑（inline 帧需 stack.pop + 操作 parent，非 inline 帧直接操作 frame）。
  const emitCloseNotFoundError = (
    frameText: string,
    contentStart: number,
    tagStartI: number,
    closeToken: string,
    malformedCode: "RAW_CLOSE_MALFORMED" | "BLOCK_CLOSE_MALFORMED",
    unclosedCode: "RAW_NOT_CLOSED" | "BLOCK_NOT_CLOSED",
  ): void => {
    // 无 onError 时整段是纯计算、结果只喂给会被 emitError 直接丢弃的发射；提前返回，省掉
    // findMalformedWholeLineTokenCandidate 的逐行扫描（未闭合 raw/block 链里它每次 O(remaining) → O(n²)）。
    // 行为不变：emitError 在 !onError 时本就是 no-op。
    if (!onError) return;
    const malformed = findMalformedWholeLineTokenCandidate(frameText, contentStart, closeToken);
    emitError(
      tracker,
      onError,
      malformed ? malformedCode : unclosedCode,
      frameText,
      malformed?.index ?? tagStartI,
      malformed?.length ?? contentStart - tagStartI,
      emittedErrorKeys,
    );
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
    // 所有非 inline 父帧（根 / blockContent / args）都启用单遍退化重扫；
    // 帧命运推演以 parent.textEnd 为边界，块内 / 参数区内的未闭合链同样单遍线性剥离。
    parent.degradeRescan = true;
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

    // ── inline 帧内的 raw / block form 转换 ──
    //
    // 与 tryConsumeTagOrTextAtCursor 里的 raw/block 路径看起来相似但本质不同：
    // 这里当前帧已经是 inline 子帧，frame.nodes 里已经有解析好的 args，
    // 所以 raw 直接产出最终节点，block 直接推 blockContent 帧。
    // 而 tryConsumeTagOrTextAtCursor 里 args 还未解析，
    // 需要先推 rawArgs / blockArgs 子帧，由 completeChild 后续组装。
    if (frameText.startsWith(rawOpen, i)) {
      // )% → raw form
      const argClose = i;
      const contentStart = argClose + rawOpen.length;
      const closeStart = findRawCloseCached(contentStart);
      const parent = stack[frame.parentIndex];
      const tagStartI = frame.tagStartI;

      if (closeStart === -1) {
        emitCloseNotFoundError(frameText, contentStart, tagStartI, syntax.rawClose, "RAW_CLOSE_MALFORMED", "RAW_NOT_CLOSED");
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
      const closeStart = findBlockCloseCached(contentStart);
      const parent = stack[frame.parentIndex];
      const tagStartI = frame.tagStartI;

      if (closeStart === -1) {
        emitCloseNotFoundError(frameText, contentStart, tagStartI, blockClose, "BLOCK_CLOSE_MALFORMED", "BLOCK_NOT_CLOSED");
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
      const contentFrame = makeFrame(
        frameText,
        parent.depth + 1,
        false,
        parent.baseOffset,
        contentStart,
        closeStart,
      );
      contentFrame.pendingArgs = args;
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
      const degradedEnd = skipTagBoundaryWithCache(
        frameText,
        info,
        syntax,
        tagName,
        (tagArgCloseCache ??= new Map<number, number>()),
        (inlineCloseCache ??= new Map<number, number>()),
        findRawCloseCached,
        findBlockCloseCached,
      );
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

    // ── degradeRescan 单遍退化（非 inline 帧；仅 inline 形态、inline-capable、守恒悬挂）──
    //
    // EOF 未闭合链重扫态下，若该 tag 是 inline 形态（closerInfo 为空=括号不配对的 lazy inline，
    // 或 closer===endTag）、inline-capable，且帧命运推演判定它「悬挂到本帧 textEnd 且满足守恒条件」
    // （walkInlineFrameFate：闭合/转换均镜像真分支；shorthand / 键守恒风险 hiddenRisk 退回级联），
    // 则直接把 tag 头退化成文本、游标推进到 argStart，不再 push 一个会在 EOF 触发回退重扫的子帧
    // —— 整条尾巴单遍线性处理（推演记忆化，典型 O(n)）。
    //
    // 错误顺序：lazy 路径会把这些未闭合 inline push 成嵌套子帧链、EOF 经 replay 自内向外
    // （innermost-first）报 INLINE_NOT_CLOSED。单遍是从外向内扫，故先收集 (tagStartI, span)，
    // 待该帧 EOF 收尾时倒序发出，复刻 replay 顺序（emittedErrorKeys 去重）。
    if (
      frame.degradeRescan &&
      (closerInfo === null || closerInfo.closer === endTag) &&
      isInlineCapable(info.tag) &&
      inlineIsPlainDangling(info.argStart, frame.depth + 1, frame.textEnd)
    ) {
      (frame.degradeTailErr ??= []).push(i, info.argStart - info.tagOpenPos);
      flushBuffer(frame);
      appendBuf(frame, i, info.argStart);
      frame.i = info.argStart;
      return true;
    }

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
    // 与 tryCloseFullInlineFrame 里的 raw 路径不同之处：
    // 这里 args 还未解析，需要推 rawArgs 子帧；completeChild 负责最终组装。
    if (closerInfo.closer === rawClose) {
      const contentStart = closerInfo.argClose + syntax.rawOpen.length;
      const closeStart = findRawCloseCached(contentStart);

      if (closeStart === -1) {
        emitCloseNotFoundError(frameText, contentStart, i, syntax.rawClose, "RAW_CLOSE_MALFORMED", "RAW_NOT_CLOSED");
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
    // 同 raw，args 未解析，先推 blockArgs 子帧；completeChild 续推 blockContent。
    const contentStart = closerInfo.argClose + syntax.blockOpen.length;
    const closeStart = findBlockCloseCached(contentStart);

    if (closeStart === -1) {
      emitCloseNotFoundError(frameText, contentStart, i, syntax.blockClose, "BLOCK_CLOSE_MALFORMED", "BLOCK_NOT_CLOSED");
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

    // 单遍退化收集的未闭合 inline 错误：倒序发出（innermost-first），复刻原 replay 顺序。
    const tailErr = frame.degradeTailErr;
    if (tailErr !== null) {
      for (let k = tailErr.length - 2; k >= 0; k -= 2) {
        emitError(tracker, onError, "INLINE_NOT_CLOSED", frame.text, tailErr[k], tailErr[k + 1], emittedErrorKeys);
      }
      frame.degradeTailErr = null;
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
