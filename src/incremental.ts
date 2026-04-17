// ═══════════════════════════════════════════════════════════════
// incremental.ts — 增量解析器
//
// 核心思路：
// 把文档拆成 zone（连续节点分组），编辑只影响脏区间，
// 左侧 zone 原封不动，右侧 zone 用 lazy delta 平移，中间重解析。
// 整个更新路径不产出中间 AST，最终拼接出新快照。
//
// 硬规则：
// - frozenSnapshots 只能标记内部创建的 snapshot，绝对不能标记用户对象
// - handler deep clone 不能省——测试 L308-338 证明浅拷贝会导致跨代穿透
// - fingerprint 不能替代 snapshot clone——测试 L340-363 证明等价 fingerprint 下
//   plain-data metadata 仍然可以不同
// - 右侧复用必须过 seam probe，不能盲信 offset 对齐
//
// 文件导航（行号可能因编辑微调，但顺序不变）：
//
//   ── 快照克隆 ──
//   ~130  cloneSnapshotValueInternal   递归深拷贝 plain object/array
//   ~246  cloneHandlersSnapshot        handler 层级：函数引用保留，data 递归拷贝
//   ~265  cloneParseOptions            顶层入口；frozenSnapshots 做幂等守卫
//
//   ── 指纹 & 签名 ──
//   ~304  objectIdentitySeed           函数/对象 identity → 整数映射
//   ~327  buildHandlersShapeFingerprint  handler 结构指纹（key + inline/raw/block identity）
//   ~353  buildParseOptionsFingerprint   整合 syntax/tagName/allowForms/handlers
//   ~509  nodeSignature                节点结构签名（bounded content hash，首尾 32 字符）
//   ~606  zoneSignature                zone 签名 = 子节点签名聚合
//
//   ── 右侧复用 ──
//   ~631  isSafeRightReuse             seam probe：在拼接缝重解析一小段，比对签名
//  ~1566  createShiftedNodeShell       节点壳平移（只移 position，不递归子节点）
//  ~1587  shiftNode                    迭代式深度平移（用栈模拟递归）
//
//   ── 懒 delta 平移（1.2.4+）──
//  ~1645  deferShiftZone               O(1) 记录 delta，不动节点
//  ~1663  materializeZone              首次读取时一次性平移节点 position
//  ~1682  installLazyDocument          用 Object.defineProperty 挂 lazy getter
//
//   ── 增量更新核心 ──
//  ~1717  findDirtyRange               找脏 zone 区间（overlap + 左右各扩一格）
//  ~1754  reparseDirtyWindowUntilStable  循环重解析直到右边界稳定或超预算
//  ~1818  assertValidEdit              编辑合法性三重校验
//  ~1886  parseIncremental             全量解析入口（首次 / rebuild）
//  ~1920  updateIncrementalInternal    增量更新主流程
//
//   ── Session（自适应策略）──
//  ~2131  createIncrementalSession     有状态会话，auto/incremental-only/full-only
//  ~2309  applyEdit                    session 的编辑入口（策略门控 → 增量 → 兜底）
// ═══════════════════════════════════════════════════════════════

import { buildPositionTracker } from "./positions.js";
import { parseStructural } from "./structural.js";
import { fnv1a, fnvFeedStringBounded, fnvFeedU32, fnvInit } from "./hash.js";
import type {
  IncrementalDocument,
  IncrementalEdit,
  IncrementalParseOptions,
  IncrementalSessionFallbackReason,
  IncrementalSessionApplyWithDiffResult,
  IncrementalSessionOptions,
  IncrementalSession,
  IncrementalSessionApplyResult,
  IncrementalSessionStrategy,
  StructuralDiffContainerField,
  StructuralDiffOp,
  StructuralDiffPath,
  TokenDiffPatch,
  TokenDiffResult,
  TokenDiffUnchangedRange,
  IncrementalUpdateError,
  IncrementalUpdateErrorCode,
  IncrementalUpdateResult,
  PositionTracker,
  SourcePosition,
  StructuralNode,
  Zone,
} from "./types.js";
import { buildZonesInternal, SOFT_ZONE_NODE_CAP } from "./zones.js";

// 性能备忘：
// 只重解析脏区间。右侧 zone 用 lazy delta——只存 offset 偏移量，
// 节点 position 延迟到消费者读 tree/zones 时才物化。
// 连续头部编辑自动叠加 delta，不触发中间深拷贝。
// 物化后的文档是纯数据对象，没有 Proxy 语义。

// ── 错误工具 ──

const createIncrementalEditError = (
  code: IncrementalUpdateErrorCode,
  message: string,
): IncrementalUpdateError => {
  const error = new Error(message) as IncrementalUpdateError;
  error.code = code;
  return error;
};

const isIncrementalUpdateError = (error: unknown): error is IncrementalUpdateError => {
  if (!(error instanceof Error)) return false;
  const withCode = error as Error & { code?: unknown };
  return (
    withCode.code === "INVALID_EDIT_RANGE" ||
    withCode.code === "NEW_SOURCE_LENGTH_MISMATCH" ||
    withCode.code === "EDIT_TEXT_MISMATCH" ||
    withCode.code === "UNKNOWN"
  );
};

// ── 快照克隆 ──
//
// 为什么要克隆 parseOptions？
// 用户传进来的 options 可能被外部改动（比如 handler.meta.xxx = 123），
// 如果不隔离，session 内部状态会被"穿透"。
// 所以每次拿到 options 都做一次深拷贝：函数引用保留，plain object/array 递归克隆。
//
// frozenSnapshots 的作用：
// 内部创建的 snapshot 会被标记进 WeakSet。
// 下次同一个 snapshot 再传进来时，我们知道"这是自己人"，但仍然要 re-clone
// nested 字段（handlers/syntax/tagName/allowForms），因为跨代共享会导致
// 旧文档改动影响新文档。所以 frozenSnapshots 目前只是幂等守卫，不是性能快路径。

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// 深拷贝：只处理 plain object 和 array，函数/class 实例原样返回。
// 显式栈 + seen WeakMap 防循环引用（不走原生递归，避免深层栈溢出）。
const cloneSnapshotValueInternal = <T>(value: T, seen: WeakMap<object, unknown>): T => {
  type ObjectFrame = {
    kind: "object";
    source: Record<string, unknown>;
    target: Record<string, unknown>;
    keys: string[];
    index: number;
  };
  type ArrayFrame = {
    kind: "array";
    source: unknown[];
    target: unknown[];
    index: number;
  };
  type CloneFrame = ObjectFrame | ArrayFrame;
  type CloneContainer = {
    source: object;
    clone: unknown[] | Record<string, unknown>;
    kind: "array" | "object";
  };

  const asContainer = (
    candidate: unknown,
  ): CloneContainer | undefined => {
    if (Array.isArray(candidate)) {
      return { source: candidate, clone: new Array(candidate.length), kind: "array" };
    }
    if (isPlainObject(candidate)) {
      return { source: candidate, clone: {}, kind: "object" };
    }
    return undefined;
  };

  const rootContainer = asContainer(value);
  if (!rootContainer) return value;

  const pushContainerFrame = (container: CloneContainer, stack: CloneFrame[]): void => {
    if (container.kind === "array") {
      stack.push({
        kind: "array",
        source: container.source as unknown[],
        target: container.clone as unknown[],
        index: 0,
      });
      return;
    }
    stack.push({
      kind: "object",
      source: container.source as Record<string, unknown>,
      target: container.clone as Record<string, unknown>,
      keys: Object.keys(container.source as Record<string, unknown>),
      index: 0,
    });
  };

  const rootSeen = seen.get(rootContainer.source);
  if (rootSeen !== undefined) return rootSeen as T;
  seen.set(rootContainer.source, rootContainer.clone);

  const stack: CloneFrame[] = [];
  pushContainerFrame(rootContainer, stack);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.kind === "array") {
      if (frame.index >= frame.source.length) {
        stack.pop();
        continue;
      }
      const i = frame.index++;
      const child = frame.source[i];
      const container = asContainer(child);
      if (!container) {
        frame.target[i] = child;
        continue;
      }
      const cached = seen.get(container.source);
      if (cached !== undefined) {
        frame.target[i] = cached;
        continue;
      }
      seen.set(container.source, container.clone);
      frame.target[i] = container.clone;
      pushContainerFrame(container, stack);
      continue;
    }

    if (frame.index >= frame.keys.length) {
      stack.pop();
      continue;
    }
    const key = frame.keys[frame.index++];
    const child = frame.source[key];
    const container = asContainer(child);
    if (!container) {
      frame.target[key] = child;
      continue;
    }
    const cached = seen.get(container.source);
    if (cached !== undefined) {
      frame.target[key] = cached;
      continue;
    }
    seen.set(container.source, container.clone);
    frame.target[key] = container.clone;
    pushContainerFrame(container, stack);
  }

  return rootContainer.clone as T;
};

const cloneSnapshotValue = <T>(value: T): T =>
  cloneSnapshotValueInternal(value, new WeakMap<object, unknown>());

