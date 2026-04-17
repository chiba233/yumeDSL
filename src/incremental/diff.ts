import type {
  IncrementalDocument,
  IncrementalEdit,
  StructuralDiffContainerField,
  StructuralDiffOp,
  StructuralDiffPath,
  StructuralNode,
  TokenDiffPatch,
  TokenDiffResult,
  TokenDiffUnchangedRange,
} from "../types";
import { nodeSignature } from "./document.js";

// ── Token diff / Structural diff ──
//
// 目标：
// - 输出 range-based patches，便于消费者快速知道 root token 数组怎么变
// - 同时输出 path-aware ops，便于细粒度重建 nested children/args 的变化
//
// 约束：
// - ops 必须按 descending path/index 排序，消费者才能顺序应用而不被前面的 splice 破坏索引
// - 深树 diff 不能依赖递归调用栈；路径也不能每一步都复制整条数组
// - 细粒度不是第一优先级；一旦 refinement 成本或不确定性上来，就应退回 splice

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

type DiffPathNode = {
  parent: DiffPathRef;
  field: StructuralDiffContainerField;
  index: number;
  depth: number;
};

type DiffPathRef = DiffPathNode | undefined;

type NestedNodeArrayDiffTask = {
  previousNodes: readonly StructuralNode[];
  nextNodes: readonly StructuralNode[];
  path: DiffPathRef;
  field: StructuralDiffContainerField;
};

interface NodeArrayDiffRangeWorkItem {
  kind: "range";
  previousNodes: readonly StructuralNode[];
  nextNodes: readonly StructuralNode[];
  path: DiffPathRef;
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

/** Default maximum depth for nested structural diff refinement. */
export const MAX_DIFF_RECURSIVE_REFINEMENT_DEPTH = 64;
/** Full-fallback documents above this size skip expensive deep diff refinement. */
export const MAX_FULL_FALLBACK_DIFF_REFINEMENT_SOURCE_LENGTH = 20_000;

/**
 * Normalize the user-provided diff refinement depth cap.
 *
 * Invalid input falls back to the package default; valid numbers are floored
 * and clamped at zero so callers can explicitly disable nested refinement.
 */
export const normalizeDiffRefinementDepthCap = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MAX_DIFF_RECURSIVE_REFINEMENT_DEPTH;
  }
  return Math.max(0, Math.floor(value));
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

// 用 parent-linked path ref 避免深树下频繁复制完整 path 数组；
// 只有真正写入 op 时才一次性 materialize。
const materializeDiffPath = (pathRef: DiffPathRef): StructuralDiffPath => {
  if (!pathRef) return [];
  const path: StructuralDiffPath = new Array(pathRef.depth);
  let cursor: DiffPathRef = pathRef;
  for (let i = pathRef.depth - 1; i >= 0 && cursor; i--) {
    path[i] = { field: cursor.field, index: cursor.index };
    cursor = cursor.parent;
  }
  return path;
};

