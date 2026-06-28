/**
 * @internal Lookahead-extent recorder for the incremental dirty-window reparse.
 *
 * yumeDSL's grammar has *unbounded* forward scans: raw/block/arg-close search
 * (`findRawClose` / `findBlockClose` / `findTagArgClose`), inline close search,
 * and EOF frame finalization. When such a scan runs to the end of the available
 * text without resolving, its result is "truncated" — it concluded "not found /
 * EOF" only because it ran out of text. Inside an isolated dirty-window slice that
 * differs from how the same region parses in the full document, which is how the
 * incremental tree could diverge from a full reparse (the invariant violation
 * found by tests/incrementalFuzz.test.ts).
 *
 * Each such scan calls `recordUnresolvedScan(sliceStart)`. The recorder stores the
 * *absolute* start offset (the active `base` is added). Two consumers use this:
 *
 *  - Right boundary: if any scan was unresolved during a window parse, the window
 *    depended on bytes beyond its right edge → expand the window (ultimately to the
 *    document end, which always matches a full reparse).
 *  - Left boundary: an unresolved scan reads to the document end, so the zone that
 *    *contains its start* depends on everything to its right. That zone is flagged
 *    `readsPastEnd`; a later edit must reparse from such a zone even when it sits to
 *    the left of the edit (otherwise the reused left zone goes stale — the doc#53
 *    fuzz case). See incremental.ts findDirtyRange / document.ts zone flags.
 *
 * Ambient (module-level) rather than threaded through every scanner signature: the
 * scan sites are scattered across the hot, fragile core. A parse is synchronous and
 * never re-enters, so begin/end bracketing around a single parse is safe, and the
 * `recording` gate makes `recordUnresolvedScan(...)` a no-op for every normal,
 * non-incremental parse.
 */

let recording = false;
let base = 0;
let unresolvedStarts: number[] = [];

/** Start recording around an isolated parse; `baseOffset` maps slice offsets to source offsets. */
export const beginLookaheadRecording = (baseOffset: number): void => {
  recording = true;
  base = baseOffset;
  unresolvedStarts = [];
};

/** Stop recording; returns the absolute start offsets of all unresolved forward scans. */
export const endLookaheadRecording = (): number[] => {
  recording = false;
  return unresolvedStarts;
};

/**
 * Flag that a forward scan (or EOF finalization) starting at `sliceStart` read to
 * the end of the available text without resolving. No-op unless recording.
 */
export const recordUnresolvedScan = (sliceStart: number): void => {
  if (recording) unresolvedStarts.push(base + sliceStart);
};