// handler 克隆：每个 handler 的 data 字段递归深拷贝，函数引用保留。
// 不能改成浅拷贝——测试证明 handler.meta 这种嵌套对象会被外部改动。
const cloneHandlersSnapshot = (
  handlers: IncrementalParseOptions["handlers"] | undefined,
): IncrementalParseOptions["handlers"] | undefined => {
  if (!handlers) return undefined;
  const next: Record<string, (typeof handlers)[string]> = {};
  const keys = Object.keys(handlers);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const handler = handlers[key];
    next[key] = handler ? cloneSnapshotValue(handler) : handler;
  }
  return next;
};

// 克隆 parseOptions：顶层浅展开 + handlers 深拷贝 + syntax/tagName/allowForms 浅拷贝。
// frozen 分支和普通分支做的事情完全一样——frozenSnapshots 只是幂等标记，
// 不提供性能捷径。
const frozenSnapshots = new WeakSet<object>();

const cloneParseOptions = (
  options: IncrementalParseOptions | undefined,
): IncrementalParseOptions | undefined => {
  if (!options) return undefined;
  // 已经是内部 snapshot —— 仍然 re-clone 嵌套可变字段，
  // 防止跨代引用穿透（旧 doc.parseOptions.handlers.bold.meta 被改 → 影响新文档）。
  if (frozenSnapshots.has(options)) {
    const fresh: IncrementalParseOptions = {
      ...options,
      handlers: cloneHandlersSnapshot(options.handlers),
      syntax: options.syntax ? { ...options.syntax } : undefined,
      tagName: options.tagName ? { ...options.tagName } : undefined,
      allowForms: options.allowForms ? [...options.allowForms] : undefined,
    };
    frozenSnapshots.add(fresh);
    return fresh;
  }
  const snapshot: IncrementalParseOptions = {
    ...options,
    handlers: cloneHandlersSnapshot(options.handlers),
    syntax: options.syntax ? { ...options.syntax } : undefined,
    tagName: options.tagName ? { ...options.tagName } : undefined,
    allowForms: options.allowForms ? [...options.allowForms] : undefined,
  };
  frozenSnapshots.add(snapshot);
  return snapshot;
};

// ── 指纹 & 签名 ──
//
// 指纹（fingerprint）：用于判断"配置是否变了"。
// 配置变了 → 必须 full rebuild，因为 handler/syntax 不同会导致解析结果完全不同。
//
// 签名（signature）：用于判断"节点/zone 结构是否一致"。
// seam probe 时比对新旧 zone 签名，不一致 → 右侧不能复用。
//
// 两者都基于 FNV-1a hash，但用途不同，别混。

// 给函数/对象分配稳定整数 ID，用于 fingerprint 中比对 handler 引用是否相同。
let objectIdentitySeed = 1;
const objectIdentityMap = new WeakMap<object, number>();

const getObjectIdentity = (value: object | undefined): number => {
  if (!value) return 0;
  const cached = objectIdentityMap.get(value);
  if (cached) return cached;
  const next = objectIdentitySeed;
  objectIdentitySeed += 1;
  objectIdentityMap.set(value, next);
  return next;
};

const getIdentityForUnknown = (value: unknown): number => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    return getObjectIdentity(value);
  }
  return 0;
};

// handler 结构指纹：hash(key 列表 + 每个 handler 的 inline/raw/block 函数引用 identity)。
// key 排序是必要的——JS 对象 key 顺序受插入顺序影响，
// 等价 handler 用不同顺序构造会产生不同 key 序列，不排序会误判为"配置变了"。
const buildHandlersShapeFingerprint = (handlers: unknown): number => {
  if (!handlers || typeof handlers !== "object") return 0;
  const record = handlers as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  let hash = fnvInit();
  hash = fnvFeedU32(hash, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const handler = record[key];
    hash = fnvFeedU32(hash, hashText(key));
    if (!handler || typeof handler !== "object") continue;
    const handlerRecord = handler as Record<string, unknown>;
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.inline));
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.raw));
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.block));
  }
  return hash >>> 0;
};

const DEFAULT_PARSE_OPTIONS_FINGERPRINT = fnvFeedU32(fnvInit(), 0x9e3779b9);

const normalizeShorthandList = (input: readonly string[]): string[] =>
  Array.from(new Set(input)).sort();

// 整合指纹：handlers + allowForms + shorthand 模式 + syntax 8 字段 + tagName 两个函数引用。
// 任何一项变了 → fingerprint 不同 → 增量更新直接跳 full rebuild。
const buildParseOptionsFingerprint = (options: IncrementalParseOptions | undefined): number => {
  if (!options) return DEFAULT_PARSE_OPTIONS_FINGERPRINT;
  const syntax = options.syntax ?? {};
  const tagName = options.tagName ?? {};
  const allowForms = options.allowForms ?? [];
  const shorthandMode = options.implicitInlineShorthand;

  let hash = fnvInit();
  hash = fnvFeedU32(hash, buildHandlersShapeFingerprint(options.handlers));
  hash = fnvFeedU32(hash, allowForms.length);
  for (let i = 0; i < allowForms.length; i++) {
    hash = fnvFeedU32(hash, hashText(allowForms[i]));
  }
  if (Array.isArray(shorthandMode)) {
    const normalized = normalizeShorthandList(shorthandMode);
    hash = fnvFeedU32(hash, 2);
    hash = fnvFeedU32(hash, normalized.length);
    for (let i = 0; i < normalized.length; i++) {
      hash = fnvFeedU32(hash, hashText(normalized[i]));
    }
  } else if (shorthandMode === false) {
    hash = fnvFeedU32(hash, 0);
  } else if (shorthandMode === true) {
    hash = fnvFeedU32(hash, 1);
  } else {
    // undefined -> behavior equals false in buildGatingContext
    hash = fnvFeedU32(hash, 0);
  }

  const syntaxKeys = [
    "tagOpen", "tagClose", "endTag", "tagDivider",
    "rawOpen", "rawClose", "blockOpen", "blockClose",
  ] as const;
  for (const k of syntaxKeys) hash = fnvFeedU32(hash, hashText(syntax[k] ?? ""));

  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagStartChar as object | undefined));
  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagChar as object | undefined));
  return hash >>> 0;
};

// 安全检查：编辑范围超出最后一个 zone 的覆盖 → 快照状态不可信，必须 full rebuild。
const hasUnsafeZoneCoverageTailGap = (zones: readonly Zone[], edit: IncrementalEdit): boolean => {
  const lastZone = zones[zones.length - 1];
  if (!lastZone) return false;
  return edit.startOffset > lastZone.endOffset || edit.oldEndOffset > lastZone.endOffset;
};

// 带 position tracking 的解析入口。
// baseOffset 让切片解析产出的 position 是文档全局坐标，不是切片内局部坐标。
const parseWithPositions = (
  source: string,
  tracker: PositionTracker,
  options?: IncrementalParseOptions,
  baseOffset = 0,
): StructuralNode[] =>
  // parseStructural 公共路径会把 baseOffset 硬编码为 0，
  // 但 resolveBaseOptions 会用我们传的 baseOffset 包装 tracker，
  // 所以最终 position 仍然是全局正确的。
  parseStructural(source, {
    ...options,
    trackPositions: true,
    baseOffset,
    tracker,
  });

// zone 展开成 flat tree（消费者用）。
const flattenZones = (zones: readonly Zone[]): StructuralNode[] => {
  const tree: StructuralNode[] = [];
  for (const zone of zones) {
    tree.push(...zone.nodes);
  }
  return tree;
};

const normalizeSoftZoneNodeCap = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return SOFT_ZONE_NODE_CAP;
  return Math.max(2, Math.floor(value));
};

// ── 右侧复用安全门 ──
//
// 增量更新只在 seam probe 确认拼接缝两侧结构稳定后，才复用右侧 zone。
// probe 失败 → full rebuild，宁可多做也不冒误复用的风险。

// 左回看 1 个 zone：编辑可能影响前一个 zone 的闭合边界。
const LEFT_LOOKBEHIND_ZONES = 1;
// probe 比对 2 个 zone，额外多解析 1 个 zone 作为上下文窗口。
const RIGHT_REUSE_PROBE_ZONES = 2;
const RIGHT_REUSE_PROBE_EXTRA_ZONES = 1;
// 单次 probe 的节点签名预算——超了就放弃 probe，直接 full rebuild。
const RIGHT_REUSE_PROBE_SIGNATURE_NODE_BUDGET = 4096;

// 节点类型标签——用于签名 hash，让不同类型的节点永远产生不同签名。
const NODE_TAG_TEXT = 1;
const NODE_TAG_ESCAPE = 2;
const NODE_TAG_SEPARATOR = 3;
const NODE_TAG_INLINE = 4;
const NODE_TAG_RAW = 5;
const NODE_TAG_BLOCK = 6;
const ZONE_TAG = 7;

// node 签名不包含 position；shiftNodePositions 只会平移 position，
// 不会影响结构签名，因此同一引用的 WeakMap 缓存仍然有效。
const nodeSignatureCache = new WeakMap<StructuralNode, number>();
const zoneSignatureCache = new WeakMap<Zone, number>();
// 文档 → 配置指纹缓存：避免每次增量更新都重算 fingerprint。
const parseOptionsFingerprintCache = new WeakMap<IncrementalDocument, number>();

