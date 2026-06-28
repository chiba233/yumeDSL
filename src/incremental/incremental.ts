import { DEFAULT_TAG_NAME, isWholeLineToken } from "../config/chars.js";
import { createSyntax } from "../config/syntax.js";
import { buildPositionTracker } from "../internal/positions.js";
import { buildZonesInternal, SOFT_ZONE_NODE_CAP } from "../internal/zones.js";
import type {
  IncrementalDocument,
  IncrementalDiffRefinementOptions,
  IncrementalEdit,
  IncrementalParseOptions,
  IncrementalSession,
  IncrementalSessionApplyResult,
  IncrementalSessionApplyWithDiffResult,
  IncrementalSessionFallbackReason,
  IncrementalSessionOptions,
  IncrementalSessionStrategy,
  IncrementalUpdateError,
  IncrementalUpdateErrorCode,
  IncrementalUpdateResult,
  PositionTracker,
  StructuralNode,
  TokenDiffResult,
  Zone,
} from "../types";
import {
  buildConservativeTokenDiff,
  computeTokenDiff,
  computeTokenDiffWithinSourceWindow,
  DEFAULT_DIFF_MAX_ANCHOR_CANDIDATES,
  DEFAULT_DIFF_MAX_COMPARED_NODES,
  DEFAULT_DIFF_MAX_MILLISECONDS,
  DEFAULT_DIFF_MAX_OPS,
  DEFAULT_DIFF_MAX_SUBTREE_NODES,
  MAX_FULL_FALLBACK_DIFF_REFINEMENT_SOURCE_LENGTH,
  normalizeDiffRefinementDepthCap,
} from "./diff.js";
import {
  getCachedOptionsFingerprint,
  hasUnsafeZoneCoverageTailGap,
  LEFT_LOOKBEHIND_ZONES,
  mapOldOffsetToNew,
  normalizeSoftZoneNodeCap,
  parseIncrementalInternal,
  parseWithPositions,
  setCachedOptionsFingerprint,
  zoneSignature,
} from "./document.js";
import { deferShiftZone, getRawZones, installLazyDocument } from "./lazy.js";
import { buildParseOptionsFingerprint, cloneParseOptions } from "./options.js";

// ═══════════════════════════════════════════════════════════════
// incremental.ts — 增量解析器入口 / 编排层
//
// 核心思路：
// 把文档拆成 zone（连续节点分组），编辑只影响脏区间，
// 左侧 zone 原封不动，右侧 zone 用 lazy delta 平移，中间重解析。
// 整个更新路径不产出中间 AST，最终拼接出新快照。
//
// 硬规则：
// - snapshot clone 不能省——用户 options 可能在外部继续被改
// - fingerprint 只负责判断"配置有没有变"，不能替代 snapshot clone
// - 右侧复用必须过 seam probe，不能盲信 offset 对齐
// - diff refinement 失败不能影响 session 推进，必须保守兜底
// - 预算守卫一旦认定"不划算"，就要果断 full rebuild，不能继续赌增量
//
// 文件导航（按职责拆分）：
// - options.ts    快照克隆 / parseOptions fingerprint
// - document.ts   parseWithPositions / 签名缓存 / seam probe / full parse
// - diff.ts       token diff / structural diff / conservative fallback
// - lazy.ts       右侧 zone lazy delta 平移 / doc.tree,zones 惰性物化
// - incremental.ts 更新编排 / tryUpdate / session 自适应策略
// ═══════════════════════════════════════════════════════════════

// 性能备忘：
// 只重解析脏区间。右侧 zone 用 lazy delta——只存 offset 偏移量，
// 节点 position 延迟到消费者读 tree/zones 时才物化。
// 连续头部编辑自动叠加 delta，不触发中间深拷贝。
// 物化后的文档是纯数据对象，没有 Proxy 语义。

type IncrementalDebugStats = {
  cumulativeReparsedBytes: number;
  probeSliceBytes: number;
  fellBackToFull: boolean;
  wastedPreWorkMs: number;
};

type IncrementalDebugSink = (stats: IncrementalDebugStats) => void;
type InternalUpdateMode = "incremental" | "internal-full-rebuild";
type InternalDiffSourceWindow = {
  oldRange: { startOffset: number; endOffset: number };
  newRange: { startOffset: number; endOffset: number };
};
type InternalUpdateTelemetry = {
  mode: InternalUpdateMode;
  diffSourceWindow?: InternalDiffSourceWindow;
};
type InternalUpdateObserver = (telemetry: InternalUpdateTelemetry) => void;

let incrementalDebugSink: IncrementalDebugSink | undefined;

/**
 * Test-only hook for collecting incremental-update telemetry.
 *
 * Production code should not rely on this API; it exists so regression tests
 * can assert fallback behavior and wasted pre-work characteristics.
 */
export const __setIncrementalDebugSink: (sink?: IncrementalDebugSink) => void = (sink) => {
  incrementalDebugSink = sink;
};

// ── 错误工具 ──
const createIncrementalEditError = (
  code: IncrementalUpdateErrorCode,
  message: string,
): IncrementalUpdateError =>
  // code 不是装饰字段，而是 session fallbackReason 的输入。
  // 没有它，上层只能把所有失败都当成同一类未知异常。
  Object.assign(new Error(message), { code });

const isIncrementalUpdateErrorCode = (code: string): code is IncrementalUpdateErrorCode =>
  code === "INVALID_EDIT_RANGE" ||
  code === "NEW_SOURCE_LENGTH_MISMATCH" ||
  code === "EDIT_TEXT_MISMATCH" ||
  code === "UNKNOWN";

const isIncrementalUpdateError = (error: unknown): error is IncrementalUpdateError => {
  if (!(error instanceof Error)) return false;
  if (!("code" in error) || typeof error.code !== "string") return false;
  return isIncrementalUpdateErrorCode(error.code);
};

// ── 增量更新核心（编排层）──

// 找脏 zone 区间：哪些 zone 与编辑范围重叠？
// 有重叠 → [firstOverlap - 1, lastOverlap + 1]（左右各扩一格）
// 纯插入无重叠 → 从插入点邻居开始，左回看一格
const findDirtyRange = (zones: readonly Zone[], edit: IncrementalEdit): { from: number; to: number } => {
  // 左边只 lookbehind 一个 zone，是刻意保守但有限的折中。
  // 再继续往左扩，确实能覆盖更多极端边界，但会让普通编辑的脏窗长期偏大。
  let firstOverlap = -1;
  let lastOverlap = -1;
  let insertionIndex = zones.length;
  let insertionFound = false;

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (zone.endOffset > edit.startOffset && zone.startOffset < edit.oldEndOffset) {
      if (firstOverlap === -1) firstOverlap = i;
      lastOverlap = i;
    }
    if (!insertionFound && zone.startOffset >= edit.startOffset) {
      insertionIndex = i;
      insertionFound = true;
    }
  }

  if (firstOverlap !== -1) {
    return {
      from: Math.max(0, firstOverlap - LEFT_LOOKBEHIND_ZONES),
      to: Math.min(zones.length - 1, lastOverlap + 1),
    };
  }

  return {
    from: Math.max(0, insertionIndex - LEFT_LOOKBEHIND_ZONES),
    to: Math.min(zones.length - 1, insertionIndex),
  };
};

