import type { StructuralNode, Zone } from "./types.js";

const isZoneBreaker = (node: StructuralNode): boolean =>
  node.type === "raw" || node.type === "block";

/**
 * Group a top-level `StructuralNode[]` into contiguous zones.
 *
 * Requires nodes parsed with `trackPositions: true` — nodes without
 * `position` are silently skipped.
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
export const buildZones = (nodes: readonly StructuralNode[]): Zone[] => {
  const zones: Zone[] = [];
  let pending: StructuralNode[] = [];
  let pendingStart = -1;

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
      flushPending(pos.start.offset);
      zones.push({
        startOffset: pos.start.offset,
        endOffset: pos.end.offset,
        nodes: [node],
      });
    } else {
      if (pendingStart === -1) pendingStart = pos.start.offset;
      pending.push(node);
    }
  }

  if (pending.length > 0) {
    const last = pending[pending.length - 1];
    flushPending(last.position!.end.offset);
  }

  return zones;
};
