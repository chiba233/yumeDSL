import type { StructuralNode, Zone } from "../types";

// ── Zone 构建器 ──
//
// 把顶层节点列表切分成连续 zone（偏移区间 + 节点数组）。
// 切分规则：
//   1. raw / block 节点是硬 zone 边界，各自独占一个 zone
//   2. 其余节点（text / escape / separator / inline）合并到一个"软 zone"
//   3. buildZonesInternal 额外接受 softNodeCap 参数：
//      软 zone 累积到上限后强制切分 → 增量解析器用此获得细粒度 zone
//
// 公开 API buildZones 不做软切分（softNodeCap = Infinity），行为与 1.2.x 完全一致。
// 切分点始终落在节点 endOffset 上 → 是合法的解析重入点，
// 不会破坏 incremental.ts 的 seam probe 不变量。

const isZoneBreaker = (node: StructuralNode): boolean =>
  node.type === "raw" || node.type === "block";

/**
 * 增量解析器内部使用的软 zone 节点数上限。
 *
 * 超过此数量的非 breaker 节点序列会被切分为多个 zone。
 * 值太小 → zone 过多，签名/缝探针开销上升；
 * 值太大 → 纯 inline 文档 zone 太少，增量退化为全量。
 * 64 在 benchmark 中平衡了两端（1MB inline 文档 ≈ 800+ zone，
 * 增量窗口控制在 ~64 节点以内）。
 *
 * @internal 仅供 incremental.ts 使用，不属于公开 API 承诺。
 */
export const SOFT_ZONE_NODE_CAP = 64;

/**
 * Group a top-level `StructuralNode[]` into contiguous zones.
 *
 * Requires nodes parsed with `trackPositions: true`.
 * Throws if the first node has no `position` (likely forgot `trackPositions`).
 *
 * Rules:
 * - Adjacent text / escape / separator / inline nodes merge into one zone
 * - Each raw or block node gets a dedicated zone
 * - A new zone starts after every raw / block node
 *
 * @example
 * ```ts
 * const tree = parser.structural(source, { trackPositions: true });
 * const zones = buildZones(tree);
 * // zones[0].nodes — first group of nodes
 * // zones[0].startOffset / endOffset — source range
 * ```
 */
export const buildZones = (nodes: readonly StructuralNode[]): Zone[] =>
  buildZonesInternal(nodes, Infinity);

/**
 * 带软切分上限的 zone 构建（内部版本）。
 *
 * `softNodeCap` 控制非 breaker 节点的累积上限：
 * - `Infinity`（公开 API buildZones 的默认值）→ 行为与 1.2.x 完全一致
 * - 有限值 → 软 zone 超过上限后自动切分，增量解析器用此获得更细粒度
 *
 * @internal
 */
export const buildZonesInternal = (
  nodes: readonly StructuralNode[],
  softNodeCap: number,
): Zone[] => {
  if (nodes.length > 0 && !nodes[0].position) {
    throw new Error(
      "buildZones(): nodes have no position info. " +
        "Parse with { trackPositions: true } before calling buildZones().",
    );
  }

  const zones: Zone[] = [];
  let pending: StructuralNode[] = [];
  let pendingStart = -1;

  // 把当前累积的非 breaker 节点 flush 成一个 zone
  const flushPending = (endOffset: number) => {
    if (pending.length === 0) return;
    zones.push({ startOffset: pendingStart, endOffset, nodes: pending });
    pending = [];
    pendingStart = -1;
  };

  for (const node of nodes) {
    const pos = node.position;
    if (!pos) continue;

    if (isZoneBreaker(node)) {
      // 硬边界：先 flush 之前积攒的软 zone，再独占一个 zone
      flushPending(pos.start.offset);
      zones.push({
        startOffset: pos.start.offset,
        endOffset: pos.end.offset,
        nodes: [node],
      });
    } else {
      if (pendingStart === -1) pendingStart = pos.start.offset;
      pending.push(node);
      // 软边界：节点数到达上限 → 切分，防止纯 inline 文档只产生一个巨型 zone
      if (pending.length >= softNodeCap) {
        flushPending(pos.end.offset);
      }
    }
  }

  // 收尾：最后一批非 breaker 节点
  if (pending.length > 0) {
    const last = pending[pending.length - 1];
    flushPending(last.position!.end.offset);
  }

  return zones;
};