// ── 签名驱动的右侧重收敛（approach C）──
//
// 旧实现"孤立切片重解析 + seam probe 盲信 offset 对齐"在三处不 sound：
//   1. 切片右界把无界前向扫描（raw/block/inline close）截断，被强行闭合；
//   2. seam probe 从右侧重新起解析，看不到从脏区右溢的构造；
//   3. 文末插入被 mapOldOffsetToNew 映回插入前，窗口漏掉新增文本。
//
// 重收敛把这些统一掉：从一个**可证明干净的左锚点**连续解析，向右扩窗，
// 直到新解析出的某个 zone 与旧右侧 zone 在
//   「同一新坐标 offset 边界 + 同一签名 + 同一节点数」
// 上重收敛——只从该点起复用旧 zone。
//
// 为什么 sound：
// - 左锚点 Lnew = prevZones[from].startOffset 严格位于编辑左侧（findDirtyRange
//   左回看 1 个 zone 保证 from 不与编辑重叠），故 [0, Lnew) 与旧源逐字节相同，
//   且 Lnew 是旧解析的顶层 zone 边界（无构造跨越它）。任何起于 [0,Lnew) 的构造
//   其闭合扫描都止于 Lnew 之前（否则跨越 Lnew，与"干净边界"矛盾），所以新解析
//   在 Lnew 处状态 == 全量解析状态 == 干净顶层。从 Lnew 连续解析即复刻全量在
//   [Lnew, …) 的行为，**包含任何从脏区右溢的构造**。
//   （注：isLineStart 仅在 raw/block close 检测里用到——见 chars.ts——切片
//    pos 0 的伪行首对干净顶层起点无影响；右界截断产生的伪闭合都落在 seam 右侧，
//    被"无 zone 恰好起于 seam"或"候选非末尾 zone"挡掉。）
// - 重收敛点 seamNew：要求存在一个**非截断**的新 zone 恰好起于 seamNew
//   （窗口已越过它，故它不是被右界强行闭合的产物），且签名/节点数与旧 zone 一致。
//   此时 [seamNew, EOF) 源未变且起始干净 → 旧 zone [s..] 必与全量一致，可安全复用。
// - 文本/构造跨越 seamNew（如全量会把脏区尾 text 与右侧 text 合并成一个节点，
//   或脏区构造右溢吞掉右侧）→ 不会有 zone 恰好起于 seamNew → 不收敛 → 继续右扩，
//   脏窗自然吸收，直到真正的干净边界或文末（= 全量，可接受）。
//
// 窗口按倍增扩展；cumulative 重解析字节超预算 → 放弃增量，调用方 full rebuild，
// 保证最坏情形不退化成反复扩窗的 O(n²)。
const RECONVERGE_INITIAL_EXTRA_ZONES = 2;

type ReconvergeOutcome = {
  budgetExceeded: boolean;
  dirtyZones: Zone[];
  // 旧右侧 zone 的复用起点索引；== prevZones.length 表示右侧全部并入脏窗（无复用）。
  reuseFromIndex: number;
  cumulativeReparsedBytes: number;
  probeSliceBytes: number;
};

// ── zone 子树最远读取偏移（overhang 探测）──
//
// 解析器会产出"子节点延伸到父节点 position.end 之外"的退化结构——典型是 args 配平
// 扫描失败时，block/inline 的 arg 退化成一个延伸到很远（甚至越过该构造自身闭合点、
// 越过后续若干顶层节点）的 text 节点。例如：
//   "$$info($$c()%)*\n*end$$\n$$math()%\nnest\n%end$$"
//   → block info 节点是 [0,22]，但它的 arg text 却是 [7,44]（盖住了后面的 raw math）。
// 此时若编辑落在 [22,44) 区间（在 block 之外、却在它的 arg 覆盖范围内），被复用的左侧
// block 节点其 arg 文本值会失真——这类"非结构 token 变化"骨架比对抓不到。
//
// 因此对被复用左侧再加一道闸：任一左侧 zone 的子树最远读取偏移越过编辑起点 → 不 sound
// → 回退全量。maxEnd 按 zone 缓存；良构文档里 maxEnd == zone.endOffset（无 overhang），
// 左侧 endOffset 又都 ≤ 编辑起点，故该闸恒不触发，几乎零成本。
const zoneMaxEndCache = new WeakMap<Zone, number>();

// 子树最远读取偏移（含全部后代）。overhang 只来自 raw/block 的 args 在 tag-head 阶段用
// 独立 findTagArgClose 解析、失败后退化成越界文本；但它可藏在任意深度的**子节点**的 args 里
// （如 block 的 child inline 的 arg 越界，盖过 block 自身闭合点），故必须遍历整棵子树，
// 不能只走 args 链。用**显式栈**（非递归），深嵌套不爆调用栈；结果按 zone 缓存，与既有的
// zoneSignature 同量级（且 5000 万层单构造 = 单 zone → prevZones.length≤1 → 提前 full
// rebuild，根本不会走到这里）。
const subtreeMaxEnd = (node: StructuralNode): number => {
  let max = node.position?.end.offset ?? 0;
  const stack: StructuralNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) break;
    const end = n.position?.end.offset;
    if (end !== undefined && end > max) max = end;
    if (n.type === "inline" || n.type === "block") {
      for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]);
    }
    if (n.type === "raw" || n.type === "block") {
      for (let i = 0; i < n.args.length; i++) stack.push(n.args[i]);
    }
  }
  return max;
};

const zoneMaxEndOffset = (zone: Zone): number => {
  const cached = zoneMaxEndCache.get(zone);
  if (cached !== undefined) return cached;
  let max = zone.endOffset;
  for (let i = 0; i < zone.nodes.length; i++) {
    const m = subtreeMaxEnd(zone.nodes[i]);
    if (m > max) max = m;
  }
  zoneMaxEndCache.set(zone, max);
  return max;
};

// 新解析出的 zone 是否与旧 zone 在新坐标系下重收敛：
// 同一 offset 跨度（+delta）+ 同一节点数 + 同一结构签名（位置无关，已缓存）。
const zoneReconverges = (treeZone: Zone, oldZone: Zone, delta: number): boolean => {
  if (treeZone.startOffset !== oldZone.startOffset + delta) return false;
  if (treeZone.endOffset !== oldZone.endOffset + delta) return false;
  if (treeZone.nodes.length !== oldZone.nodes.length) return false;
  const oldSig = zoneSignature(oldZone);
  if (oldSig === undefined) return false;
  const newSig = zoneSignature(treeZone);
  if (newSig === undefined) return false;
  return oldSig === newSig;
};