// 签名预算：seam probe 时限制签名计算的节点数，防止巨型树拖慢 probe。
interface SignatureBudget {
  remaining: number;
}

// debug 统计——仅测试用，生产不设 sink 就零开销。
interface IncrementalDebugStats {
  cumulativeReparsedBytes: number;
  probeSliceBytes: number;
  fellBackToFull: boolean;
  /** pre-work overhead wasted before a full-rebuild fallback (clone + tracker + zone-scan) */
  wastedPreWorkMs: number;
}

type IncrementalDebugSink = (stats: IncrementalDebugStats) => void;
type InternalUpdateMode = "incremental" | "internal-full-rebuild";
type InternalUpdateObserver = (mode: InternalUpdateMode) => void;

let incrementalDebugSink: IncrementalDebugSink | undefined;

/** @internal test-only hook */
export const __setIncrementalDebugSink: (sink?: IncrementalDebugSink) => void = (sink) => {
  incrementalDebugSink = sink;
};

// hashText：tag 名称等短字符串，直接全量 FNV-1a（很便宜）。
const hashText = (value: string): number => fnv1a(value);
// hashTextBounded：text/raw content 等可能很长的字符串，
// 只 hash 首尾各 32 字符（O(1) 有界），在速度和误判率之间取平衡。
const hashTextBounded = (hash: number, value: string): number =>
  fnvFeedStringBounded(hash, value);

const getCachedOptionsFingerprint = (doc: IncrementalDocument): number | undefined =>
  parseOptionsFingerprintCache.get(doc);

const setCachedOptionsFingerprint = (doc: IncrementalDocument, fingerprint: number): void => {
  parseOptionsFingerprintCache.set(doc, fingerprint);
};

const tryConsumeSignatureBudget = (budget: SignatureBudget): boolean => {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
};

// 节点结构签名：hash(类型标签 + tag名 + 子节点/arg 数量 + content 长度 + bounded 内容采样)。
// 纯结构比对不需要全量 hash content，但纯长度又有"同长不同内容"盲区，
// 所以折中用 bounded sampling（首尾 32 字符）——O(1) 且几乎不会误判。
const nodeSignature = (node: StructuralNode, budget?: SignatureBudget): number | undefined => {
  if (!budget) {
    const cached = nodeSignatureCache.get(node);
    if (cached !== undefined) return cached;
  }

  type SignatureEnterFrame = {
    kind: "enter";
    node: StructuralNode;
  };
  type SignatureExitFrame = {
    kind: "exit";
    hash: number;
    valueBase: number;
  };
  type SignatureFrame = SignatureEnterFrame | SignatureExitFrame;

  const frameStack: SignatureFrame[] = [{ kind: "enter", node }];
  const valueStack: number[] = [];

  while (frameStack.length > 0) {
    const frame = frameStack.pop();
    if (!frame) break;

    if (frame.kind === "enter") {
      if (budget && !tryConsumeSignatureBudget(budget)) return undefined;

      const current = frame.node;
      if (current.type === "separator") {
        valueStack.push(NODE_TAG_SEPARATOR);
        continue;
      }
      if (current.type === "text") {
        let h = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_TEXT), current.value.length);
        valueStack.push(hashTextBounded(h, current.value) >>> 0);
        continue;
      }
      if (current.type === "escape") {
        let h = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_ESCAPE), current.raw.length);
        valueStack.push(hashTextBounded(h, current.raw) >>> 0);
        continue;
      }
      if (current.type === "inline") {
        let h = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_INLINE), hashText(current.tag));
        h = fnvFeedU32(h, current.implicitInlineShorthand ? 1 : 0);
        h = fnvFeedU32(h, current.children.length);
        frameStack.push({ kind: "exit", hash: h, valueBase: valueStack.length });
        for (let i = current.children.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.children[i] });
        }
        continue;
      }
      if (current.type === "raw") {
        let h = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_RAW), hashText(current.tag));
        h = fnvFeedU32(h, current.args.length);
        h = fnvFeedU32(h, current.content.length);
        h = hashTextBounded(h, current.content);
        frameStack.push({ kind: "exit", hash: h, valueBase: valueStack.length });
        for (let i = current.args.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.args[i] });
        }
        continue;
      }
      if (current.type === "block") {
        let h = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_BLOCK), hashText(current.tag));
        h = fnvFeedU32(h, current.args.length);
        h = fnvFeedU32(h, current.children.length);
        frameStack.push({ kind: "exit", hash: h, valueBase: valueStack.length });
        for (let i = current.children.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.children[i] });
        }
        for (let i = current.args.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.args[i] });
        }
        continue;
      }
      return assertUnreachable(current);
    }

    let h = frame.hash;
    for (let i = frame.valueBase; i < valueStack.length; i++) {
      h = fnvFeedU32(h, valueStack[i]);
    }
    valueStack.length = frame.valueBase;
    valueStack.push(h >>> 0);
  }

  if (valueStack.length !== 1) return undefined;
  const finalized = valueStack[0] >>> 0;
  if (!budget) {
    nodeSignatureCache.set(node, finalized);
  }
  return finalized;
};

// zone 签名 = ZONE_TAG + zone 跨度 + 所有子节点签名聚合。
// 无 budget 时结果缓存进 WeakMap（zone 不可变，签名永远不变）。
const zoneSignature = (zone: Zone, budget?: SignatureBudget): number | undefined => {
  if (!budget) {
    const cached = zoneSignatureCache.get(zone);
    if (cached !== undefined) return cached;
  }
  let hash = fnvInit();
  hash = fnvFeedU32(hash, ZONE_TAG);
  hash = fnvFeedU32(hash, zone.endOffset - zone.startOffset);
  for (let i = 0; i < zone.nodes.length; i++) {
    const signature = nodeSignature(zone.nodes[i], budget);
    if (signature === undefined) return undefined;
    hash = fnvFeedU32(hash, signature);
  }
  const finalized = hash >>> 0;
  if (!budget) {
    zoneSignatureCache.set(zone, finalized);
  }
  return finalized;
};

// seam probe（拼接缝探测）：
// 在新旧文档的拼接边界，取右侧前几个 zone 的范围重新解析，
// 把解析结果的签名和旧 zone 签名逐一比对。
// 全部匹配 → 右侧可以安全复用；任何一个不匹配 → full rebuild。
// 这是"宁可多 rebuild 也不误复用"的保守策略。
const isSafeRightReuse = (
  oldRightZones: readonly Zone[],
  newSource: string,
  seamNewOffset: number,
  delta: number,
  tracker: PositionTracker,
  parseOptions: IncrementalParseOptions | undefined,
  zoneCap: number,
): { ok: boolean; probeSliceBytes: number } => {
  if (oldRightZones.length === 0) return { ok: true, probeSliceBytes: 0 };

  const probeZoneCount = Math.min(RIGHT_REUSE_PROBE_ZONES, oldRightZones.length);
  const probeWindowZoneCount = Math.min(
    oldRightZones.length,
    probeZoneCount + RIGHT_REUSE_PROBE_EXTRA_ZONES,
  );
  const probeStartOld = oldRightZones[0].startOffset;
  const probeEndOld = oldRightZones[probeWindowZoneCount - 1].endOffset;
  const probeLength = probeEndOld - probeStartOld;
  const probeEndNew = seamNewOffset + probeLength;

  const probeTree = parseWithPositions(
    newSource.slice(seamNewOffset, probeEndNew),
    tracker,
    parseOptions,
    seamNewOffset,
  );
  const probeZones = buildZonesInternal(probeTree, zoneCap);
  if (probeZones.length < probeZoneCount) return { ok: false, probeSliceBytes: probeLength };
  const signatureBudget: SignatureBudget = {
    remaining: RIGHT_REUSE_PROBE_SIGNATURE_NODE_BUDGET,
  };

  for (let i = 0; i < probeZoneCount; i++) {
    const expected = oldRightZones[i];
    const actual = probeZones[i];
    if (actual.startOffset !== expected.startOffset + delta) return { ok: false, probeSliceBytes: probeLength };
    if (actual.endOffset !== expected.endOffset + delta) return { ok: false, probeSliceBytes: probeLength };
    if (actual.nodes.length !== expected.nodes.length) return { ok: false, probeSliceBytes: probeLength };
    const actualSignature = zoneSignature(actual, signatureBudget);
    if (actualSignature === undefined) return { ok: false, probeSliceBytes: probeLength };
    const expectedSignature = zoneSignature(expected);
    if (expectedSignature === undefined || actualSignature !== expectedSignature) {
      return { ok: false, probeSliceBytes: probeLength };
    }
  }

  return { ok: true, probeSliceBytes: probeLength };
};

// 旧坐标 → 新坐标映射：编辑点左侧不变，右侧加 delta，中间映射到编辑尾部。
const mapOldOffsetToNew = (edit: IncrementalEdit, delta: number, oldOffset: number): number => {
  if (oldOffset <= edit.startOffset) return oldOffset;
  if (oldOffset >= edit.oldEndOffset) return oldOffset + delta;
  return edit.startOffset + edit.newText.length;
};

