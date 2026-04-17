import type {
  IncrementalDocument,
  PositionTracker,
  SourcePosition,
  StructuralNode,
  Zone,
} from "../types";
import { flattenZones, getCachedZoneSignature, setCachedZoneSignature } from "./document.js";

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

// 节点位置平移：
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
    const frame = stack.pop();
    if (!frame) break;
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

const zonePendingDeltaMap = new WeakMap<Zone, number>();
const rawZonesMap = new WeakMap<IncrementalDocument, readonly Zone[]>();

// O(1) 延迟平移：创建新 zone 壳（offset 已更新），节点引用共享，delta 存 WeakMap。
// 如果 zone 已经有 pending delta，新 delta 叠加上去。
/**
 * Create a lazily shifted zone shell for right-side reuse.
 *
 * The returned zone has updated offsets immediately, but its node positions are
 * only materialized later if a consumer reads `doc.zones` or `doc.tree`.
 */
export const deferShiftZone = (zone: Zone, delta: number): Zone => {
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
  const signature = getCachedZoneSignature(zone);
  if (signature !== undefined) {
    setCachedZoneSignature(newZone, signature);
  }
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
    nodes: zone.nodes.map((node) => shiftNode(node, delta, tracker)),
  };
  const signature = getCachedZoneSignature(zone);
  if (signature !== undefined) {
    setCachedZoneSignature(materialized, signature);
  }
  return materialized;
};

// 内部逻辑用 getRawZones 拿未物化的 zone——zone offset 是对的，
// 只有节点 position 可能是旧的，但增量逻辑只看 zone offset，不看节点 position。
/**
 * Read the raw zone array attached to a document.
 *
 * Internal incremental logic uses this instead of `doc.zones` so it can work
 * with offset-correct but not-yet-materialized right-side reused zones.
 */
export const getRawZones = (doc: IncrementalDocument): readonly Zone[] => rawZonesMap.get(doc) ?? doc.zones;

/**
 * Install lazy `zones` and `tree` getters onto an incremental document.
 *
 * The document keeps raw reusable zones internally and materializes shifted
 * positions only when a consumer actually observes the public fields.
 */
export const installLazyDocument = (
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
        materializedZones = rawZones.map((zone) => materializeZone(zone, tracker));
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