// ── 悬空开标记探测（解析非前缀单调性的关键防护）──
//
// 解析器对未闭合构造的处理**不是前缀单调**的：`$$b(` 是否成为构造，取决于
// 右侧（可能在窗口之外）是否出现匹配的闭合。例如
//   parse("$$b($$code()%\n%end$$")        => [text "$$b(", raw code]
//   parse("$$b($$code()%\n%end$$\n)*")    => [text "$$b($$code()%\n%end$$\n)*"]   ← 整体塌成文本
// 即在窗口末尾追加内容会**回溯改变**窗口前部的节点。若脏窗里残留一个未在窗口内
// 闭合的开标记（降级成了文本里的 "$$<tag>("），那么基于该截断窗口找到的任何
// 右侧重收敛点都不可信——继续扩窗到 EOF 才能确定它的最终归属。
//
// 因此：脏窗提交前缀里若存在悬空开标记，则该 seam 无效，必须继续扩窗（最终 EOF
// 时该开标记降级定型，reuse-nothing 的脏窗即正确全量）。
type StrayTokenScanner = (value: string) => boolean;

const makeStrayOpenScanner = (
  parseOptions: IncrementalParseOptions | undefined,
): StrayTokenScanner => {
  const syntax = createSyntax(parseOptions?.syntax);
  const tagPrefix = syntax.tagPrefix;
  const tagOpen = syntax.tagOpen;
  const tagName = parseOptions?.tagName ?? DEFAULT_TAG_NAME;
  const isStart = tagName.isTagStartChar ?? DEFAULT_TAG_NAME.isTagStartChar;
  const isChar = tagName.isTagChar ?? DEFAULT_TAG_NAME.isTagChar;
  // 文本里是否含一个完整开头 `tagPrefix <tagStartChar><tagChar>* tagOpen`。
  return (value: string): boolean => {
    let idx = value.indexOf(tagPrefix);
    while (idx !== -1) {
      let j = idx + tagPrefix.length;
      if (j < value.length && isStart(value[j])) {
        j++;
        while (j < value.length && isChar(value[j])) j++;
        if (value.startsWith(tagOpen, j)) return true;
      }
      idx = value.indexOf(tagPrefix, idx + 1);
    }
    return false;
  };
};

// 脏窗提交前缀 treeZones[0, end) 里是否有悬空开标记——必须**递归**扫到嵌套文本。
// 退化的开标记可能落在某个构造的子节点文本里，例如在 inline 内容里 "$$info()*…" 整段
// 降级成了一个 text 子节点（含 "$$info("），而它在全量解析里（配上 EOF 的整行 *end$$）
// 会变成一个吞噬一切的 block——只看顶层文本会漏掉它，导致基于截断窗口的假重收敛。
const nodeHasStrayOpenDeep = (node: StructuralNode, hasStrayOpen: StrayTokenScanner): boolean => {
  const stack: StructuralNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) break;
    if (n.type === "text") {
      if (hasStrayOpen(n.value)) return true;
      continue;
    }
    if (n.type === "inline" || n.type === "block") {
      for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]);
    }
    if (n.type === "raw" || n.type === "block") {
      for (let i = 0; i < n.args.length; i++) stack.push(n.args[i]);
    }
  }
  return false;
};

const treeZonesPrefixHasStrayOpen = (
  treeZones: readonly Zone[],
  end: number,
  hasStrayOpen: StrayTokenScanner,
): boolean => {
  for (let z = 0; z < end; z++) {
    const nodes = treeZones[z].nodes;
    for (let i = 0; i < nodes.length; i++) {
      if (nodeHasStrayOpenDeep(nodes[i], hasStrayOpen)) return true;
    }
  }
  return false;
};

// 提交前缀 treeZones[0,end) 的结构签名组合（位置无关），用于候选跨窗口稳定性确认。
const combinePrefixSignature = (treeZones: readonly Zone[], end: number): number => {
  let sig = Math.imul(end + 1, 2654435761) >>> 0;
  for (let i = 0; i < end; i++) {
    const zs = zoneSignature(treeZones[i]) ?? 0;
    sig = Math.imul(sig ^ zs, 2654435761) >>> 0;
  }
  return sig;
};