type SequenceDiffSegment = {
  kind: "equal" | "change";
  oldRange: { start: number; end: number };
  newRange: { start: number; end: number };
};

type SequenceDiffAccumulator = {
  segments: SequenceDiffSegment[];
  ops: StructuralDiffOp[];
};

type AnchorCandidate = {
  oldIndex: number;
  newIndex: number;
};

type NestedNodeArrayDiffTask = {
  previousNodes: readonly StructuralNode[];
  nextNodes: readonly StructuralNode[];
  path: StructuralDiffPath;
  field: StructuralDiffContainerField;
};

const appendDiffSegment = (
  segments: SequenceDiffSegment[],
  kind: SequenceDiffSegment["kind"],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void => {
  if (oldStart === oldEnd && newStart === newEnd) return;
  const previous = segments[segments.length - 1];
  if (
    previous &&
    previous.kind === kind &&
    previous.oldRange.end === oldStart &&
    previous.newRange.end === newStart
  ) {
    previous.oldRange.end = oldEnd;
    previous.newRange.end = newEnd;
    return;
  }
  segments.push({
    kind,
    oldRange: { start: oldStart, end: oldEnd },
    newRange: { start: newStart, end: newEnd },
  });
};

const emitSplice = (
  accumulator: SequenceDiffAccumulator,
  recordSegments: boolean,
  path: StructuralDiffPath,
  field: StructuralDiffContainerField,
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void => {
  if (recordSegments) {
    appendDiffSegment(accumulator.segments, "change", oldStart, oldEnd, newStart, newEnd);
  }
  accumulator.ops.push({
    kind: "splice",
    path: path.slice(),
    field,
    oldRange: { start: oldStart, end: oldEnd },
    newRange: { start: newStart, end: newEnd },
    oldNodes: previousNodes.slice(oldStart, oldEnd),
    newNodes: nextNodes.slice(newStart, newEnd),
  });
};

const appendTrailingEqualSegments = (
  accumulator: SequenceDiffAccumulator,
  recordSegments: boolean,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void => {
  let oldCursor = oldStart;
  let newCursor = newStart;
  while (oldCursor < oldEnd && newCursor < newEnd) {
    if (recordSegments) {
      appendDiffSegment(
        accumulator.segments,
        "equal",
        oldCursor,
        oldCursor + 1,
        newCursor,
        newCursor + 1,
      );
    }
    oldCursor += 1;
    newCursor += 1;
  }
};

const emitSpliceAndTrailingEquals = (
  accumulator: SequenceDiffAccumulator,
  recordSegments: boolean,
  path: StructuralDiffPath,
  field: StructuralDiffContainerField,
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  spliceOldStart: number,
  spliceOldEnd: number,
  spliceNewStart: number,
  spliceNewEnd: number,
  trailingOldStart: number,
  trailingOldEnd: number,
  trailingNewStart: number,
  trailingNewEnd: number,
): void => {
  emitSplice(
    accumulator,
    recordSegments,
    path,
    field,
    previousNodes,
    nextNodes,
    spliceOldStart,
    spliceOldEnd,
    spliceNewStart,
    spliceNewEnd,
  );
  appendTrailingEqualSegments(
    accumulator,
    recordSegments,
    trailingOldStart,
    trailingOldEnd,
    trailingNewStart,
    trailingNewEnd,
  );
};

const appendPathSegment = (
  path: StructuralDiffPath,
  field: StructuralDiffContainerField,
  index: number,
): StructuralDiffPath => [...path, { field, index }];

const signaturesMatch = (previousNode: StructuralNode, nextNode: StructuralNode): boolean =>
  nodeSignature(previousNode) === nodeSignature(nextNode);

const areNodesStructurallyEqual = (previousNode: StructuralNode, nextNode: StructuralNode): boolean => {
  if (previousNode === nextNode) return true;
  if (!signaturesMatch(previousNode, nextNode)) return false;

  const pending: Array<{ previousNode: StructuralNode; nextNode: StructuralNode }> = [
    { previousNode, nextNode },
  ];

  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) break;
    const currentPrevious = frame.previousNode;
    const currentNext = frame.nextNode;
    if (currentPrevious.type !== currentNext.type) return false;

    if (currentPrevious.type === "text" && currentNext.type === "text") {
      if (currentPrevious.value !== currentNext.value) return false;
      continue;
    }
    if (currentPrevious.type === "escape" && currentNext.type === "escape") {
      if (currentPrevious.raw !== currentNext.raw) return false;
      continue;
    }
    if (currentPrevious.type === "separator" && currentNext.type === "separator") {
      continue;
    }
    if (currentPrevious.type === "inline" && currentNext.type === "inline") {
      if (currentPrevious.tag !== currentNext.tag) return false;
      if (!!currentPrevious.implicitInlineShorthand !== !!currentNext.implicitInlineShorthand) return false;
      if (currentPrevious.children.length !== currentNext.children.length) return false;
      for (let i = currentPrevious.children.length - 1; i >= 0; i--) {
        pending.push({
          previousNode: currentPrevious.children[i],
          nextNode: currentNext.children[i],
        });
      }
      continue;
    }
    if (currentPrevious.type === "raw" && currentNext.type === "raw") {
      if (currentPrevious.tag !== currentNext.tag) return false;
      if (currentPrevious.content !== currentNext.content) return false;
      if (currentPrevious.args.length !== currentNext.args.length) return false;
      for (let i = currentPrevious.args.length - 1; i >= 0; i--) {
        pending.push({
          previousNode: currentPrevious.args[i],
          nextNode: currentNext.args[i],
        });
      }
      continue;
    }
    if (currentPrevious.type === "block" && currentNext.type === "block") {
      if (currentPrevious.tag !== currentNext.tag) return false;
      if (currentPrevious.args.length !== currentNext.args.length) return false;
      if (currentPrevious.children.length !== currentNext.children.length) return false;
      for (let i = currentPrevious.children.length - 1; i >= 0; i--) {
        pending.push({
          previousNode: currentPrevious.children[i],
          nextNode: currentNext.children[i],
        });
      }
      for (let i = currentPrevious.args.length - 1; i >= 0; i--) {
        pending.push({
          previousNode: currentPrevious.args[i],
          nextNode: currentNext.args[i],
        });
      }
      continue;
    }
    return false;
  }

  return true;
};

const canDiffNodesRecursively = (previousNode: StructuralNode, nextNode: StructuralNode): boolean => {
  if (previousNode.type !== nextNode.type) return false;
  if (previousNode.type === "text" && nextNode.type === "text") return true;
  if (previousNode.type === "escape" && nextNode.type === "escape") return true;
  if (previousNode.type === "separator" && nextNode.type === "separator") return true;
  if (previousNode.type === "inline" && nextNode.type === "inline") {
    return previousNode.tag === nextNode.tag;
  }
  if (previousNode.type === "raw" && nextNode.type === "raw") {
    return previousNode.tag === nextNode.tag;
  }
  if (previousNode.type === "block" && nextNode.type === "block") {
    return previousNode.tag === nextNode.tag;
  }
  return false;
};

const findAnchors = (
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): AnchorCandidate[] => {
  const oldEntries = new Map<number, { count: number; index: number }>();
  const newEntries = new Map<number, { count: number; index: number }>();

  for (let i = oldStart; i < oldEnd; i++) {
    const signature = nodeSignature(previousNodes[i]);
    if (signature === undefined) continue;
    const current = oldEntries.get(signature);
    if (current) {
      current.count += 1;
    } else {
      oldEntries.set(signature, { count: 1, index: i });
    }
  }
  for (let i = newStart; i < newEnd; i++) {
    const signature = nodeSignature(nextNodes[i]);
    if (signature === undefined) continue;
    const current = newEntries.get(signature);
    if (current) {
      current.count += 1;
    } else {
      newEntries.set(signature, { count: 1, index: i });
    }
  }

  const candidates: AnchorCandidate[] = [];
  for (const [signature, oldEntry] of oldEntries.entries()) {
    if (oldEntry.count !== 1) continue;
    const newEntry = newEntries.get(signature);
    if (!newEntry || newEntry.count !== 1) continue;
    if (!areNodesStructurallyEqual(previousNodes[oldEntry.index], nextNodes[newEntry.index])) continue;
    candidates.push({ oldIndex: oldEntry.index, newIndex: newEntry.index });
  }
  if (candidates.length <= 1) return candidates;

  candidates.sort((left, right) => left.oldIndex - right.oldIndex || left.newIndex - right.newIndex);

  const tails: number[] = [];
  const tailPositions: number[] = [];
  const predecessors = new Array<number>(candidates.length).fill(-1);

  for (let i = 0; i < candidates.length; i++) {
    const newIndex = candidates[i].newIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (tails[mid] < newIndex) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (low > 0) {
      predecessors[i] = tailPositions[low - 1];
    }
    tails[low] = newIndex;
    tailPositions[low] = i;
  }

  const lis: AnchorCandidate[] = [];
  let currentIndex = tailPositions[tails.length - 1];
  while (currentIndex !== undefined && currentIndex >= 0) {
    lis.push(candidates[currentIndex]);
    currentIndex = predecessors[currentIndex];
  }
  lis.reverse();
  return lis;
};

const structuralDiffFieldRank = (field: StructuralDiffContainerField): number => {
  if (field === "root") return 0;
  if (field === "children") return 1;
  return 2;
};

const compareDiffPathsDescending = (
  leftPath: StructuralDiffPath,
  rightPath: StructuralDiffPath,
): number => {
  const limit = Math.min(leftPath.length, rightPath.length);
  for (let i = 0; i < limit; i++) {
    if (leftPath[i].index !== rightPath[i].index) {
      return rightPath[i].index - leftPath[i].index;
    }
    if (leftPath[i].field !== rightPath[i].field) {
      return structuralDiffFieldRank(rightPath[i].field) - structuralDiffFieldRank(leftPath[i].field);
    }
  }
  return rightPath.length - leftPath.length;
};

const compareStructuralDiffOpsDescending = (left: StructuralDiffOp, right: StructuralDiffOp): number => {
  const pathComparison = compareDiffPathsDescending(left.path, right.path);
  if (pathComparison !== 0) return pathComparison;

  if (left.kind === "splice" && right.kind === "splice") {
    if (left.field !== right.field) {
      return structuralDiffFieldRank(right.field) - structuralDiffFieldRank(left.field);
    }
    if (left.oldRange.start !== right.oldRange.start) {
      return right.oldRange.start - left.oldRange.start;
    }
    if (left.oldRange.end !== right.oldRange.end) {
      return right.oldRange.end - left.oldRange.end;
    }
    if (left.newRange.start !== right.newRange.start) {
      return right.newRange.start - left.newRange.start;
    }
    if (left.newRange.end !== right.newRange.end) {
      return right.newRange.end - left.newRange.end;
    }
  } else if (left.kind === "splice") {
    return -1;
  } else if (right.kind === "splice") {
    return 1;
  }

  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;
  return 0;
};

const queueNestedNodeArrayDiff = (
  nestedTasks: NestedNodeArrayDiffTask[],
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  path: StructuralDiffPath,
  field: StructuralDiffContainerField,
): void => {
  nestedTasks.push({ previousNodes, nextNodes, path, field });
};

interface NodeArrayDiffRangeWorkItem {
  kind: "range";
  previousNodes: readonly StructuralNode[];
  nextNodes: readonly StructuralNode[];
  path: StructuralDiffPath;
  field: StructuralDiffContainerField;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  recordSegments: boolean;
}

interface NodeArrayDiffEqualWorkItem {
  kind: "equal";
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  recordSegments: boolean;
}

type NodeArrayDiffWorkItem = NodeArrayDiffRangeWorkItem | NodeArrayDiffEqualWorkItem;

const diffNodeArrays = (
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  path: StructuralDiffPath,
  field: StructuralDiffContainerField,
  accumulator: SequenceDiffAccumulator,
  oldStart = 0,
  oldEnd = previousNodes.length,
  newStart = 0,
  newEnd = nextNodes.length,
  recordSegments = path.length === 0 && field === "root",
  nestedTasks: NestedNodeArrayDiffTask[] = [],
): void => {
  const workStack: NodeArrayDiffWorkItem[] = [
    {
      kind: "range",
      previousNodes,
      nextNodes,
      path,
      field,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      recordSegments,
    },
  ];

  while (workStack.length > 0) {
    const work = workStack.pop();
    if (!work) break;

    if (work.kind === "equal") {
      appendTrailingEqualSegments(
        accumulator,
        work.recordSegments,
        work.oldStart,
        work.oldEnd,
        work.newStart,
        work.newEnd,
      );
      continue;
    }

    let oldCursor = work.oldStart;
    let newCursor = work.newStart;
    let suffixOldEnd = work.oldEnd;
    let suffixNewEnd = work.newEnd;

    while (
      oldCursor < suffixOldEnd &&
      newCursor < suffixNewEnd &&
      areNodesStructurallyEqual(work.previousNodes[oldCursor], work.nextNodes[newCursor])
    ) {
      if (work.recordSegments) {
        appendDiffSegment(accumulator.segments, "equal", oldCursor, oldCursor + 1, newCursor, newCursor + 1);
      }
      oldCursor += 1;
      newCursor += 1;
    }

    while (
      oldCursor < suffixOldEnd &&
      newCursor < suffixNewEnd &&
      areNodesStructurallyEqual(work.previousNodes[suffixOldEnd - 1], work.nextNodes[suffixNewEnd - 1])
    ) {
      suffixOldEnd -= 1;
      suffixNewEnd -= 1;
    }

    if (oldCursor === suffixOldEnd && newCursor === suffixNewEnd) {
      appendTrailingEqualSegments(
        accumulator,
        work.recordSegments,
        suffixOldEnd,
        work.oldEnd,
        suffixNewEnd,
        work.newEnd,
      );
      continue;
    }

    if (oldCursor === suffixOldEnd || newCursor === suffixNewEnd) {
      emitSpliceAndTrailingEquals(
        accumulator,
        work.recordSegments,
        work.path,
        work.field,
        work.previousNodes,
        work.nextNodes,
        oldCursor,
        suffixOldEnd,
        newCursor,
        suffixNewEnd,
        suffixOldEnd,
        work.oldEnd,
        suffixNewEnd,
        work.newEnd,
      );
      continue;
    }

    const anchors = findAnchors(work.previousNodes, work.nextNodes, oldCursor, suffixOldEnd, newCursor, suffixNewEnd);
    if (anchors.length > 0) {
      workStack.push({
        kind: "equal",
        oldStart: suffixOldEnd,
        oldEnd: work.oldEnd,
        newStart: suffixNewEnd,
        newEnd: work.newEnd,
        recordSegments: work.recordSegments,
      });
      workStack.push({
        kind: "range",
        previousNodes: work.previousNodes,
        nextNodes: work.nextNodes,
        path: work.path,
        field: work.field,
        oldStart: anchors[anchors.length - 1].oldIndex + 1,
        oldEnd: suffixOldEnd,
        newStart: anchors[anchors.length - 1].newIndex + 1,
        newEnd: suffixNewEnd,
        recordSegments: work.recordSegments,
      });
      for (let i = anchors.length - 1; i >= 0; i--) {
        const anchor = anchors[i];
        workStack.push({
          kind: "equal",
          oldStart: anchor.oldIndex,
          oldEnd: anchor.oldIndex + 1,
          newStart: anchor.newIndex,
          newEnd: anchor.newIndex + 1,
          recordSegments: work.recordSegments,
        });
        workStack.push({
          kind: "range",
          previousNodes: work.previousNodes,
          nextNodes: work.nextNodes,
          path: work.path,
          field: work.field,
          oldStart: i === 0 ? oldCursor : anchors[i - 1].oldIndex + 1,
          oldEnd: anchor.oldIndex,
          newStart: i === 0 ? newCursor : anchors[i - 1].newIndex + 1,
          newEnd: anchor.newIndex,
          recordSegments: work.recordSegments,
        });
      }
      continue;
    }

    const oldLength = suffixOldEnd - oldCursor;
    const newLength = suffixNewEnd - newCursor;
    if (oldLength === newLength) {
      for (let i = 0; i < oldLength; i++) {
        const previousIndex = oldCursor + i;
        const nextIndex = newCursor + i;
        const previousNode = work.previousNodes[previousIndex];
        const nextNode = work.nextNodes[nextIndex];
        if (areNodesStructurallyEqual(previousNode, nextNode)) {
          if (work.recordSegments) {
            appendDiffSegment(
              accumulator.segments,
              "equal",
              previousIndex,
              previousIndex + 1,
              nextIndex,
              nextIndex + 1,
            );
          }
          continue;
        }
        if (canDiffNodesRecursively(previousNode, nextNode)) {
          if (work.recordSegments) {
            appendDiffSegment(
              accumulator.segments,
              "change",
              previousIndex,
              previousIndex + 1,
              nextIndex,
              nextIndex + 1,
            );
          }
          const nextPath = appendPathSegment(work.path, work.field, previousIndex);
          if (previousNode.type === "text" && nextNode.type === "text") {
            accumulator.ops.push({
              kind: "set-text",
              path: nextPath,
              oldValue: previousNode.value,
              newValue: nextNode.value,
            });
          } else if (previousNode.type === "escape" && nextNode.type === "escape") {
            accumulator.ops.push({
              kind: "set-escape",
              path: nextPath,
              oldValue: previousNode.raw,
              newValue: nextNode.raw,
            });
          } else if (previousNode.type === "raw" && nextNode.type === "raw") {
            if (previousNode.content !== nextNode.content) {
              accumulator.ops.push({
                kind: "set-raw-content",
                path: nextPath,
                oldValue: previousNode.content,
                newValue: nextNode.content,
              });
            }
            queueNestedNodeArrayDiff(nestedTasks, previousNode.args, nextNode.args, nextPath, "args");
          } else if (previousNode.type === "inline" && nextNode.type === "inline") {
            if (!!previousNode.implicitInlineShorthand !== !!nextNode.implicitInlineShorthand) {
              accumulator.ops.push({
                kind: "set-implicit-inline-shorthand",
                path: nextPath,
                oldValue: previousNode.implicitInlineShorthand,
                newValue: nextNode.implicitInlineShorthand,
              });
            }
            queueNestedNodeArrayDiff(
              nestedTasks,
              previousNode.children,
              nextNode.children,
              nextPath,
              "children",
            );
          } else if (previousNode.type === "block" && nextNode.type === "block") {
            queueNestedNodeArrayDiff(nestedTasks, previousNode.args, nextNode.args, nextPath, "args");
            queueNestedNodeArrayDiff(
              nestedTasks,
              previousNode.children,
              nextNode.children,
              nextPath,
              "children",
            );
          }
        } else {
          emitSplice(
            accumulator,
            work.recordSegments,
            work.path,
            work.field,
            work.previousNodes,
            work.nextNodes,
            previousIndex,
            previousIndex + 1,
            nextIndex,
            nextIndex + 1,
          );
        }
      }
      appendTrailingEqualSegments(
        accumulator,
        work.recordSegments,
        suffixOldEnd,
        work.oldEnd,
        suffixNewEnd,
        work.newEnd,
      );
      continue;
    }

    emitSpliceAndTrailingEquals(
      accumulator,
      work.recordSegments,
      work.path,
      work.field,
      work.previousNodes,
      work.nextNodes,
      oldCursor,
      suffixOldEnd,
      newCursor,
      suffixNewEnd,
      suffixOldEnd,
      work.oldEnd,
      suffixNewEnd,
      work.newEnd,
    );
  }
};

const processNestedNodeArrayDiffs = (
  nestedTasks: NestedNodeArrayDiffTask[],
  accumulator: SequenceDiffAccumulator,
): void => {
  while (nestedTasks.length > 0) {
    const task = nestedTasks.pop();
    if (!task) break;
    diffNodeArrays(
      task.previousNodes,
      task.nextNodes,
      task.path,
      task.field,
      accumulator,
      0,
      task.previousNodes.length,
      0,
      task.nextNodes.length,
      false,
      nestedTasks,
    );
  }
};

const resolveDirtySpan = (
  nodes: readonly StructuralNode[],
  startIndex: number,
  endIndex: number,
  fallbackStart: number,
  fallbackEnd: number,
): { startOffset: number; endOffset: number } => {
  if (startIndex >= endIndex) {
    return { startOffset: fallbackStart, endOffset: fallbackEnd };
  }

  let startOffset: number | undefined;
  for (let i = startIndex; i < endIndex; i++) {
    const position = nodes[i].position;
    if (!position) continue;
    startOffset = position.start.offset;
    break;
  }

  let endOffset: number | undefined;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const position = nodes[i].position;
    if (!position) continue;
    endOffset = position.end.offset;
    break;
  }

  if (startOffset === undefined || endOffset === undefined || startOffset > endOffset) {
    return { startOffset: fallbackStart, endOffset: fallbackEnd };
  }
  return { startOffset, endOffset };
};

