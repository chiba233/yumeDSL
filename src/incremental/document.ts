import { parseStructural } from "../core/structural.js";
import { fnv1a, fnvFeedStringBounded, fnvFeedU32, fnvInit } from "../internal/hash.js";
import { buildPositionTracker } from "../internal/positions.js";
import { buildZonesInternal, SOFT_ZONE_NODE_CAP } from "../internal/zones.js";
import type {
  IncrementalDocument,
  IncrementalEdit,
  IncrementalParseOptions,
  PositionTracker,
  StructuralNode,
  Zone,
} from "../types";
import { buildParseOptionsFingerprint, cloneParseOptions } from "./options.js";

// ── 指纹 & 签名 ──
//
// 指纹（fingerprint）：用于判断"配置是否变了"。
// 配置变了 → 必须 full rebuild，因为 handler/syntax 不同会导致解析结果完全不同。
//
// 签名（signature）：用于判断"节点/zone 结构是否一致"。
// seam probe 时比对新旧 zone 签名，不一致 → 右侧不能复用。
//
// 两者都基于 FNV-1a hash，但用途不同，别混。
// 一个常见误区是想"既然 fingerprint 没变，就说明右侧可复用"：
// 这是错的。fingerprint 只说明配置没变，不说明编辑之后拼接缝右边的解析结果还一致。
// 右侧能不能复用，只能靠 seam probe + signature 来判断。

// 右侧复用安全门：
// 增量更新只在 seam probe 确认拼接缝两侧结构稳定后，才复用右侧 zone。
// probe 失败 → full rebuild，宁可多做也不冒误复用的风险。

// 左回看 1 个 zone：编辑可能影响前一个 zone 的闭合边界。
const LEFT_LOOKBEHIND_ZONES = 1;
// probe 比对 2 个 zone，额外多解析 1 个 zone 作为上下文窗口。
const RIGHT_REUSE_PROBE_ZONES = 2;
const RIGHT_REUSE_PROBE_EXTRA_ZONES = 1;
// 单次 probe 的节点签名预算——超了就放弃 probe，直接 full rebuild。
const RIGHT_REUSE_PROBE_SIGNATURE_NODE_BUDGET = 4096;
// 这里故意保守：预算用完就 rebuild，而不是继续硬算。
// 否则极大文档在 seam probe 阶段就可能把所谓"增量更新"拖回高成本路径。

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
// 这些 WeakMap 只缓存内部生成的不可变快照/zone/node。
// 不要把它们理解成"可以拿来缓存任意用户对象"：用户对象是可变的，语义完全不同。

// 签名预算：seam probe 时限制签名计算的节点数，防止巨型树拖慢 probe。
type SignatureBudget = {
  remaining: number;
};

// hashText：tag 名称等短字符串，直接全量 FNV-1a（很便宜）。
const hashText = (value: string): number => fnv1a(value);
// hashTextBounded：text/raw content 等可能很长的字符串，
// 只 hash 首尾各 32 字符（O(1) 有界），在速度和误判率之间取平衡。
const hashTextBounded = (hash: number, value: string): number => fnvFeedStringBounded(hash, value);

const describeNodeType = (node: Pick<StructuralNode, "type">): StructuralNode["type"] => node.type;

const assertUnreachableNode = (value: never): never => {
  throw new Error(`nodeSignature(): unexpected node type: ${describeNodeType(value)}`);
};

/**
 * Parse a source slice into structural nodes with position tracking enabled.
 *
 * Used by both full builds and bounded reparses. When `baseOffset` and a
 * tracker from the original full document are provided, the resulting node
 * positions point back to the original document rather than the slice.
 */
export const parseWithPositions = (
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
/** Flatten top-level zones back into the public structural root node array. */
export const flattenZones = (zones: readonly Zone[]): StructuralNode[] => {
  const tree: StructuralNode[] = [];
  for (const zone of zones) {
    tree.push(...zone.nodes);
  }
  return tree;
};

/**
 * Normalize the user-provided soft-zone node cap.
 *
 * Returns the package default for invalid input and clamps values to a safe
 * minimum so a "soft zone" still contains meaningful structure.
 */
export const normalizeSoftZoneNodeCap = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return SOFT_ZONE_NODE_CAP;
  return Math.max(2, Math.floor(value));
};

/** Read the cached parse-options fingerprint attached to one incremental document. */
export const getCachedOptionsFingerprint = (doc: IncrementalDocument): number | undefined =>
  parseOptionsFingerprintCache.get(doc);

/** Store the parse-options fingerprint for one incremental document snapshot. */
export const setCachedOptionsFingerprint = (doc: IncrementalDocument, fingerprint: number): void => {
  parseOptionsFingerprintCache.set(doc, fingerprint);
};

/** Read the cached structural signature for one zone when available. */
export const getCachedZoneSignature = (zone: Zone): number | undefined => zoneSignatureCache.get(zone);

/** Store a structural signature for one zone. */
export const setCachedZoneSignature = (zone: Zone, signature: number): void => {
  zoneSignatureCache.set(zone, signature);
};

const tryConsumeSignatureBudget = (budget: SignatureBudget): boolean => {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
};