const reconvergeDirtyWindow = (
  prevZones: readonly Zone[],
  dirtyFrom: number,
  dirtyTo: number,
  edit: IncrementalEdit,
  delta: number,
  newSource: string,
  tracker: PositionTracker,
  parseOptions: IncrementalParseOptions | undefined,
  cumulativeBudget: number,
  zoneCap: number,
  hasStrayOpen: StrayTokenScanner,
): ReconvergeOutcome => {
  const lastIndex = prevZones.length - 1;
  const dirtyStartNew = mapOldOffsetToNew(edit, delta, prevZones[dirtyFrom].startOffset);
  let cumulativeReparsedBytes = 0;
  let probeSliceBytes = 0;

  // 窗口右界用"旧 zone 索引"表示，从 dirtyTo 起按倍增扩展。
  let windowToIdx = Math.min(lastIndex, dirtyTo + RECONVERGE_INITIAL_EXTRA_ZONES);
  // 候选确认：解析器存在"窗口大小相关"的非单调退化——同一前缀在 [anchor,W) 解析成一种结构、
  // 在 [anchor,2W) 又变（典型是 raw 的 arg 因括号/整行扫描越窗而被误解析成一个 block）。
  // 因此一个候选必须在**两次连续倍增窗口**里给出完全一致的前缀（同 seam + 同前缀签名）
  // 才接受；到达 EOF 时窗口即真解析，可直接接受。
  let pendingSeam = -1;
  let pendingPrefixSig = 0;

  while (true) {
    const reachedEof = windowToIdx >= lastIndex;
    // 到达最后一个 zone 时，窗口右界必须落在新源 EOF：
    // mapOldOffsetToNew 会把文末插入点映回插入前，直接用映射会漏掉新增文本。
    const windowEndNew = reachedEof
      ? newSource.length
      : mapOldOffsetToNew(edit, delta, prevZones[windowToIdx].endOffset);

    cumulativeReparsedBytes += windowEndNew - dirtyStartNew;
    if (cumulativeReparsedBytes > cumulativeBudget) {
      return {
        budgetExceeded: true,
        dirtyZones: [],
        reuseFromIndex: prevZones.length,
        cumulativeReparsedBytes,
        probeSliceBytes,
      };
    }

    const tree = parseWithPositions(
      newSource.slice(dirtyStartNew, windowEndNew),
      tracker,
      parseOptions,
      dirtyStartNew,
    );
    const treeZones = buildZonesInternal(tree, zoneCap);

    // 在 (dirtyTo, windowToIdx] 内找最小可复用起点 s。
    // treeZones 按 startOffset 升序，游标单调推进。
    let foundSeam = -1;
    let foundCursor = -1;
    let treeZoneCursor = 0;
    for (let s = dirtyTo + 1; s <= windowToIdx; s++) {
      const seamNew = mapOldOffsetToNew(edit, delta, prevZones[s].startOffset);
      while (treeZoneCursor < treeZones.length && treeZones[treeZoneCursor].startOffset < seamNew) {
        treeZoneCursor++;
      }
      if (treeZoneCursor >= treeZones.length) break; // seam 超出已解析内容
      const candidate = treeZones[treeZoneCursor];
      // 没有 zone 恰好起于 seam → 有节点跨越它（被吞并/合并）→ 此处不收敛。
      if (candidate.startOffset !== seamNew) continue;
      // 截断防护：候选不能是被窗口右界强行闭合的末尾 zone。
      // 窗口已到 EOF 时末尾 zone 也是真实的；否则要求其后还有 zone。
      const candidateIsGenuine = treeZoneCursor < treeZones.length - 1 || reachedEof;
      if (!candidateIsGenuine) break; // 需更大窗口确认 → 跳出去倍增扩窗
      if (!zoneReconverges(candidate, prevZones[s], delta)) continue;
      // 提交前缀里若残留悬空开标记（递归扫到嵌套文本）→ 有构造越过 seam 退化 → 不可信。
      // 这类（如 inline 内 "$$info()*…" 整段降级成 text 子节点、配 EOF 整行闭合会变 block）
      // 截断窗口里看似闭合，唯递归悬空开标记能逼现 → 放弃所有 seam，扩窗。
      if (treeZonesPrefixHasStrayOpen(treeZones, treeZoneCursor, hasStrayOpen)) break;
      foundSeam = s;
      foundCursor = treeZoneCursor;
      break;
    }

    if (foundSeam !== -1) {
      const prefixSig = combinePrefixSignature(treeZones, foundCursor);
      // EOF 窗口即真解析，直接接受；否则需与上一轮倍增窗口的前缀一致方可接受。
      if (reachedEof || (foundSeam === pendingSeam && prefixSig === pendingPrefixSig)) {
        const seamNew = mapOldOffsetToNew(edit, delta, prevZones[foundSeam].startOffset);
        probeSliceBytes = windowEndNew - seamNew;
        return {
          budgetExceeded: false,
          dirtyZones: treeZones.slice(0, foundCursor),
          reuseFromIndex: foundSeam,
          cumulativeReparsedBytes,
          probeSliceBytes,
        };
      }
      pendingSeam = foundSeam;
      pendingPrefixSig = prefixSig;
    } else {
      pendingSeam = -1;
    }

    if (reachedEof) {
      // 解析到文末仍未重收敛 → 右侧全部并入脏窗，无复用。
      return {
        budgetExceeded: false,
        dirtyZones: treeZones,
        reuseFromIndex: prevZones.length,
        cumulativeReparsedBytes,
        probeSliceBytes,
      };
    }
    const extra = windowToIdx - dirtyTo;
    windowToIdx = Math.min(lastIndex, dirtyTo + extra * 2);
  }
};

// ── 左边界合并探测 ──
//
// 起于被复用左侧 [0, from) 的任意前向扫描——findTagArgClose 的括号配平、lazy-inline
// 找 )$$、findRawClose/findBlockClose 找整行闭合——其结果**只取决于其右侧的
// 「结构 token 序列」**（普通字符只是 pos++，不影响判定）。而 findTagArgClose 一路扫到
// EOF（见 scanner.ts，无界），所以左侧构造的前瞻可以跨越编辑、且其"读取范围"在解析树里
// 完全不可见（如 "$$b(" 括号不配平时前瞻到 EOF 失败、回退成 inline，节点看上去却很正常）。
//
// 关键不变量：编辑左侧 [0, from) 与编辑右侧（复用右侧 / 编辑之外）的源码都未变；
// 因此只要**脏区内的结构 token 骨架未被本次编辑改变**，任一左侧扫描看到的 token 序列
// 就完全相同 → 解析结果相同 → 复用左侧 sound。反之骨架若变 → 左侧扫描结果可能变 →
// 回退全量。纯文本编辑（不碰任何结构 token）→ 骨架不变 → 走增量。from === 0 时无左侧可复用，免检。
//
// 骨架 = 脏区源码里所有结构 token 的有序标记串。token 集合覆盖各扫描所关心的一切：
// escapeChar / tagPrefix / tagOpen / tagClose / endTag / rawOpen / blockOpen /
// 整行 rawClose / 整行 blockClose。匹配按"先转义、再整行闭合、再带 tagClose 前缀的复合
// token、最后单字符 token"的优先级，避免前缀歧义。转义后跳过紧邻 1 个字符（保守：宁可
// 多发标记/多回退，也不漏标记——漏标记才会不 sound）。
type SkeletonTokens = {
  escapeChar: string;
  tagPrefix: string;
  tagOpen: string;
  tagClose: string;
  tagDivider: string;
  endTag: string;
  rawOpen: string;
  blockOpen: string;
  rawClose: string;
  blockClose: string;
  isStart: (c: string) => boolean;
  isChar: (c: string) => boolean;
};

const makeSkeletonTokens = (parseOptions: IncrementalParseOptions | undefined): SkeletonTokens => {
  const s = createSyntax(parseOptions?.syntax);
  const tagName = parseOptions?.tagName ?? DEFAULT_TAG_NAME;
  return {
    escapeChar: s.escapeChar,
    tagPrefix: s.tagPrefix,
    tagOpen: s.tagOpen,
    tagClose: s.tagClose,
    tagDivider: s.tagDivider,
    endTag: s.endTag,
    rawOpen: s.rawOpen,
    blockOpen: s.blockOpen,
    rawClose: s.rawClose,
    blockClose: s.blockClose,
    isStart: tagName.isTagStartChar ?? DEFAULT_TAG_NAME.isTagStartChar,
    isChar: tagName.isTagChar ?? DEFAULT_TAG_NAME.isTagChar,
  };
};

