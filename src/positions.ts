import type { PositionTracker, SourcePosition, SourceSpan } from "./types.js";

export type { PositionTracker };

export const buildPositionTracker = (text: string): PositionTracker => {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  return {
    resolve(offset: number): SourcePosition {
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

/** Build a SourceSpan from the tracker, or return undefined if tracker is null. */
export const makePosition = (
  tracker: PositionTracker | null,
  start: number,
  end: number,
): SourceSpan | undefined => {
  if (!tracker) return undefined;
  return { start: tracker.resolve(start), end: tracker.resolve(end) };
};

/**
 * Create an offset-adjusted tracker for recursive inner parses on substrings.
 * Both offset and line/column are remapped via the outer tracker.
 * Returns null if the outer tracker is null.
 */
export const offsetTracker = (
  tracker: PositionTracker | null,
  baseOffset: number,
): PositionTracker | null => {
  if (!tracker || baseOffset === 0) return tracker;
  return { resolve: (offset) => tracker.resolve(offset + baseOffset) };
};

/**
 * Create a tracker for parsing a substring without a full-document tracker.
 * `offset` is shifted by `baseOffset`, while `line`/`column` stay local to
 * the substring.
 */
export const localOffsetTracker = (
  tracker: PositionTracker | null,
  baseOffset: number,
): PositionTracker | null => {
  if (!tracker || baseOffset === 0) return tracker;
  return {
    resolve(offset: number): SourcePosition {
      const pos = tracker.resolve(offset);
      return { offset: pos.offset + baseOffset, line: pos.line, column: pos.column };
    },
  };
};
