import type { SourceOffsetRange, TokenDiffResult } from "../types";

export type DirtyRangeGetter = () => SourceOffsetRange | null;
export type DirtyRangeTester = (range: SourceOffsetRange) => boolean;

const extractDirtyRange = (diff: TokenDiffResult | null | undefined): SourceOffsetRange | null => {
  if (!diff || diff.isNoop) return null;
  return {
    startOffset: diff.dirtySpanNew.startOffset,
    endOffset: diff.dirtySpanNew.endOffset,
  };
};

const intersectsDirtyRange = (
  range: SourceOffsetRange,
  dirtyRange: SourceOffsetRange | null | undefined,
): boolean => {
  if (!dirtyRange) return false;
  if (dirtyRange.startOffset === dirtyRange.endOffset) {
    return range.startOffset <= dirtyRange.startOffset && range.endOffset > dirtyRange.startOffset;
  }
  return range.endOffset > dirtyRange.startOffset && range.startOffset < dirtyRange.endOffset;
};

/** Create source-range helpers bound to one incremental diff. */
export const createIncrementalDirtyRange = (
  diff: TokenDiffResult | null | undefined,
): {
  getRange: DirtyRangeGetter;
  touches: DirtyRangeTester;
} => {
  const dirtyRange = extractDirtyRange(diff);
  const getRange: DirtyRangeGetter = () =>
    dirtyRange
      ? {
          startOffset: dirtyRange.startOffset,
          endOffset: dirtyRange.endOffset,
        }
      : null;
  const touches: DirtyRangeTester = (range) =>
    intersectsDirtyRange(range, dirtyRange);

  return {
    getRange,
    touches,
  };
};