const structuralSkeleton = (
  src: string,
  start: number,
  end: number,
  tk: SkeletonTokens,
): string => {
  let out = "";
  let pos = start;
  while (pos < end) {
    if (tk.escapeChar.length > 0 && src.startsWith(tk.escapeChar, pos)) {
      // 只发 'E' 标记、**不跳过**后续字符：解析器的转义是上下文/特定 token 相关的
      // （例如顶层 "\$$b(" 里 "\" 其实是文本、"$$b(" 仍是有效开标记），手写跳过会漏标记
      // 而漏标记会不 sound。让后续 token 照常被标记（最坏多发标记/多回退一次，仍 sound）。
      out += "E";
      pos += tk.escapeChar.length;
      continue;
    }
    if (isWholeLineToken(src, pos, tk.rawClose)) {
      out += "R";
      pos += tk.rawClose.length;
      continue;
    }
    if (isWholeLineToken(src, pos, tk.blockClose)) {
      out += "K";
      pos += tk.blockClose.length;
      continue;
    }
    if (src.startsWith(tk.endTag, pos)) {
      out += "T";
      pos += tk.endTag.length;
      continue;
    }
    if (src.startsWith(tk.rawOpen, pos)) {
      out += "r";
      pos += tk.rawOpen.length;
      continue;
    }
    if (src.startsWith(tk.blockOpen, pos)) {
      out += "k";
      pos += tk.blockOpen.length;
      continue;
    }
    if (src.startsWith(tk.tagPrefix, pos)) {
      // 有效开标记 $$<validtag>( → 'A'（不含 tag 名，名字变化不改变左侧扫描行为）；
      // 裸 $$（不构成有效开）→ 'P'。两种都**只前进 1**：解析器对 tagPrefix 的搜索是逐位
      // 重叠的，前进 2 会把落在奇数位的有效开（如 "$$$b(" 里的 "$$b("）漏掉。
      // 裸 $$ 也必须发 'P'：成串的 $$ 会左右错位地影响 $$tag( 的配对/降级（如删掉
      // "$$$$n(" 里多余的 $$ 仍得到 "$$n("，但前者多出的 $$ 会改变更远处的解析），
      // 不发标记就会漏判。
      let j = pos + tk.tagPrefix.length;
      if (j < end && tk.isStart(src[j])) {
        j++;
        while (j < end && tk.isChar(src[j])) j++;
        if (src.startsWith(tk.tagOpen, j)) {
          out += "A"; // 有效开标记 $$tag（不含 tagOpen，下轮把 tagOpen 计为 O）
          pos = j;
          continue;
        }
      }
      out += "P";
      pos += 1;
      continue;
    }
    if (src.startsWith(tk.tagOpen, pos)) {
      out += "O";
      pos += tk.tagOpen.length;
      continue;
    }
    if (src.startsWith(tk.tagClose, pos)) {
      out += "C";
      pos += tk.tagClose.length;
      continue;
    }
    if (tk.tagDivider.length > 0 && src.startsWith(tk.tagDivider, pos)) {
      out += "D"; // tagDivider：影响 args 切分 / 左侧构造内容扫描，必须计入。
      pos += tk.tagDivider.length;
      continue;
    }
    pos += 1;
  }
  return out;
};

// 编辑合法性三重校验：
// 1. offset 范围合法（不越界、不倒序）
// 2. newSource 长度 = 旧长度 - 删除长度 + 插入长度
// 3. edit.newText 与 newSource 对应位置一致（防调用方传错）
const assertValidEdit = (doc: IncrementalDocument, edit: IncrementalEdit, newSource: string) => {
  if (edit.startOffset < 0 || edit.oldEndOffset < edit.startOffset || edit.oldEndOffset > doc.source.length) {
    throw createIncrementalEditError(
      "INVALID_EDIT_RANGE",
      "updateIncremental(): invalid edit range.",
    );
  }

  const expectedLength =
    doc.source.length - (edit.oldEndOffset - edit.startOffset) + edit.newText.length;
  if (expectedLength !== newSource.length) {
    throw createIncrementalEditError(
      "NEW_SOURCE_LENGTH_MISMATCH",
      "updateIncremental(): newSource length does not match edit delta from previous source.",
    );
  }

  const insertedText = newSource.slice(edit.startOffset, edit.startOffset + edit.newText.length);
  if (insertedText !== edit.newText) {
    throw createIncrementalEditError(
      "EDIT_TEXT_MISMATCH",
      "updateIncremental(): edit.newText does not match newSource at startOffset.",
    );
  }
};

// ── Public API: 全量解析入口 ──
/**
 * Build the initial incremental document snapshot from full source.
 *
 * Use this low-level API when you want to manage snapshots manually. For
 * correctness-first editing workflows, prefer `createIncrementalSession()`.
 */
