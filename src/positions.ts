import type { PositionTracker, SourcePosition, SourceSpan } from "./types.js";

export type { PositionTracker };

/**
 * 基于完整文本预构建一个 position tracker。
 *
 * 它本质上只做一件事：先扫一遍文本，记住“每一行是从哪个 offset 开始的”，
 * 后续再把任意 offset 通过二分查找映射成 `{ offset, line, column }`。
 *
 * 注意：
 * - 这里存的是 `lineStarts`，不是每个字符的完整位置表，所以空间开销按“行数”增长。
 * - `resolve(offset)` 假定传入的是合法 offset；它不会帮你做边界修正。
 * - 这个 tracker 本身不关心子串语义；子串回指原文要配合 `offsetTracker(...)` /
 *   `localOffsetTracker(...)` 一起用。
 */
export const buildPositionTracker = (text: string): PositionTracker => {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  return {
    resolve(offset: number): SourcePosition {
      // 注意：这里是在 `lineStarts` 里找“最后一个 <= offset 的行起点”。
      // 找到了它，line 就是对应行号，column 就是 offset 相对这个行起点的偏移。
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { offset, line: lo + 1, column: offset - lineStarts[lo] + 1 };
    },
  };
};

/** 用 tracker 把 `[start, end)` 这段源码区间映射成 `SourceSpan`；tracker 为空时直接返回 `undefined`。 */
export const makePosition = (
  tracker: PositionTracker | null,
  start: number,
  end: number,
): SourceSpan | undefined => {
  if (!tracker) return undefined;
  return { start: tracker.resolve(start), end: tracker.resolve(end) };
};

/**
 * 基于“原文 tracker”再包一层，把子串内 offset 回指到原文。
 *
 * 语义是：子串里的 `offset = 0`，在这里会先加上 `baseOffset`，
 * 然后直接交给外层 tracker 解析，所以 `offset / line / column`
 * 三个字段都会指向原文坐标。
 *
 * 适用场景：
 * - 你手里已经有基于完整文档构建的 tracker
 * - 现在在解析一个切片，但希望位置完全回指原文
 */
export const offsetTracker = (
  tracker: PositionTracker | null,
  baseOffset: number,
): PositionTracker | null => {
  if (!tracker || baseOffset === 0) return tracker;
  return { resolve: (offset) => tracker.resolve(offset + baseOffset) };
};

/**
 * 给“子串本地 tracker”补一个绝对 offset 偏移。
 *
 * 语义和 `offsetTracker(...)` 不一样：
 * - `offset` 会加上 `baseOffset`
 * - 但 `line / column` 仍然沿用子串本地坐标
 *
 * 适用场景：
 * - 你只有子串本地 tracker
 * - 只需要把 offset 映射回原文
 * - line/column 保持切片局部语义也可以接受
 */
export const localOffsetTracker = (
  tracker: PositionTracker | null,
  baseOffset: number,
): PositionTracker | null => {
  if (!tracker || baseOffset === 0) return tracker;
  return {
    resolve(offset: number): SourcePosition {
      const pos = tracker.resolve(offset);
      // 注意：这里是“只把 offset 抬回原文”，不是“把整套位置都抬回原文”。
      // `line / column` 故意保留子串本地坐标；如果你想三者都回指原文，用上面的 `offsetTracker(...)`。
      return { offset: pos.offset + baseOffset, line: pos.line, column: pos.column };
    },
  };
};