const emitSplice = (
  accumulator: SequenceDiffAccumulator,
  recordSegments: boolean,
  path: DiffPathRef,
  field: StructuralDiffContainerField,
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void => {
  // root patch / unchangedRanges 只应记录一次。
  // 某些分支会先把区间标成 change，随后又决定退化成 splice；
  // 那种情况下调用方必须传 recordSegments=false，避免重复记同一段 root patch。
  if (recordSegments) {
    appendDiffSegment(accumulator.segments, "change", oldStart, oldEnd, newStart, newEnd);
  }
  accumulator.ops.push({
    kind: "splice",
    path: materializeDiffPath(path),
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
  path: DiffPathRef,
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
  path: DiffPathRef,
  field: StructuralDiffContainerField,
  index: number,
): DiffPathNode => ({
  parent: path,
  field,
  index,
  depth: (path?.depth ?? 0) + 1,
});

const signaturesMatch = (previousNode: StructuralNode, nextNode: StructuralNode): boolean =>
  nodeSignature(previousNode) === nodeSignature(nextNode);

// 结构相等判断走显式栈，避免极深嵌套时递归爆栈。
const areNodesStructurallyEqual = (previousNode: StructuralNode, nextNode: StructuralNode): boolean => {
  if (previousNode === nextNode) return true;
  // signature 只负责快速剪枝；命中后仍要逐字段确认，不能把 hash 相等当成真相。
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

// 只有"同形"节点才值得做递归 diff；否则直接退化为 splice 更稳妥。
const canDiffNodesRecursively = (previousNode: StructuralNode, nextNode: StructuralNode): boolean => {
  // 这里故意不尝试"跨类型修补"。
  // 节点形状一旦变了，强行拆细只会让 op 语义更脆，直接 splice 更稳定。
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

// anchor：找 old/new 范围内唯一且结构相等的节点，作为稳定岛把大块 diff 切碎。
const findAnchors = (
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): AnchorCandidate[] => {
  // anchor 必须是唯一节点。
  // 如果重复内容也拿来当锚点，diff 很容易被切到错误位置，最终比整段 splice 更难消费。
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

const compareDiffPathsDescending = (leftPath: StructuralDiffPath, rightPath: StructuralDiffPath): number => {
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
  path: DiffPathRef,
  field: StructuralDiffContainerField,
): void => {
  nestedTasks.push({ previousNodes, nextNodes, path, field });
};

// 主 diff 循环是显式 work stack，不走递归。
const diffNodeArrays = (
  previousNodes: readonly StructuralNode[],
  nextNodes: readonly StructuralNode[],
  path: DiffPathRef,
  field: StructuralDiffContainerField,
  accumulator: SequenceDiffAccumulator,
  diffRefinementDepthCap: number,
  oldStart = 0,
  oldEnd = previousNodes.length,
  newStart = 0,
  newEnd = nextNodes.length,
  recordSegments = !path && field === "root",
  nestedTasks: NestedNodeArrayDiffTask[] = [],
): void => {
  // recordSegments 只在 root 层开启，因为 patches / unchangedRanges 只描述 root token 序列。
  // 子树变化全部交给 ops 表达；两边都记会让消费者拿到互相冲突的两套信息。
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
          const refineNested = nextPath.depth <= diffRefinementDepthCap;
          const supportsNestedRefinement =
            previousNode.type === "raw" || previousNode.type === "inline" || previousNode.type === "block";
          if (!refineNested && supportsNestedRefinement) {
            // 深度上限一到就立刻收手。
            // 不要继续往下追 set-text / set-raw-content，否则深树会把 diff 成本重新拉爆。
            emitSplice(
              accumulator,
              false,
              work.path,
              work.field,
              work.previousNodes,
              work.nextNodes,
              previousIndex,
              previousIndex + 1,
              nextIndex,
              nextIndex + 1,
            );
            continue;
          }
          if (previousNode.type === "text" && nextNode.type === "text") {
            accumulator.ops.push({
              kind: "set-text",
              path: materializeDiffPath(nextPath),
              oldValue: previousNode.value,
              newValue: nextNode.value,
            });
          } else if (previousNode.type === "escape" && nextNode.type === "escape") {
            accumulator.ops.push({
              kind: "set-escape",
              path: materializeDiffPath(nextPath),
              oldValue: previousNode.raw,
              newValue: nextNode.raw,
            });
          } else if (previousNode.type === "raw" && nextNode.type === "raw") {
            if (previousNode.content !== nextNode.content) {
              accumulator.ops.push({
                kind: "set-raw-content",
                path: materializeDiffPath(nextPath),
                oldValue: previousNode.content,
                newValue: nextNode.content,
              });
            }
            queueNestedNodeArrayDiff(nestedTasks, previousNode.args, nextNode.args, nextPath, "args");
          } else if (previousNode.type === "inline" && nextNode.type === "inline") {
            if (!!previousNode.implicitInlineShorthand !== !!nextNode.implicitInlineShorthand) {
              accumulator.ops.push({
                kind: "set-implicit-inline-shorthand",
                path: materializeDiffPath(nextPath),
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
  diffRefinementDepthCap: number,
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
      diffRefinementDepthCap,
      0,
      task.previousNodes.length,
      0,
      task.nextNodes.length,
      false,
      nestedTasks,
    );
  }
};

// dirty span 是 best-effort：优先从节点 position 推导，取不到再退回 edit span。
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

// 保守 diff：当 refinement 抛错或 full-fallback 文档太大时，
// 直接把整棵 root tree 当成一次 splice，保证 session 不会被 diff 拖垮。
/**
 * Build a coarse whole-tree diff between two snapshots.
 *
 * Used as the safety-net path when fine-grained structural refinement is too
 * expensive or throws unexpectedly.
 */
export const buildConservativeTokenDiff = (
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

/**
 * Compute the patch/unchanged/op triple for one structural tree update.
 *
 * This prefers fine-grained nested ops when possible, but degrades toward
 * container-level splices when node shapes diverge or refinement hits the
 * configured depth cap.
 */
export const computeTokenDiff = (
  previousTree: readonly StructuralNode[],
  nextTree: readonly StructuralNode[],
  edit: IncrementalEdit,
  diffRefinementDepthCap: number,
): TokenDiffResult => {
  // diff 是锦上添花，不是 session 正确性的前提。
  // 所以策略始终是：能细就细，细不动就保守，绝不为了 diff 反过来拖垮主更新流程。
  const accumulator: SequenceDiffAccumulator = { segments: [], ops: [] };
  const nestedTasks: NestedNodeArrayDiffTask[] = [];
  diffNodeArrays(
    previousTree,
    nextTree,
    undefined,
    "root",
    accumulator,
    diffRefinementDepthCap,
    0,
    previousTree.length,
    0,
    nextTree.length,
    true,
    nestedTasks,
  );
  processNestedNodeArrayDiffs(nestedTasks, accumulator, diffRefinementDepthCap);

  const unchangedRanges: TokenDiffUnchangedRange[] = [];
  const patches: TokenDiffPatch[] = [];
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