export const parseIncremental = (
  source: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => parseIncrementalInternal(source, options, SOFT_ZONE_NODE_CAP);

// 增量更新主流程：
// 1. assertValidEdit       — 编辑合法性校验
// 2. fingerprint 比对       — 配置变了？→ full rebuild
// 3. findDirtyRange        — 找脏 zone 区间
// 4. reparseDirtyWindow    — 循环重解析直到右边界稳定（有预算守卫）
// 5. isSafeRightReuse      — seam probe 验证拼接缝
// 6. deferShiftZone        — 右侧 zone lazy delta 平移
// 7. installLazyDocument   — 拼接新快照，挂 lazy getter
//
// 任何一步判定"不安全" → fullRebuild() 兜底，保证正确性优先。
const updateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options: IncrementalParseOptions | undefined,
  internalObserver: InternalUpdateObserver | undefined,
  zoneCap: number,
): IncrementalDocument => {
  // 低层 API 先验证调用契约，不在这里偷偷修正非法输入。
  assertValidEdit(doc, edit, newSource);
  let cumulativeReparsedBytes = 0;
  let probeSliceBytes = 0;
  const preWorkStart = incrementalDebugSink ? performance.now() : 0;

  const previousOptionsFingerprint =
    getCachedOptionsFingerprint(doc) ?? buildParseOptionsFingerprint(doc.parseOptions);
  const nextOptionsFingerprint = options
    ? buildParseOptionsFingerprint(options)
    : previousOptionsFingerprint;
  const runtimeParseOptions = options ?? doc.parseOptions;
  // nextParseOptionsSnapshot 延后到确定走增量路径后再算，
  // 避免 fullRebuild 路径白做一次 cloneParseOptions。
  // 判断阶段可以先看 runtimeParseOptions，但真正写回文档的必须是隔离后的 snapshot。

  const emitDebug = (fellBackToFull: boolean) => {
    const wastedPreWorkMs = fellBackToFull && incrementalDebugSink
      ? performance.now() - preWorkStart
      : 0;
    incrementalDebugSink?.({
      cumulativeReparsedBytes,
      probeSliceBytes,
      fellBackToFull,
      wastedPreWorkMs,
    });
  };

  // early full-rebuild 路径：尚未构建 tracker，无需透传。
  const earlyFullRebuild = (): IncrementalDocument => {
    emitDebug(true);
    const rebuilt = parseIncrementalInternal(newSource, runtimeParseOptions, zoneCap);
    internalObserver?.({ mode: "internal-full-rebuild" });
    return rebuilt;
  };

  const prevZones = getRawZones(doc);

  // 这些 early bailout 越早越划算：
  // 配置变了、zone 太少、zone 覆盖不可信时，再做脏窗分析只是在浪费前置工作。
  if (previousOptionsFingerprint !== nextOptionsFingerprint) return earlyFullRebuild();
  if (prevZones.length === 0) return earlyFullRebuild();
  // zone 太少（≤1）→ 没有足够的左/脏/右结构可复用，增量路径开销白费。
  // 典型场景：纯 text 文档（0 个 zone breaker、softCap 也切不出来），
  // 或极短文档。直接走 full rebuild 更快。
  if (prevZones.length <= 1) return earlyFullRebuild();
  if (hasUnsafeZoneCoverageTailGap(prevZones, edit)) return earlyFullRebuild();

  const newTracker = buildPositionTracker(newSource);

  // late full-rebuild：tracker 已构建，透传给 parseIncrementalInternal 复用。
  const fullRebuild = (): IncrementalDocument => {
    emitDebug(true);
    const rebuilt = parseIncrementalInternal(newSource, runtimeParseOptions, zoneCap, newTracker);
    internalObserver?.({ mode: "internal-full-rebuild" });
    return rebuilt;
  };
  const cumulativeBudget = Math.max(newSource.length * 2, 1024);

  const delta = newSource.length - doc.source.length;
  const dirty = findDirtyRange(prevZones, edit);
  const hasStrayOpen = makeStrayOpenScanner(runtimeParseOptions);

  // 右侧重收敛：从干净左锚点连续解析、向右扩到与旧右侧 zone 重收敛。
  const from = dirty.from;

  // 左侧 overhang 闸：任一被复用左侧 zone 的子树最远读取越过编辑起点 → 其内容覆盖了
  // 被编辑区，复用即失真（见 zoneMaxEndOffset 上注）→ 回退全量。
  // （不能据「左侧看起来良构」就跳过此闸：args 配平失败后回退成闭合 inline 的构造在树里
  //  完全正常、其 args 扫描范围却已读到很远——读取范围在树里不可见，无法廉价甄别。）
  for (let i = 0; i < from; i++) {
    if (zoneMaxEndOffset(prevZones[i]) > edit.startOffset) return fullRebuild();
  }
  const reconv = reconvergeDirtyWindow(
    prevZones,
    from,
    dirty.to,
    edit,
    delta,
    newSource,
    newTracker,
    runtimeParseOptions,
    cumulativeBudget,
    zoneCap,
    hasStrayOpen,
  );
  cumulativeReparsedBytes += reconv.cumulativeReparsedBytes;
  probeSliceBytes = reconv.probeSliceBytes;
  // 超预算不表示结果错误，只表示"继续增量不值了"。
  // 这时马上 rebuild，能避免极端编辑把增量拖成反复扩窗。
  if (reconv.budgetExceeded || cumulativeReparsedBytes > cumulativeBudget) return fullRebuild();

  const dirtyZones = reconv.dirtyZones;
  const reuseFromIndex = reconv.reuseFromIndex;
  const oldRightZones = prevZones.slice(reuseFromIndex);

  // diff 窗口：脏区在新旧坐标系下的区间，供 session 的 token diff 作提示用。
  const dirtyOldStart = prevZones[from].startOffset;
  // reuseFromIndex - 1 是最后一个并入脏窗的旧 zone（reuse-nothing 时即末尾 zone）。
  const dirtyOldEnd = prevZones[Math.min(reuseFromIndex, prevZones.length) - 1].endOffset;
  const dirtyCommitEndNew =
    dirtyZones.length > 0
      ? dirtyZones[dirtyZones.length - 1].endOffset
      : mapOldOffsetToNew(edit, delta, dirtyOldStart);
  const diffSourceWindow: InternalDiffSourceWindow = {
    oldRange: { startOffset: dirtyOldStart, endOffset: dirtyOldEnd },
    newRange: {
      startOffset: mapOldOffsetToNew(edit, delta, dirtyOldStart),
      endOffset: dirtyCommitEndNew,
    },
  };

  // ── 左侧安全门：脏区结构 token 骨架比对（见 structuralSkeleton 上注）──
  // from === 0 时无被复用左侧，必然安全，免检。否则比对脏区在旧/新源码下的结构骨架：
  // 不变 → 任一左侧前向扫描看到的 token 序列不变（且脏区起首构造未因编辑降级而向左并入）
  //      → 复用左侧 sound；变了 → 回退全量。
  // 注：不能据「左侧看起来良构」就跳过——args 配平失败回退成闭合 inline 的左侧构造其扫描
  //     已读到脏区、却在树里完全正常（读取范围不可见），无法廉价甄别，故 from>0 一律比对。
  if (from > 0) {
    const skeletonTokens = makeSkeletonTokens(runtimeParseOptions);
    const oldSkeleton = structuralSkeleton(doc.source, dirtyOldStart, dirtyOldEnd, skeletonTokens);
    const newSkeleton = structuralSkeleton(
      newSource,
      mapOldOffsetToNew(edit, delta, dirtyOldStart),
      dirtyCommitEndNew,
      skeletonTokens,
    );
    if (oldSkeleton !== newSkeleton) return fullRebuild();
  }

  // 以左侧切片为基底直接增长成 nextRawZones：避免再单独建 rightZones 数组、再 spread 重拷一遍
  // （左、右各省一次 O(zones) 拷贝）。左侧 zone 严格在编辑点之前、偏移不变故原样保留；
  // deferShiftZone 仍逐个对旧右侧 zone 施加 lazy 位移，顺序与原 .map 一致。
  const nextRawZones = prevZones.slice(0, from);
  for (let k = 0; k < dirtyZones.length; k++) nextRawZones.push(dirtyZones[k]);
  for (let k = 0; k < oldRightZones.length; k++) {
    nextRawZones.push(deferShiftZone(oldRightZones[k], delta));
  }
  // 确定走增量路径，此时才 clone parseOptions（避免 fullRebuild 白做一次）。
  const nextParseOptionsSnapshot = options ? cloneParseOptions(options) : doc.parseOptions;

  const updated: IncrementalDocument = {
    source: newSource,
    zones: nextRawZones,
    tree: [],
    parseOptions: nextParseOptionsSnapshot,
  };
  installLazyDocument(updated, nextRawZones, newTracker);
  setCachedOptionsFingerprint(updated, nextOptionsFingerprint);

  emitDebug(false);
  internalObserver?.({ mode: "incremental", diffSourceWindow });
  return updated;
};

/**
 * Apply one edit to a previous incremental snapshot.
 *
 * This low-level API may throw on invalid edit contracts. Session-based callers
 * should prefer `createIncrementalSession().applyEdit(...)` for automatic
 * fallback behavior.
 */
export const updateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => updateIncrementalInternal(doc, edit, newSource, options, undefined, SOFT_ZONE_NODE_CAP);

// Result 风格的增量更新：不抛异常，返回 { ok, value } | { ok, error }。
// session 内部走这条路径，方便统一处理错误 → full rebuild 兜底。
const tryUpdateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options: IncrementalParseOptions | undefined,
  internalObserver: InternalUpdateObserver | undefined,
  zoneCap: number,
): IncrementalUpdateResult => {
  try {
    return {
      ok: true,
      value: updateIncrementalInternal(doc, edit, newSource, options, internalObserver, zoneCap),
    };
  } catch (error) {
    // 已知契约错误保持原样返回；只有未知异常才包成 UNKNOWN。
    // 不然 session 无法区分到底是调用方 edit 错了，还是内部实现出了问题。
    if (isIncrementalUpdateError(error)) {
      return {
        ok: false,
        error,
      };
    }
    return {
      ok: false,
      error: createIncrementalEditError(
        "UNKNOWN",
        `tryUpdateIncremental(): unexpected error: ${String(error)}`,
      ),
    };
  }
};

