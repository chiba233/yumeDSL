import type { SourcePosition, SourceSpan } from "./types.js";

// ── Position tracker (module-scoped, follows withSyntax / withCreateId pattern) ──

export interface PositionTracker {
  resolve(offset: number): SourcePosition;
}

let activeTracker: PositionTracker | null = null;

export const getPositionTracker = (): PositionTracker | null => activeTracker;

export const withPositionTracker = <T>(tracker: PositionTracker | null, fn: () => T): T => {
  const prev = activeTracker;
  activeTracker = tracker;
  try {
    return fn();
  } finally {
    activeTracker = prev;
  }
};

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

/**
 * Create a tracker that shifts all offsets by `baseOffset` before resolving.
 * Used for recursive inner parses on substrings of the original text.
 */
export const withBaseOffset = <T>(baseOffset: number, fn: () => T): T => {
  const tracker = activeTracker;
  if (!tracker || baseOffset === 0) return fn();
  return withPositionTracker(
    { resolve: (offset) => tracker.resolve(offset + baseOffset) },
    fn,
  );
};

/** Helper: build a SourceSpan from the active tracker, or return undefined. */
export const makePosition = (start: number, end: number): SourceSpan | undefined => {
  if (!activeTracker) return undefined;
  return {
    start: activeTracker.resolve(start),
    end: activeTracker.resolve(end),
  };
};