const buildConservativeTokenDiff = (
  previousDoc: IncrementalDocument,
  nextDoc: IncrementalDocument,
): TokenDiffResult => {
  const previousCount = previousDoc.tree.length;
  const nextCount = nextDoc.tree.length;
  const patches: TokenDiffPatch[] = [];
  if (!(previousCount === 0 && nextCount === 0)) {
    patches.push({
      kind: previousCount === 0 ? "insert" : nextCount === 0 ? "remove" : "replace",
      oldRange: { start: 0, end: previousCount },
      newRange: { start: 0, end: nextCount },
    });
  }
  return {
    isNoop: previousCount === 0 && nextCount === 0,
    patches,
    unchangedRanges: [],
    ops:
      previousCount === 0 && nextCount === 0
        ? []
        : [
            {
              kind: "splice",
              path: [],
              field: "root",
              oldRange: { start: 0, end: previousCount },
              newRange: { start: 0, end: nextCount },
              oldNodes: previousDoc.tree.slice(),
              newNodes: nextDoc.tree.slice(),
            },
          ],
    dirtySpanOld: { startOffset: 0, endOffset: previousDoc.source.length },
    dirtySpanNew: { startOffset: 0, endOffset: nextDoc.source.length },
  };
};

const computeTokenDiff = (
  previousTree: readonly StructuralNode[],
  nextTree: readonly StructuralNode[],
  edit: IncrementalEdit,
): TokenDiffResult => {
  const accumulator: SequenceDiffAccumulator = { segments: [], ops: [] };
  const nestedTasks: NestedNodeArrayDiffTask[] = [];
  diffNodeArrays(previousTree, nextTree, [], "root", accumulator, 0, previousTree.length, 0, nextTree.length, true, nestedTasks);
  processNestedNodeArrayDiffs(nestedTasks, accumulator);

  const unchangedRanges: TokenDiffUnchangedRange[] = [];
  const patches: TokenDiffPatch[] = [];
  // Return ops in descending path/index order so consumers can apply them
  // in array order without later splice targets being invalidated by index shifts.
  const ops = accumulator.ops.slice().sort(compareStructuralDiffOpsDescending);
  let firstChangedSegment: SequenceDiffSegment | undefined;
  let lastChangedSegment: SequenceDiffSegment | undefined;

  for (const segment of accumulator.segments) {
    if (segment.kind === "equal") {
      unchangedRanges.push({
        oldRange: { start: segment.oldRange.start, end: segment.oldRange.end },
        newRange: { start: segment.newRange.start, end: segment.newRange.end },
      });
      continue;
    }

    if (!firstChangedSegment) {
      firstChangedSegment = segment;
    }
    lastChangedSegment = segment;
    const oldLength = segment.oldRange.end - segment.oldRange.start;
    const newLength = segment.newRange.end - segment.newRange.start;
    if (oldLength === 0) {
      patches.push({
        kind: "insert",
        oldRange: { start: segment.oldRange.start, end: segment.oldRange.end },
        newRange: { start: segment.newRange.start, end: segment.newRange.end },
      });
    } else if (newLength === 0) {
      patches.push({
        kind: "remove",
        oldRange: { start: segment.oldRange.start, end: segment.oldRange.end },
        newRange: { start: segment.newRange.start, end: segment.newRange.end },
      });
    } else {
      patches.push({
        kind: "replace",
        oldRange: { start: segment.oldRange.start, end: segment.oldRange.end },
        newRange: { start: segment.newRange.start, end: segment.newRange.end },
      });
    }
  }

  const oldChangedStart = firstChangedSegment ? firstChangedSegment.oldRange.start : 0;
  const oldChangedEnd = lastChangedSegment ? lastChangedSegment.oldRange.end : 0;
  const newChangedStart = firstChangedSegment ? firstChangedSegment.newRange.start : 0;
  const newChangedEnd = lastChangedSegment ? lastChangedSegment.newRange.end : 0;

  const dirtySpanOld = resolveDirtySpan(
    previousTree,
    oldChangedStart,
    oldChangedEnd,
    edit.startOffset,
    edit.oldEndOffset,
  );
  const dirtySpanNew = resolveDirtySpan(
    nextTree,
    newChangedStart,
    newChangedEnd,
    edit.startOffset,
    edit.startOffset + edit.newText.length,
  );

  return {
    isNoop: patches.length === 0 && ops.length === 0,
    patches,
    unchangedRanges,
    ops,
    dirtySpanOld,
    dirtySpanNew,
  };
};