/**
 * Result-style variant of {@link updateIncremental}.
 *
 * Returns a discriminated `{ ok, value | error }` result instead of throwing,
 * which makes it convenient for session orchestration and host integrations.
 */
export const tryUpdateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalUpdateResult =>
  tryUpdateIncrementalInternal(doc, edit, newSource, options, undefined, SOFT_ZONE_NODE_CAP);

// ── Session（有状态会话 + 自适应策略）──
//
// createIncrementalSession 是生产级入口。它在 updateIncremental 外面包了一层：
// - 自动 full-rebuild 兜底（增量失败不会抛到调用方）
// - auto 策略：滑动窗口采样，如果增量频繁 fallback 或比 full 还慢 → 自动切 full 模式
// - cooldown 机制：切到 full 后连续 N 次编辑保持 full，避免反复抖动
/**
 * Create a stateful incremental parsing session with automatic fallback.
 *
 * The session reuses the previous snapshot when safe, tracks adaptive fallback
 * heuristics in `auto` mode, and can additionally emit structural diff payloads
 * through `applyEditWithDiff()`.
 */
export const createIncrementalSession = (
  source: string,
  options?: IncrementalParseOptions,
  sessionOptions?: IncrementalSessionOptions,
): IncrementalSession => {
  // session 层的第一目标永远是推进到正确的新快照。
  // 增量命中率、diff 精细度、性能优化都只能在这个前提下排队。
  const zoneCap = normalizeSoftZoneNodeCap(sessionOptions?.softZoneNodeCap);
  const sessionDiffOptions = sessionOptions?.diff;
  const defaultDiffRefinementOptions = {
    refinementDepthCap: normalizeDiffRefinementDepthCap(sessionDiffOptions?.refinementDepthCap),
    budgetOptions: {
      maxComparedNodes: sessionDiffOptions?.maxComparedNodes ?? DEFAULT_DIFF_MAX_COMPARED_NODES,
      maxAnchorCandidates: sessionDiffOptions?.maxAnchorCandidates ?? DEFAULT_DIFF_MAX_ANCHOR_CANDIDATES,
      maxOps: sessionDiffOptions?.maxOps ?? DEFAULT_DIFF_MAX_OPS,
      maxSubtreeNodes: sessionDiffOptions?.maxSubtreeNodes ?? DEFAULT_DIFF_MAX_SUBTREE_NODES,
      maxMilliseconds: sessionDiffOptions?.maxMilliseconds ?? DEFAULT_DIFF_MAX_MILLISECONDS,
    },
  };
  const resolveDiffRefinementOptions = (override?: IncrementalDiffRefinementOptions) => {
    if (!override) return defaultDiffRefinementOptions;
    return {
      refinementDepthCap:
        override.refinementDepthCap === undefined
          ? defaultDiffRefinementOptions.refinementDepthCap
          : normalizeDiffRefinementDepthCap(override.refinementDepthCap),
      budgetOptions: {
        maxComparedNodes:
          override.maxComparedNodes ?? defaultDiffRefinementOptions.budgetOptions.maxComparedNodes,
        maxAnchorCandidates:
          override.maxAnchorCandidates ?? defaultDiffRefinementOptions.budgetOptions.maxAnchorCandidates,
        maxOps: override.maxOps ?? defaultDiffRefinementOptions.budgetOptions.maxOps,
        maxSubtreeNodes:
          override.maxSubtreeNodes ?? defaultDiffRefinementOptions.budgetOptions.maxSubtreeNodes,
        maxMilliseconds:
          override.maxMilliseconds ?? defaultDiffRefinementOptions.budgetOptions.maxMilliseconds,
      },
    };
  };
  let currentDoc = parseIncrementalInternal(source, options, zoneCap);
  const strategy: IncrementalSessionStrategy = sessionOptions?.strategy ?? "auto";
  const sampleWindowSize = Math.max(4, sessionOptions?.sampleWindowSize ?? 24);
  const minSamplesForAdaptation = Math.max(2, sessionOptions?.minSamplesForAdaptation ?? 6);
  const maxFallbackRate = Math.min(1, Math.max(0, sessionOptions?.maxFallbackRate ?? 0.35));
  const switchToFullMultiplier = Math.max(1, sessionOptions?.switchToFullMultiplier ?? 1.1);
  const fullPreferenceCooldownEdits = Math.max(1, sessionOptions?.fullPreferenceCooldownEdits ?? 12);
  const maxEditRatioForIncremental = Math.min(
    1,
    Math.max(0, sessionOptions?.maxEditRatioForIncremental ?? 0.2),
  );

  const now: () => number =
    typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

  let preferFullMode = false;
  let cooldownRemaining = 0;
  const incrementalDurations: number[] = [];
  const fallbackMarks: number[] = [];
  const fullDurations: number[] = [];

  // 进入 full 偏好模式：清空增量采样，开始 cooldown 计数。
  const enterFullPreference = () => {
    preferFullMode = true;
    cooldownRemaining = fullPreferenceCooldownEdits;
    incrementalDurations.length = 0;
    fallbackMarks.length = 0;
  };

  // 有界滑动窗口：超过 sampleWindowSize 就丢最老的样本。
  const recordBounded = (bucket: number[], value: number) => {
    bucket.push(value);
    if (bucket.length > sampleWindowSize) {
      bucket.shift();
    }
  };

  const average = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      total += values[i];
    }
    return total / values.length;
  };

  const runRebuild = (
    nextSource: string,
    nextOptions: IncrementalParseOptions | undefined,
    fallbackReason: IncrementalSessionFallbackReason,
  ): IncrementalSessionApplyResult => {
    // rebuild 也要记样本；否则 auto 策略只知道增量多快，不知道 full 路径基线。
    const start = now();
    currentDoc = parseIncrementalInternal(nextSource, nextOptions ?? currentDoc.parseOptions, zoneCap);
    const elapsedMs = now() - start;
    recordBounded(fullDurations, elapsedMs);
    return {
      doc: currentDoc,
      mode: "full-fallback",
      fallbackReason,
    };
  };

  // 自适应策略决策：
  // 1. fallback 率超阈值 → 切 full
  // 2. 增量平均耗时 > full 平均耗时 × multiplier → 切 full
  // 只在 auto 模式下生效，且需要积攒够 minSamplesForAdaptation 个样本才开始判断。
  const maybeAdaptPolicy = () => {
    if (strategy !== "auto") return;
    const incrementalSampleCount = incrementalDurations.length;
    if (incrementalSampleCount < minSamplesForAdaptation) return;

    const fallbackRate = average(fallbackMarks);
    if (fallbackRate > maxFallbackRate) {
      // fallback 率过高说明当前文档/编辑模式不适合继续赌增量。
      enterFullPreference();
      return;
    }

    if (fullDurations.length < minSamplesForAdaptation) return;
    const avgIncrementalMs = average(incrementalDurations);
    const avgFullMs = average(fullDurations);
    if (avgIncrementalMs > avgFullMs * switchToFullMultiplier) {
      // 连平均耗时都输给 full rebuild 时，再坚持增量已经没有意义。
      enterFullPreference();
    }
  };

  const rebuild = (nextSource: string, nextOptions?: IncrementalParseOptions): IncrementalDocument => {
    currentDoc = parseIncrementalInternal(nextSource, nextOptions ?? currentDoc.parseOptions, zoneCap);
    return currentDoc;
  };

  const applyEditCore = (
    edit: IncrementalEdit,
    newSource: string,
    nextOptions?: IncrementalParseOptions,
  ): {
    previousDoc: IncrementalDocument;
    result: IncrementalSessionApplyResult;
    diffSourceWindow?: InternalDiffSourceWindow;
  } => {
    const previousDoc = currentDoc;
    let result: IncrementalSessionApplyResult;
    let diffSourceWindow: InternalDiffSourceWindow | undefined;
    if (strategy === "full-only") {
      result = runRebuild(newSource, nextOptions, "FULL_ONLY_STRATEGY");
      return { previousDoc, result };
    }

    const previousLength = Math.max(1, currentDoc.source.length);
    const replacedLength = Math.max(0, edit.oldEndOffset - edit.startOffset);
    const writtenLength = edit.newText.length;
    const editRatio = Math.max(replacedLength, writtenLength) / previousLength;

    if (strategy === "auto" && editRatio > maxEditRatioForIncremental) {
      // 大编辑不一定不正确，但通常没有可观复用收益，直接 rebuild 更稳。
      result = runRebuild(newSource, nextOptions, "AUTO_LARGE_EDIT");
      maybeAdaptPolicy();
      return { previousDoc, result };
    }

    if (strategy === "auto" && preferFullMode && cooldownRemaining > 0) {
      // cooldown 用来避免模式抖动：刚切 full 后，别下一次又立刻试探性切回增量。
      cooldownRemaining -= 1;
      if (cooldownRemaining === 0) {
        preferFullMode = false;
      }
      result = runRebuild(newSource, nextOptions, "AUTO_COOLDOWN");
      maybeAdaptPolicy();
      return { previousDoc, result };
    }

    const incrementalStart = now();
    let telemetry: InternalUpdateTelemetry | undefined;
    const updateResult = tryUpdateIncrementalInternal(
      currentDoc,
      edit,
      newSource,
      nextOptions,
      (nextTelemetry) => {
        telemetry = nextTelemetry;
      },
      zoneCap,
    );
    const incrementalElapsedMs = now() - incrementalStart;
    recordBounded(incrementalDurations, incrementalElapsedMs);

    if (updateResult.ok) {
      currentDoc = updateResult.value;
      const internalFullRebuild = telemetry?.mode === "internal-full-rebuild";
      recordBounded(fallbackMarks, internalFullRebuild ? 1 : 0);
      maybeAdaptPolicy();
      if (internalFullRebuild) {
        // 这类 fallback 和 runRebuild 不同：它说明增量流程已经跑起来了，但中途判定不安全。
        result = {
          doc: currentDoc,
          mode: "full-fallback",
          fallbackReason: "INTERNAL_FULL_REBUILD",
        };
        return { previousDoc, result };
      }
      diffSourceWindow = telemetry?.diffSourceWindow;
      result = {
        doc: currentDoc,
        mode: "incremental",
      };
      return { previousDoc, result, diffSourceWindow };
    }

    recordBounded(fallbackMarks, 1);
    result = runRebuild(newSource, nextOptions, updateResult.error.code);
    maybeAdaptPolicy();
    return { previousDoc, result };
  };

  // applyEdit：session 的编辑入口。决策流程：
  // 1. full-only 策略 → 直接 rebuild
  // 2. auto + 编辑比例过大 → rebuild（大编辑增量没意义）
  // 3. auto + cooldown 中 → rebuild（刚从增量切过来，保持稳定）
  // 4. 走增量路径 → tryUpdateIncrementalInternal
  //    4a. 成功 → 返回 incremental 或 internal-full-rebuild
  //    4b. 失败 → runRebuild 兜底
  // 每次都记录耗时采样 + 调用 maybeAdaptPolicy 更新策略。
  const applyEdit = (
    edit: IncrementalEdit,
    newSource: string,
    nextOptions?: IncrementalParseOptions,
  ): IncrementalSessionApplyResult => applyEditCore(edit, newSource, nextOptions).result;

  const applyEditWithDiff = (
    edit: IncrementalEdit,
    newSource: string,
    nextOptions?: IncrementalParseOptions,
    diffOptions?: IncrementalDiffRefinementOptions,
  ): IncrementalSessionApplyWithDiffResult => {
    const { previousDoc, result, diffSourceWindow } = applyEditCore(edit, newSource, nextOptions);
    const refinement = resolveDiffRefinementOptions(diffOptions);
    let diff: TokenDiffResult;
    try {
      const skipRefinementForLargeFallback =
        result.mode === "full-fallback" &&
        (previousDoc.source.length > MAX_FULL_FALLBACK_DIFF_REFINEMENT_SOURCE_LENGTH ||
          result.doc.source.length > MAX_FULL_FALLBACK_DIFF_REFINEMENT_SOURCE_LENGTH);
      if (skipRefinementForLargeFallback) {
        // full-fallback 且文档很大时，深挖细粒度 diff 的性价比通常很差。
        diff = buildConservativeTokenDiff(previousDoc, result.doc);
      } else {
        diff =
          result.mode === "incremental"
            ? computeTokenDiffWithinSourceWindow(
                previousDoc.tree,
                result.doc.tree,
                edit,
                refinement.refinementDepthCap,
                refinement.budgetOptions,
                diffSourceWindow,
                {
                  oldEndOffset: previousDoc.source.length,
                  newEndOffset: result.doc.source.length,
                },
              )
            : computeTokenDiff(
                previousDoc.tree,
                result.doc.tree,
                edit,
                refinement.refinementDepthCap,
                refinement.budgetOptions,
                {
                  oldEndOffset: previousDoc.source.length,
                  newEndOffset: result.doc.source.length,
                },
              );
      }
    } catch (_error) {
      // diff 降级不能影响 session 结果；新快照已经是对的，只是 diff 不够细。
      diff = buildConservativeTokenDiff(previousDoc, result.doc);
    }
    return { ...result, diff };
  };

  return {
    getDocument: () => currentDoc,
    applyEdit,
    applyEditWithDiff,
    rebuild,
  };
};
