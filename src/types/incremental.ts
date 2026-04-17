import type { StructuralParseOptions, StructuralNode, Zone } from "./structural.js";

// ── Incremental structural parse types ──

/**
 * Parse options used by incremental structural parsing.
 *
 * Position fields are always tracked internally and cannot be overridden.
 * `baseOffset` / `tracker` are also internal for incremental updates.
 * For better incremental reuse, keep `handlers` reference stable across edits.
 */
export type IncrementalParseOptions = Omit<
  StructuralParseOptions,
  "trackPositions" | "baseOffset" | "tracker"
>;

/**
 * Single text edit against the previous source.
 *
 * Offsets are based on the old source (`doc.source`) and `oldEndOffset` is exclusive.
 */
export interface IncrementalEdit {
  /** Start offset in the old source (inclusive). */
  startOffset: number;
  /** End offset in the old source (exclusive). */
  oldEndOffset: number;
  /** Replacement text inserted at `[startOffset, oldEndOffset)`. */
  newText: string;
}

/**
 * Cached document snapshot for incremental structural updates.
 */
export interface IncrementalDocument {
  /** Full source snapshot for this incremental state. */
  source: string;
  /** Top-level zones used for bounded reparsing. */
  zones: Zone[];
  /** Full structural tree of `source`. */
  tree: StructuralNode[];
  /** Optional parser config carried forward across updates. */
  parseOptions?: IncrementalParseOptions;
}

/** Error codes returned by low-level incremental update APIs. */
export type IncrementalUpdateErrorCode =
  | "INVALID_EDIT_RANGE"
  | "NEW_SOURCE_LENGTH_MISMATCH"
  | "EDIT_TEXT_MISMATCH"
  | "UNKNOWN";

/** Error object used by low-level incremental update APIs. */
export interface IncrementalUpdateError extends Error {
  /** Stable machine-readable failure code. */
  code: IncrementalUpdateErrorCode;
}

/** Discriminated result of one low-level incremental update attempt. */
export type IncrementalUpdateResult =
  | { ok: true; value: IncrementalDocument }
  | { ok: false; error: IncrementalUpdateError };

/**
 * Result mode returned by the high-level incremental session API.
 */
export type IncrementalSessionApplyMode = "incremental" | "full-fallback";

/** Strategy for high-level incremental sessions. */
export type IncrementalSessionStrategy = "auto" | "incremental-only" | "full-only";

/** Reasons recorded when session falls back to a full rebuild. */
export type IncrementalSessionFallbackReason =
  | IncrementalUpdateErrorCode
  | "INTERNAL_FULL_REBUILD"
  | "FULL_ONLY_STRATEGY"
  | "AUTO_COOLDOWN"
  | "AUTO_LARGE_EDIT";

/**
 * High-level session behavior tuning options.
 *
 * All numeric fields are optional safeguards/thresholds for adaptive fallback.
 */
export interface IncrementalSessionOptions {
  /** Session strategy selector. */
  strategy?: IncrementalSessionStrategy;
  /** Number of recent samples used by adaptive strategy. */
  sampleWindowSize?: number;
  /** Minimum samples before adaptive switching is evaluated. */
  minSamplesForAdaptation?: number;
  /** Allowed fallback ratio in `auto` mode before entering cooldown. */
  maxFallbackRate?: number;
  /** Threshold multiplier for preferring full rebuild over incremental path. */
  switchToFullMultiplier?: number;
  /** Cooldown edit count when `auto` mode temporarily prefers full rebuild. */
  fullPreferenceCooldownEdits?: number;
  /** Maximum single-edit size ratio still eligible for incremental update. */
  maxEditRatioForIncremental?: number;
  /**
   * Maximum number of non-breaker nodes per soft zone.
   *
   * Controls the granularity of incremental zone splitting for documents
   * that contain few or no raw/block nodes (e.g. pure inline text).
   * Smaller values produce more zones (finer incremental windows but higher
   * overhead); larger values produce fewer zones (coarser windows).
   *
   * @default 64
   */
  softZoneNodeCap?: number;
  /**
   * Maximum recursive refinement depth used by `applyEditWithDiff`.
   *
   * Larger values preserve more fine-grained nested diff ops on deep trees,
   * but increase cost on extremely deep structures.
   * Smaller values prefer coarse splice ops earlier.
   *
   * @default 64
   */
  diffRefinementDepthCap?: number;
}

/**
 * Safe update result for one edit in an incremental session.
 *
 * - `mode: "incremental"` means the update path succeeded.
 * - `mode: "full-fallback"` means the session rebuilt from `newSource`.
 */
export interface IncrementalSessionApplyResult {
  /** Updated document snapshot after this operation. */
  doc: IncrementalDocument;
  /** Whether this call used incremental path or full fallback. */
  mode: IncrementalSessionApplyMode;
  /** Populated only when `mode === "full-fallback"`. */
  fallbackReason?: IncrementalSessionFallbackReason;
}

// ── Token diff types ──

/** Half-open range over token indexes. */
export interface TokenIndexRange {
  /** Inclusive starting token index. */
  start: number;
  /** Exclusive ending token index. */
  end: number;
}

/** Source-coordinate span expressed in UTF-16 offsets. */
export interface SourceOffsetRange {
  /** Inclusive starting source offset. */
  startOffset: number;
  /** Exclusive ending source offset. */
  endOffset: number;
}