// ── 节点位置平移 ──
//
// 右侧 zone 的节点 position 需要加 delta（新文档比旧文档长/短了多少）。
// createShiftedNodeShell 只创建节点壳（平移 position，子节点留空）。
// shiftNode 用显式栈迭代，避免递归爆栈。

const shiftPosition = (
  position: SourcePosition | undefined,
  delta: number,
  tracker: PositionTracker,
): SourcePosition | undefined => {
  if (!position) return undefined;
  return tracker.resolve(position.offset + delta);
};

const assertUnreachable = (value: never): never => {
  throw new Error(`shiftNode(): unexpected node type: ${String((value as { type?: unknown }).type)}`);
};

const createShiftedNodeShell = (
  node: StructuralNode,
  delta: number,
  tracker: PositionTracker,
): StructuralNode => {
  const position = node.position
    ? {
        start: shiftPosition(node.position.start, delta, tracker)!,
        end: shiftPosition(node.position.end, delta, tracker)!,
      }
    : undefined;

  if (node.type === "text") return { type: "text", value: node.value, position };
  if (node.type === "escape") return { type: "escape", raw: node.raw, position };
  if (node.type === "separator") return { type: "separator", position };
  if (node.type === "inline") return { type: "inline", tag: node.tag, children: [], position };
  if (node.type === "raw") return { type: "raw", tag: node.tag, args: [], content: node.content, position };
  if (node.type === "block") return { type: "block", tag: node.tag, args: [], children: [], position };
  return assertUnreachable(node);
};