// 节点结构签名：hash(类型标签 + tag名 + 子节点/arg 数量 + content 长度 + bounded 内容采样)。
// 纯结构比对不需要全量 hash content，但纯长度又有"同长不同内容"盲区，
// 所以折中用 bounded sampling（首尾 32 字符）——O(1) 且几乎不会误判。
export const nodeSignature = (node: StructuralNode, budget?: SignatureBudget): number | undefined => {
  // 只有"无预算限制"的常规路径才写缓存。
  // seam probe 的 budget 路径若把半途失败的中间结果写进缓存，反而会污染后续判断。
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
        const hash = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_TEXT), current.value.length);
        valueStack.push(hashTextBounded(hash, current.value) >>> 0);
        continue;
      }
      if (current.type === "escape") {
        const hash = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_ESCAPE), current.raw.length);
        valueStack.push(hashTextBounded(hash, current.raw) >>> 0);
        continue;
      }
      if (current.type === "inline") {
        let hash = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_INLINE), hashText(current.tag));
        hash = fnvFeedU32(hash, current.implicitInlineShorthand ? 1 : 0);
        hash = fnvFeedU32(hash, current.children.length);
        frameStack.push({ kind: "exit", hash, valueBase: valueStack.length });
        for (let i = current.children.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.children[i] });
        }
        continue;
      }
      if (current.type === "raw") {
        let hash = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_RAW), hashText(current.tag));
        hash = fnvFeedU32(hash, current.args.length);
        hash = fnvFeedU32(hash, current.content.length);
        hash = hashTextBounded(hash, current.content);
        frameStack.push({ kind: "exit", hash, valueBase: valueStack.length });
        for (let i = current.args.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.args[i] });
        }
        continue;
      }
      if (current.type === "block") {
        let hash = fnvFeedU32(fnvFeedU32(fnvInit(), NODE_TAG_BLOCK), hashText(current.tag));
        hash = fnvFeedU32(hash, current.args.length);
        hash = fnvFeedU32(hash, current.children.length);
        frameStack.push({ kind: "exit", hash, valueBase: valueStack.length });
        for (let i = current.children.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.children[i] });
        }
        for (let i = current.args.length - 1; i >= 0; i--) {
          frameStack.push({ kind: "enter", node: current.args[i] });
        }
        continue;
      }
      return assertUnreachableNode(current);
    }

    let hash = frame.hash;
    for (let i = frame.valueBase; i < valueStack.length; i++) {
      hash = fnvFeedU32(hash, valueStack[i]);
    }
    valueStack.length = frame.valueBase;
    valueStack.push(hash >>> 0);
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
export const zoneSignature = (zone: Zone, budget?: SignatureBudget): number | undefined => {
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

// 安全检查：编辑范围超出最后一个 zone 的覆盖 → 快照状态不可信，必须 full rebuild。
/**
 * Detect whether an edit reaches beyond the last known zone boundary.
 *
 * When this happens the cached incremental snapshot is treated as unsafe for
 * bounded reuse and the caller should rebuild from scratch.
 */
export const hasUnsafeZoneCoverageTailGap = (zones: readonly Zone[], edit: IncrementalEdit): boolean => {
  const lastZone = zones[zones.length - 1];
  if (!lastZone) return false;
  return edit.startOffset > lastZone.endOffset || edit.oldEndOffset > lastZone.endOffset;
};

// seam probe（拼接缝探测）：
// 在新旧文档的拼接边界，取右侧前几个 zone 的范围重新解析，
// 把解析结果的签名和旧 zone 签名逐一比对。
// 全部匹配 → 右侧可以安全复用；任何一个不匹配 → full rebuild。
// 这是"宁可多 rebuild 也不误复用"的保守策略。
// 注意这里不是做"最佳努力复用"：只要有一点不确定，就直接判失败。
// 因为右侧误复用的代价比一次 full rebuild 大得多——那会把错误结构带到后续每一代快照里。
/**
 * Probe whether right-side zones may be safely reused after an edit.
 *
 * The check reparses a small seam window in the new source and compares both
 * offsets and structural signatures against the cached right-side zones.
 */
export const isSafeRightReuse = (
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
/**
 * Map an old-source offset into the new-source coordinate space for one edit.
 *
 * Offsets strictly left of the edit stay unchanged, offsets right of the edit
 * shift by `delta`, and offsets inside the replaced range collapse to the new
 * insertion tail.
 */
export const mapOldOffsetToNew = (edit: IncrementalEdit, delta: number, oldOffset: number): number => {
  if (oldOffset <= edit.startOffset) return oldOffset;
  if (oldOffset >= edit.oldEndOffset) return oldOffset + delta;
  return edit.startOffset + edit.newText.length;
};

// 全量解析入口（首次 / rebuild）。
// 一次性产出完整快照：tree + zones + signature 缓存 + options snapshot。
/**
 * Build a fully materialized incremental document snapshot.
 *
 * This internal entrypoint is shared by the public `parseIncremental()` API and
 * all full-rebuild fallbacks inside incremental sessions.
 */
export const parseIncrementalInternal = (
  source: string,
  options: IncrementalParseOptions | undefined,
  zoneCap: number,
  existingTracker?: PositionTracker,
): IncrementalDocument => {
  // fallback 路径允许复用已经构建好的 tracker，避免同一次更新里重复扫描整份源码。
  const tracker = existingTracker ?? buildPositionTracker(source);
  const tree = parseWithPositions(source, tracker, options);
  const zones = buildZonesInternal(tree, zoneCap);
  for (let i = 0; i < zones.length; i++) {
    zoneSignature(zones[i]);
  }
  // 这里主动预热 zone signature，不是"多做无用功"：
  // 后续增量更新一定会频繁依赖这些签名做 seam probe，提前算好可以把成本放到 full parse 时摊平。
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

export { LEFT_LOOKBEHIND_ZONES };