/** Token-index patch emitted by incremental token diff. */
export interface TokenDiffPatch {
  /** Patch kind over token-index ranges. */
  kind: "insert" | "remove" | "replace";
  /** Half-open range in previous token array. */
  oldRange: TokenIndexRange;
  /** Half-open range in next token array. */
  newRange: TokenIndexRange;
}

/** Matched unchanged token-index range pair (`old` ↔ `new`). */
export interface TokenDiffUnchangedRange {
  /** Half-open range in previous token array. */
  oldRange: TokenIndexRange;
  /** Half-open range in next token array. */
  newRange: TokenIndexRange;
}

// ── Structural diff types ──

/** Container kinds addressable by structural diff operations. */
export type StructuralDiffContainerField = "root" | "children" | "args";

/** One path step in a structural diff, identifying a node inside a container. */
export interface StructuralDiffPathSegment {
  /** Container traversed at this step. */
  field: StructuralDiffContainerField;
  /** Node index inside that container. */
  index: number;
}

/** Path from the root structural node array to a specific node. */
export type StructuralDiffPath = StructuralDiffPathSegment[];

/**
 * Shared scalar value-op shape for path-aware structural updates.
 *
 * Specialized ops such as `set-text` and `set-escape` reuse this base to keep
 * their contract consistent: address one node by path, then replace one scalar
 * payload field.
 */
export interface StructuralDiffValueOpBase<TKind extends string, TValue> {
  /** Operation discriminator. */
  kind: TKind;
  /** Path to the target node in the previous tree. */
  path: StructuralDiffPath;
  /** Previous scalar value observed at that node. */
  oldValue: TValue;
  /** Next scalar value that should replace `oldValue`. */
  newValue: TValue;
}

/** Array splice inside the root tree or a node's `children` / `args`. */
export interface StructuralDiffSpliceOp {
  kind: "splice";
  /** Path to the owning node. Empty path means the root token array. */
  path: StructuralDiffPath;
  /** Which array container under `path` is being modified. */
  field: StructuralDiffContainerField;
  /** Half-open range in the previous container. */
  oldRange: TokenIndexRange;
  /** Half-open range in the next container. */
  newRange: TokenIndexRange;
  /** Previous nodes covered by the splice. */
  oldNodes: StructuralNode[];
  /** Next nodes covered by the splice. */
  newNodes: StructuralNode[];
}

/** Scalar text update on a `text` node. */
export interface StructuralDiffTextOp extends StructuralDiffValueOpBase<"set-text", string> {}

/** Scalar raw update on an `escape` node. */
export interface StructuralDiffEscapeOp extends StructuralDiffValueOpBase<"set-escape", string> {}

/** Scalar content update on a `raw` node. */
export interface StructuralDiffRawContentOp extends StructuralDiffValueOpBase<"set-raw-content", string> {}

/** Flag update on an `inline` node. */
export interface StructuralDiffInlineFlagOp
  extends StructuralDiffValueOpBase<"set-implicit-inline-shorthand", boolean | undefined> {}

/** Path-aware structural operations emitted alongside range-based token diff. */
export type StructuralDiffOp =
  | StructuralDiffSpliceOp
  | StructuralDiffTextOp
  | StructuralDiffEscapeOp
  | StructuralDiffRawContentOp
  | StructuralDiffInlineFlagOp;

/** Diff summary for one edit between previous and next structural token trees. */
export interface TokenDiffResult {
  /** True when this edit produced no structural token changes (`patches` and `ops` are both empty). */
  isNoop: boolean;
  /** Minimal token-index patches needed to transform old tokens to new tokens. */
  patches: TokenDiffPatch[];
  /** Unchanged token-index ranges reused across this edit. */
  unchangedRanges: TokenDiffUnchangedRange[];
  /**
   * Path-aware structural operations for nested updates and container edits.
   *
   * Returned in descending path/index order (with same-path splices first), so
   * consumers can apply `ops` in array order without later splice targets being
   * invalidated by earlier index shifts.
   */
  ops: StructuralDiffOp[];
  /** Best-effort dirty span in previous source coordinates. */
  dirtySpanOld: SourceOffsetRange;
  /** Best-effort dirty span in next source coordinates. */
  dirtySpanNew: SourceOffsetRange;
}

/** Session apply result extended with token diff payload. */
export interface IncrementalSessionApplyWithDiffResult extends IncrementalSessionApplyResult {
  /** Token diff payload for this edit. */
  diff: TokenDiffResult;
}

/**
 * High-level incremental parsing session.
 *
 * Provides correctness-first semantics:
 * - Apply edits via incremental update when possible.
 * - Fall back to full rebuild when validation or update fails.
 */
export interface IncrementalSession {
  /** Return current in-memory incremental document snapshot. */
  getDocument: () => IncrementalDocument;
  /** Apply one edit and return updated snapshot with selected mode. */
  applyEdit: (
    edit: IncrementalEdit,
    newSource: string,
    options?: IncrementalParseOptions,
  ) => IncrementalSessionApplyResult;
  /** Apply one edit and return updated snapshot with structural token diff payload. */
  applyEditWithDiff: (
    edit: IncrementalEdit,
    newSource: string,
    options?: IncrementalParseOptions,
  ) => IncrementalSessionApplyWithDiffResult;
  /** Force a full rebuild from `newSource`. */
  rebuild: (newSource: string, options?: IncrementalParseOptions) => IncrementalDocument;
}