const shiftNode = (node: StructuralNode, delta: number, tracker: PositionTracker): StructuralNode => {
  const root = createShiftedNodeShell(node, delta, tracker);
  const stack: Array<{ source: StructuralNode; target: StructuralNode }> = [{ source: node, target: root }];

  const appendShiftedNodes = (
    sourceNodes: readonly StructuralNode[],
    targetNodes: StructuralNode[],
  ): void => {
    for (let i = 0; i < sourceNodes.length; i++) {
      const sourceNode = sourceNodes[i];
      const targetNode = createShiftedNodeShell(sourceNode, delta, tracker);
      targetNodes.push(targetNode);
      if (sourceNode.type === "inline" || sourceNode.type === "raw" || sourceNode.type === "block") {
        stack.push({ source: sourceNode, target: targetNode });
      }
    }
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { source, target } = frame;

    if (source.type === "text" || source.type === "escape" || source.type === "separator") continue;

    if (source.type === "inline" && target.type === "inline") {
      appendShiftedNodes(source.children, target.children);
    } else if (source.type === "raw" && target.type === "raw") {
      appendShiftedNodes(source.args, target.args);
    } else if (source.type === "block" && target.type === "block") {
      appendShiftedNodes(source.args, target.args);
      appendShiftedNodes(source.children, target.children);
    } else {
      throw new Error(`shiftNode(): unsupported frame source type: ${source.type}`);
    }
  }

  return root;
};

// ── 懒 delta 平移（1.2.4+）──
//
// 核心思路：右侧 zone 不立即深拷贝节点树，只记一个数字（delta）。
// zone 的 startOffset/endOffset 立刻更新（O(1)），
// 但节点的 position 延迟到消费者真正读 doc.tree / doc.zones 时才物化。
//
// 好处：
// - 头部连续编辑只叠加 delta，不触发中间物化
// - 如果消费者只关心 source 不关心 tree，右侧零成本
//
// 实现：
// - zonePendingDeltaMap: zone → 待物化的累积 delta
// - rawZonesMap: doc → 原始（未物化）zone 数组，供增量内部逻辑用
// - installLazyDocument: 用 Object.defineProperty 在 doc 上挂 lazy getter

const zonePendingDeltaMap = new WeakMap<Zone, number>();

// O(1) 延迟平移：创建新 zone 壳（offset 已更新），节点引用共享，delta 存 WeakMap。
// 如果 zone 已经有 pending delta，新 delta 叠加上去。
const deferShiftZone = (zone: Zone, delta: number): Zone => {
  const existingDelta = zonePendingDeltaMap.get(zone) ?? 0;
  const newZone: Zone = {
    startOffset: zone.startOffset + delta,
    endOffset: zone.endOffset + delta,
    nodes: zone.nodes,
  };
  const totalDelta = existingDelta + delta;
  if (totalDelta !== 0) {
    zonePendingDeltaMap.set(newZone, totalDelta);
  }
  const sig = zoneSignatureCache.get(zone);
  if (sig !== undefined) zoneSignatureCache.set(newZone, sig);
  return newZone;
};

// 物化：把 pending delta 应用到每个节点的 position 上，返回新 zone。
// 没有 pending delta 的 zone 原样返回（已经是物化状态）。
const materializeZone = (zone: Zone, tracker: PositionTracker): Zone => {
  const delta = zonePendingDeltaMap.get(zone);
  if (delta === undefined) return zone;
  const materialized: Zone = {
    startOffset: zone.startOffset,
    endOffset: zone.endOffset,
    nodes: zone.nodes.map((n) => shiftNode(n, delta, tracker)),
  };
  const sig = zoneSignatureCache.get(zone);
  if (sig !== undefined) zoneSignatureCache.set(materialized, sig);
  return materialized;
};

// 内部逻辑用 getRawZones 拿未物化的 zone——zone offset 是对的，
// 只有节点 position 可能是旧的，但增量逻辑只看 zone offset，不看节点 position。
const rawZonesMap = new WeakMap<IncrementalDocument, readonly Zone[]>();

const getRawZones = (doc: IncrementalDocument): readonly Zone[] => rawZonesMap.get(doc) ?? doc.zones;

const installLazyDocument = (
  doc: IncrementalDocument,
  rawZones: readonly Zone[],
  tracker: PositionTracker,
): void => {
  rawZonesMap.set(doc, rawZones);
  let materializedZones: Zone[] | undefined;
  let materializedTree: StructuralNode[] | undefined;
  Object.defineProperty(doc, "zones", {
    get() {
      if (!materializedZones) {
        materializedZones = rawZones.map((z) => materializeZone(z, tracker));
      }
      return materializedZones;
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(doc, "tree", {
    get() {
      if (!materializedTree) {
        materializedTree = flattenZones(doc.zones);
      }
      return materializedTree;
    },
    enumerable: true,
    configurable: true,
  });
};

// ── 增量更新核心 ──

// 找脏 zone 区间：哪些 zone 与编辑范围重叠？
// 有重叠 → [firstOverlap - 1, lastOverlap + 1]（左右各扩一格）
// 纯插入无重叠 → 从插入点邻居开始，左回看一格
const findDirtyRange = (zones: readonly Zone[], edit: IncrementalEdit): { from: number; to: number } => {
  let firstOverlap = -1;
  let lastOverlap = -1;
  // 单遍扫描：同时追踪 overlap 和 insertionIndex，避免 no-overlap 时二次遍历。
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

// 循环重解析脏窗，直到右边界稳定或超预算。
// "稳定"的意思是：重解析产出的最后一个 zone 的 endOffset 恰好等于脏窗的 endOffset。
// 不稳定 → 右边扩一个 zone，再来一轮。
// 预算守卫：cumulative 重解析字节数超过 2·n → 放弃，返回 budgetExceeded=true，
// 调用方会直接 full rebuild。这保证了脏窗扩展不会变成 O(n²)。
const reparseDirtyWindowUntilStable = (
  zones: readonly Zone[],
  dirtyFrom: number,
  dirtyTo: number,
  edit: IncrementalEdit,
  delta: number,
  newSource: string,
  tracker: PositionTracker,
  parseOptions: IncrementalParseOptions | undefined,
  cumulativeBudget: number,
  cumulativeReparsedBytes: number,
  zoneCap: number,
): {
  budgetExceeded: boolean;
  dirtyTo: number;
  dirtyZones: Zone[];
  cumulativeReparsedBytes: number;
} => {
  let nextDirtyTo = dirtyTo;
  let nextDirtyZones: Zone[] = [];
  let nextCumulativeReparsedBytes = cumulativeReparsedBytes;

  while (true) {
    const dirtyStartOld = zones[dirtyFrom].startOffset;
    const dirtyEndOld = zones[nextDirtyTo].endOffset;
    const dirtyStartNew = mapOldOffsetToNew(edit, delta, dirtyStartOld);
    const dirtyEndNew = mapOldOffsetToNew(edit, delta, dirtyEndOld);
    const reparsedWindowSize = dirtyEndNew - dirtyStartNew;
    nextCumulativeReparsedBytes += reparsedWindowSize;
    if (nextCumulativeReparsedBytes > cumulativeBudget) {
      return {
        budgetExceeded: true,
        dirtyTo: nextDirtyTo,
        dirtyZones: nextDirtyZones,
        cumulativeReparsedBytes: nextCumulativeReparsedBytes,
      };
    }

    const dirtyTree = parseWithPositions(
      newSource.slice(dirtyStartNew, dirtyEndNew),
      tracker,
      parseOptions,
      dirtyStartNew,
    );
    nextDirtyZones = buildZonesInternal(dirtyTree, zoneCap);

    const reparsedEnd =
      nextDirtyZones.length > 0 ? nextDirtyZones[nextDirtyZones.length - 1].endOffset : dirtyStartNew;
    if (reparsedEnd === dirtyEndNew || nextDirtyTo === zones.length - 1) {
      return {
        budgetExceeded: false,
        dirtyTo: nextDirtyTo,
        dirtyZones: nextDirtyZones,
        cumulativeReparsedBytes: nextCumulativeReparsedBytes,
      };
    }
    nextDirtyTo += 1;
  }
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
//
// 首次解析 / full rebuild 都走这里。
// 全量解析一次性产出完整快照：tree + zones + signature 缓存 + options snapshot。

// 内部版本：接受 zoneCap 参数，session / updateInternal 通过此参数传递用户配置。
// existingTracker: fallback 路径可传入已构建的 tracker 以避免重复构建。
const parseIncrementalInternal = (
  source: string,
  options: IncrementalParseOptions | undefined,
  zoneCap: number,
  existingTracker?: PositionTracker,
): IncrementalDocument => {
  const tracker = existingTracker ?? buildPositionTracker(source);
  const tree = parseWithPositions(source, tracker, options);
  const zones = buildZonesInternal(tree, zoneCap);
  for (let i = 0; i < zones.length; i++) {
    zoneSignature(zones[i]);
  }
  const parseOptions = cloneParseOptions(options);
  const fingerprint = buildParseOptionsFingerprint(parseOptions);
  const doc = {
    source,
    tree,
    zones,
    parseOptions,
  };
  setCachedOptionsFingerprint(doc, fingerprint);
  return doc;
};

/**
 * Build an incremental document snapshot from full source.
 *
 * Use this as the initial state for low-level incremental updates.
 *
 * @example
 * ```ts
 * const doc = parseIncremental("=bold<hello>=");
 * // doc.tree / doc.zones / doc.parseOptions are ready for reuse
 * ```
 */
export const parseIncremental = (
  source: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => parseIncrementalInternal(source, options, SOFT_ZONE_NODE_CAP);

// ── 增量更新主流程 ──
//
// 这是整个增量解析的核心函数。流程：
// 1. assertValidEdit       — 编辑合法性校验
// 2. fingerprint 比对       — 配置变了？→ full rebuild
// 3. findDirtyRange        — 找脏 zone 区间
// 4. reparseDirtyWindow    — 循环重解析直到右边界稳定（有预算守卫）
// 5. isSafeRightReuse      — seam probe 验证拼接缝
// 6. deferShiftZone        — 右侧 zone lazy delta 平移
// 7. installLazyDocument   — 拼接新快照，挂 lazy getter
//
// 任何一步判定"不安全" → fullRebuild() 兜底，保证正确性优先。

/**
 * Update an incremental structural snapshot with one edit and a new full source.
 *
 * @experimental
 * Low-level updater for controlled integration paths.
 * For production applications, prefer `createIncrementalSession(...).applyEdit(...)`,
 * which guarantees fallback to full rebuild on errors.
 *
 * Assumption:
 * - Left boundary stabilization is conservative but fixed to one-zone lookbehind.
 * - Right boundary is expanded until stable (or EOF).
 *
 * If your edit may invalidate parsing state further left than one zone, prefer a full
 * rebuild via `parseIncremental(newSource, options)` for correctness.
 *
 */
const updateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options: IncrementalParseOptions | undefined,
  __internalObserver: InternalUpdateObserver | undefined,
  zoneCap: number,
): IncrementalDocument => {
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
    __internalObserver?.("internal-full-rebuild");
    return rebuilt;
  };

  const prevZones = getRawZones(doc);

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
    __internalObserver?.("internal-full-rebuild");
    return rebuilt;
  };
  const cumulativeBudget = Math.max(newSource.length * 2, 1024);

  const delta = newSource.length - doc.source.length;
  const dirty = findDirtyRange(prevZones, edit);

  let dirtyFrom = dirty.from;
  let dirtyTo = dirty.to;
  let dirtyZones: Zone[] = [];

  const firstReparse = reparseDirtyWindowUntilStable(
    prevZones,
    dirtyFrom,
    dirtyTo,
    edit,
    delta,
    newSource,
    newTracker,
    runtimeParseOptions,
    cumulativeBudget,
    cumulativeReparsedBytes,
    zoneCap,
  );
  cumulativeReparsedBytes = firstReparse.cumulativeReparsedBytes;
  if (firstReparse.budgetExceeded) return fullRebuild();
  dirtyTo = firstReparse.dirtyTo;
  dirtyZones = firstReparse.dirtyZones;

  const leftZones = prevZones.slice(0, dirtyFrom);
  const oldRightZones = prevZones.slice(dirtyTo + 1);
  if (oldRightZones.length > 0) {
    const seamOldOffset = oldRightZones[0].startOffset;
    const seamNewOffset = mapOldOffsetToNew(edit, delta, seamOldOffset);
    const rightReuseCheck = isSafeRightReuse(
      oldRightZones,
      newSource,
      seamNewOffset,
      delta,
      newTracker,
      runtimeParseOptions,
      zoneCap,
    );
    probeSliceBytes = rightReuseCheck.probeSliceBytes;
    if (!rightReuseCheck.ok) return fullRebuild();
  }
  const rightZones = oldRightZones.map((zone) => deferShiftZone(zone, delta));

  const nextRawZones = [...leftZones, ...dirtyZones, ...rightZones];

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
  __internalObserver?.("incremental");
  return updated;
};

// 公共增量更新入口（不暴露 __internalObserver）。
export const updateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => updateIncrementalInternal(doc, edit, newSource, options, undefined, SOFT_ZONE_NODE_CAP);

// Result 风格的增量更新：不抛异常，返回 { ok, value } | { ok, error }。
// session 内部走这条路径，方便统一处理错误 → full rebuild 兜底。
/**
 * @experimental
 * Low-level result-style updater.
 * For production applications, prefer `createIncrementalSession(...).applyEdit(...)`.
 *
 */
const tryUpdateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options: IncrementalParseOptions | undefined,
  __internalObserver: InternalUpdateObserver | undefined,
  zoneCap: number,
): IncrementalUpdateResult => {
  try {
    return {
      ok: true,
      value: updateIncrementalInternal(doc, edit, newSource, options, __internalObserver, zoneCap),
    };
  } catch (error) {
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

export const tryUpdateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalUpdateResult => tryUpdateIncrementalInternal(doc, edit, newSource, options, undefined, SOFT_ZONE_NODE_CAP);

// ── Session（有状态会话 + 自适应策略）──
//
// createIncrementalSession 是生产级入口。它在 updateIncremental 外面包了一层：
// - 自动 full-rebuild 兜底（增量失败不会抛到调用方）
// - auto 策略：滑动窗口采样，如果增量频繁 fallback 或比 full 还慢 → 自动切 full 模式
// - cooldown 机制：切到 full 后连续 N 次编辑保持 full，避免反复抖动
//
// 闭包状态：
// - currentDoc: 当前快照
// - incrementalDurations / fullDurations / fallbackMarks: 滑动窗口采样数组（上限 sampleWindowSize）
// - preferFullMode / cooldownRemaining: auto 策略状态机
//
// 所有采样数组大小被 sampleWindowSize 钳住（默认 24），
// 所以 session 每次编辑的额外开销是 O(1)，不随文档大小增长。

/**
 * Create a stateful incremental parsing session with automatic fallback strategy.
 *
 * This is the recommended production entrypoint for incremental parsing.
 *
 * @example
 * ```ts
 * const session = createIncrementalSession("=bold<hello>=");
 * const next = session.applyEdit({
 *   startOffset: 6,
 *   oldEndOffset: 11,
 *   newText: "world",
 * });
 * ```
 */
export const createIncrementalSession = (
  source: string,
  options?: IncrementalParseOptions,
  sessionOptions?: IncrementalSessionOptions,
): IncrementalSession => {
  const zoneCap = normalizeSoftZoneNodeCap(sessionOptions?.softZoneNodeCap);
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
      enterFullPreference();
      return;
    }

    if (fullDurations.length < minSamplesForAdaptation) return;
    const avgIncrementalMs = average(incrementalDurations);
    const avgFullMs = average(fullDurations);
    if (avgIncrementalMs > avgFullMs * switchToFullMultiplier) {
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
  ): { previousDoc: IncrementalDocument; result: IncrementalSessionApplyResult } => {
    const previousDoc = currentDoc;
    let result: IncrementalSessionApplyResult;
    if (strategy === "full-only") {
      result = runRebuild(newSource, nextOptions, "FULL_ONLY_STRATEGY");
      return { previousDoc, result };
    }

    const previousLength = Math.max(1, currentDoc.source.length);
    const replacedLength = Math.max(0, edit.oldEndOffset - edit.startOffset);
    const writtenLength = edit.newText.length;
    const editRatio = Math.max(replacedLength, writtenLength) / previousLength;

    if (strategy === "auto" && editRatio > maxEditRatioForIncremental) {
      result = runRebuild(newSource, nextOptions, "AUTO_LARGE_EDIT");
      maybeAdaptPolicy();
      return { previousDoc, result };
    }

    if (strategy === "auto" && preferFullMode && cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      if (cooldownRemaining === 0) {
        preferFullMode = false;
      }
      result = runRebuild(newSource, nextOptions, "AUTO_COOLDOWN");
      maybeAdaptPolicy();
      return { previousDoc, result };
    }

    const incrementalStart = now();
    let mode: InternalUpdateMode | undefined;
    const updateResult = tryUpdateIncrementalInternal(
      currentDoc,
      edit,
      newSource,
      nextOptions,
      (nextTelemetry) => {
        mode = nextTelemetry;
      },
      zoneCap,
    );
    const incrementalElapsedMs = now() - incrementalStart;
    recordBounded(incrementalDurations, incrementalElapsedMs);

    if (updateResult.ok) {
      currentDoc = updateResult.value;
      const internalFullRebuild = mode === "internal-full-rebuild";
      recordBounded(fallbackMarks, internalFullRebuild ? 1 : 0);
      maybeAdaptPolicy();
      if (internalFullRebuild) {
        result = {
          doc: currentDoc,
          mode: "full-fallback",
          fallbackReason: "INTERNAL_FULL_REBUILD",
        };
        return { previousDoc, result };
      }
      result = {
        doc: currentDoc,
        mode: "incremental",
      };
      return { previousDoc, result };
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
  ): IncrementalSessionApplyWithDiffResult => {
    const { previousDoc, result } = applyEditCore(edit, newSource, nextOptions);
    let diff: TokenDiffResult;
    try {
      diff = computeTokenDiff(previousDoc.tree, result.doc.tree, edit);
    } catch (_error) {
      // Diff refinement must never break session advancement; fall back to a
      // conservative whole-tree diff when structural refinement fails.
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
