import { buildPositionTracker } from "../internal/positions.js";
import { buildZonesInternal, SOFT_ZONE_NODE_CAP } from "../internal/zones.js";
import type {
  IncrementalDocument,
  IncrementalEdit,
  IncrementalParseOptions,
  IncrementalSession,
  IncrementalSessionApplyResult,
  IncrementalSessionApplyWithDiffResult,
  IncrementalSessionFallbackReason,
  IncrementalSessionOptions,
  IncrementalSessionStrategy,
  IncrementalUpdateError,
  IncrementalUpdateErrorCode,
  IncrementalUpdateResult,
  PositionTracker,
  TokenDiffResult,
  Zone,
} from "../types";
import {
  buildConservativeTokenDiff,
  computeTokenDiff,
  MAX_FULL_FALLBACK_DIFF_REFINEMENT_SOURCE_LENGTH,
  normalizeDiffRefinementDepthCap,
} from "./diff.js";
import {
  getCachedOptionsFingerprint,
  hasUnsafeZoneCoverageTailGap,
  isSafeRightReuse,
  LEFT_LOOKBEHIND_ZONES,
  mapOldOffsetToNew,
  normalizeSoftZoneNodeCap,
  parseIncrementalInternal,
  parseWithPositions,
  setCachedOptionsFingerprint,
} from "./document.js";
import { deferShiftZone, getRawZones, installLazyDocument } from "./lazy.js";
import { buildParseOptionsFingerprint, cloneParseOptions } from "./options.js";

// ═══════════════════════════════════════════════════════════════
// incremental.ts — 增量解析器入口 / 编排层
//
// 核心思路：
// 把文档拆成 zone（连续节点分组），编辑只影响脏区间，
// 左侧 zone 原封不动，右侧 zone 用 lazy delta 平移，中间重解析。
// 整个更新路径不产出中间 AST，最终拼接出新快照。
//
// 硬规则：
// - snapshot clone 不能省——用户 options 可能在外部继续被改
// - fingerprint 只负责判断"配置有没有变"，不能替代 snapshot clone
// - 右侧复用必须过 seam probe，不能盲信 offset 对齐
// - diff refinement 失败不能影响 session 推进，必须保守兜底
//
// 文件导航（按职责拆分）：
// - options.ts    快照克隆 / parseOptions fingerprint
// - document.ts   parseWithPositions / 签名缓存 / seam probe / full parse
// - diff.ts       token diff / structural diff / conservative fallback
// - lazy.ts       右侧 zone lazy delta 平移 / doc.tree,zones 惰性物化
// - incremental.ts 更新编排 / tryUpdate / session 自适应策略
// ═══════════════════════════════════════════════════════════════

// 性能备忘：
// 只重解析脏区间。右侧 zone 用 lazy delta——只存 offset 偏移量，
// 节点 position 延迟到消费者读 tree/zones 时才物化。
// 连续头部编辑自动叠加 delta，不触发中间深拷贝。
// 物化后的文档是纯数据对象，没有 Proxy 语义。

type IncrementalDebugStats = {
  cumulativeReparsedBytes: number;
  probeSliceBytes: number;
  fellBackToFull: boolean;
  wastedPreWorkMs: number;
};

type IncrementalDebugSink = (stats: IncrementalDebugStats) => void;
type InternalUpdateMode = "incremental" | "internal-full-rebuild";
type InternalUpdateObserver = (mode: InternalUpdateMode) => void;

let incrementalDebugSink: IncrementalDebugSink | undefined;

/**
 * Test-only hook for collecting incremental-update telemetry.
 *
 * Production code should not rely on this API; it exists so regression tests
 * can assert fallback behavior and wasted pre-work characteristics.
 */
export const __setIncrementalDebugSink: (sink?: IncrementalDebugSink) => void = (sink) => {
  incrementalDebugSink = sink;
};

// ── 错误工具 ──
const createIncrementalEditError = (
  code: IncrementalUpdateErrorCode,
  message: string,
): IncrementalUpdateError => {
  const error = new Error(message) as IncrementalUpdateError;
  error.code = code;
  return error;
};

const isIncrementalUpdateError = (error: unknown): error is IncrementalUpdateError => {
  if (!(error instanceof Error)) return false;
  const withCode = error as Error & { code?: unknown };
  return (
    withCode.code === "INVALID_EDIT_RANGE" ||
    withCode.code === "NEW_SOURCE_LENGTH_MISMATCH" ||
    withCode.code === "EDIT_TEXT_MISMATCH" ||
    withCode.code === "UNKNOWN"
  );
};

// ── 增量更新核心（编排层）──

// 找脏 zone 区间：哪些 zone 与编辑范围重叠？
// 有重叠 → [firstOverlap - 1, lastOverlap + 1]（左右各扩一格）
// 纯插入无重叠 → 从插入点邻居开始，左回看一格
const findDirtyRange = (zones: readonly Zone[], edit: IncrementalEdit): { from: number; to: number } => {
  let firstOverlap = -1;
  let lastOverlap = -1;
  let insertionIndex = zones.length;
  let insertionFound = false;

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (zone.endOffset > edit.startOffset && zone.startOffset < edit.oldEndOffset) {
      if (firstOverlap === -1) firstOverlap = i;
      lastOverlap = i;
    }
    if (!insertionFound && zone.startOffset >= edit.startOffset) {
      insertionIndex = i;
      insertionFound = true;
    }
  }

  if (firstOverlap !== -1) {
    return {
      from: Math.max(0, firstOverlap - LEFT_LOOKBEHIND_ZONES),
      to: Math.min(zones.length - 1, lastOverlap + 1),
    };
  }

  return {
    from: Math.max(0, insertionIndex - LEFT_LOOKBEHIND_ZONES),
    to: Math.min(zones.length - 1, insertionIndex),
  };
};

// 循环重解析脏窗，直到右边界稳定或超预算。
// "稳定"的意思是：重解析产出的最后一个 zone 的 endOffset 恰好等于脏窗的 endOffset。
// 不稳定 → 右边扩一个 zone，再来一轮。
// 预算守卫：cumulative 重解析字节数超过 2·n → 放弃，返回 budgetExceeded=true，
// 调用方会直接 full rebuild。这保证了脏窗扩展不会变成 O(n²)。
const reparseDirtyWindowUntilStable = (
  zones: readonly Zone[],
  dirtyFrom: number,
  dirtyTo: number,
  edit: IncrementalEdit,
  delta: number,
  newSource: string,
  tracker: PositionTracker,
  parseOptions: IncrementalParseOptions | undefined,
  cumulativeBudget: number,
  cumulativeReparsedBytes: number,
  zoneCap: number,
): {
  budgetExceeded: boolean;
  dirtyTo: number;
  dirtyZones: Zone[];
  cumulativeReparsedBytes: number;
} => {
  let nextDirtyTo = dirtyTo;
  let nextDirtyZones: Zone[] = [];
  let nextCumulativeReparsedBytes = cumulativeReparsedBytes;

  while (true) {
    const dirtyStartOld = zones[dirtyFrom].startOffset;
    const dirtyEndOld = zones[nextDirtyTo].endOffset;
    const dirtyStartNew = mapOldOffsetToNew(edit, delta, dirtyStartOld);
    const dirtyEndNew = mapOldOffsetToNew(edit, delta, dirtyEndOld);
    const reparsedWindowSize = dirtyEndNew - dirtyStartNew;
    nextCumulativeReparsedBytes += reparsedWindowSize;
    if (nextCumulativeReparsedBytes > cumulativeBudget) {
      return {
        budgetExceeded: true,
        dirtyTo: nextDirtyTo,
        dirtyZones: nextDirtyZones,
        cumulativeReparsedBytes: nextCumulativeReparsedBytes,
      };
    }

    const dirtyTree = parseWithPositions(
      newSource.slice(dirtyStartNew, dirtyEndNew),
      tracker,
      parseOptions,
      dirtyStartNew,
    );
    nextDirtyZones = buildZonesInternal(dirtyTree, zoneCap);

    const reparsedEnd =
      nextDirtyZones.length > 0 ? nextDirtyZones[nextDirtyZones.length - 1].endOffset : dirtyStartNew;
    if (reparsedEnd === dirtyEndNew || nextDirtyTo === zones.length - 1) {
      return {
        budgetExceeded: false,
        dirtyTo: nextDirtyTo,
        dirtyZones: nextDirtyZones,
        cumulativeReparsedBytes: nextCumulativeReparsedBytes,
      };
    }
    nextDirtyTo += 1;
  }
};

// 编辑合法性三重校验：
// 1. offset 范围合法（不越界、不倒序）
// 2. newSource 长度 = 旧长度 - 删除长度 + 插入长度
// 3. edit.newText 与 newSource 对应位置一致（防调用方传错）
const assertValidEdit = (doc: IncrementalDocument, edit: IncrementalEdit, newSource: string) => {
  if (edit.startOffset < 0 || edit.oldEndOffset < edit.startOffset || edit.oldEndOffset > doc.source.length) {
    throw createIncrementalEditError(
      "INVALID_EDIT_RANGE",
      "updateIncremental(): invalid edit range.",
    );
  }

  const expectedLength =
    doc.source.length - (edit.oldEndOffset - edit.startOffset) + edit.newText.length;
  if (expectedLength !== newSource.length) {
    throw createIncrementalEditError(
      "NEW_SOURCE_LENGTH_MISMATCH",
      "updateIncremental(): newSource length does not match edit delta from previous source.",
    );
  }

  const insertedText = newSource.slice(edit.startOffset, edit.startOffset + edit.newText.length);
  if (insertedText !== edit.newText) {
    throw createIncrementalEditError(
      "EDIT_TEXT_MISMATCH",
      "updateIncremental(): edit.newText does not match newSource at startOffset.",
    );
  }
};

// ── Public API: 全量解析入口 ──
/**
 * Build the initial incremental document snapshot from full source.
 *
 * Use this low-level API when you want to manage snapshots manually. For
 * correctness-first editing workflows, prefer `createIncrementalSession()`.
 */
export const parseIncremental = (
  source: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => parseIncrementalInternal(source, options, SOFT_ZONE_NODE_CAP);

// 增量更新主流程：
// 1. assertValidEdit       — 编辑合法性校验
// 2. fingerprint 比对       — 配置变了？→ full rebuild
// 3. findDirtyRange        — 找脏 zone 区间
// 4. reparseDirtyWindow    — 循环重解析直到右边界稳定（有预算守卫）
// 5. isSafeRightReuse      — seam probe 验证拼接缝
// 6. deferShiftZone        — 右侧 zone lazy delta 平移
// 7. installLazyDocument   — 拼接新快照，挂 lazy getter
//
// 任何一步判定"不安全" → fullRebuild() 兜底，保证正确性优先。
const updateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options: IncrementalParseOptions | undefined,
  internalObserver: InternalUpdateObserver | undefined,
  zoneCap: number,
): IncrementalDocument => {
  assertValidEdit(doc, edit, newSource);
  let cumulativeReparsedBytes = 0;
  let probeSliceBytes = 0;
  const preWorkStart = incrementalDebugSink ? performance.now() : 0;

  const previousOptionsFingerprint =
    getCachedOptionsFingerprint(doc) ?? buildParseOptionsFingerprint(doc.parseOptions);
  const nextOptionsFingerprint = options
    ? buildParseOptionsFingerprint(options)
    : previousOptionsFingerprint;
  const runtimeParseOptions = options ?? doc.parseOptions;
  // nextParseOptionsSnapshot 延后到确定走增量路径后再算，
  // 避免 fullRebuild 路径白做一次 cloneParseOptions。

  const emitDebug = (fellBackToFull: boolean) => {
    const wastedPreWorkMs = fellBackToFull && incrementalDebugSink
      ? performance.now() - preWorkStart
      : 0;
    incrementalDebugSink?.({
      cumulativeReparsedBytes,
      probeSliceBytes,
      fellBackToFull,
      wastedPreWorkMs,
    });
  };

  // early full-rebuild 路径：尚未构建 tracker，无需透传。
  const earlyFullRebuild = (): IncrementalDocument => {
    emitDebug(true);
    const rebuilt = parseIncrementalInternal(newSource, runtimeParseOptions, zoneCap);
    internalObserver?.("internal-full-rebuild");
    return rebuilt;
  };

  const prevZones = getRawZones(doc);

  if (previousOptionsFingerprint !== nextOptionsFingerprint) return earlyFullRebuild();
  if (prevZones.length === 0) return earlyFullRebuild();
  // zone 太少（≤1）→ 没有足够的左/脏/右结构可复用，增量路径开销白费。
  // 典型场景：纯 text 文档（0 个 zone breaker、softCap 也切不出来），
  // 或极短文档。直接走 full rebuild 更快。
  if (prevZones.length <= 1) return earlyFullRebuild();
  if (hasUnsafeZoneCoverageTailGap(prevZones, edit)) return earlyFullRebuild();

  const newTracker = buildPositionTracker(newSource);

  // late full-rebuild：tracker 已构建，透传给 parseIncrementalInternal 复用。
  const fullRebuild = (): IncrementalDocument => {
    emitDebug(true);
    const rebuilt = parseIncrementalInternal(newSource, runtimeParseOptions, zoneCap, newTracker);
    internalObserver?.("internal-full-rebuild");
    return rebuilt;
  };
  const cumulativeBudget = Math.max(newSource.length * 2, 1024);

  const delta = newSource.length - doc.source.length;
  const dirty = findDirtyRange(prevZones, edit);

  let dirtyTo = dirty.to;
  let dirtyZones: Zone[] = [];

  const firstReparse = reparseDirtyWindowUntilStable(
    prevZones,
    dirty.from,
    dirtyTo,
    edit,
    delta,
    newSource,
    newTracker,
    runtimeParseOptions,
    cumulativeBudget,
    cumulativeReparsedBytes,
    zoneCap,
  );
  cumulativeReparsedBytes = firstReparse.cumulativeReparsedBytes;
  if (firstReparse.budgetExceeded) return fullRebuild();
  dirtyTo = firstReparse.dirtyTo;
  dirtyZones = firstReparse.dirtyZones;

  const leftZones = prevZones.slice(0, dirty.from);
  const oldRightZones = prevZones.slice(dirtyTo + 1);
  if (oldRightZones.length > 0) {
    const seamOldOffset = oldRightZones[0].startOffset;
    const seamNewOffset = mapOldOffsetToNew(edit, delta, seamOldOffset);
    const rightReuseCheck = isSafeRightReuse(
      oldRightZones,
      newSource,
      seamNewOffset,
      delta,
      newTracker,
      runtimeParseOptions,
      zoneCap,
    );
    probeSliceBytes = rightReuseCheck.probeSliceBytes;
    if (!rightReuseCheck.ok) return fullRebuild();
  }
  const rightZones = oldRightZones.map((zone) => deferShiftZone(zone, delta));

  const nextRawZones = [...leftZones, ...dirtyZones, ...rightZones];
  // 确定走增量路径，此时才 clone parseOptions（避免 fullRebuild 白做一次）。
  const nextParseOptionsSnapshot = options ? cloneParseOptions(options) : doc.parseOptions;

  const updated: IncrementalDocument = {
    source: newSource,
    zones: nextRawZones,
    tree: [],
    parseOptions: nextParseOptionsSnapshot,
  };
  installLazyDocument(updated, nextRawZones, newTracker);
  setCachedOptionsFingerprint(updated, nextOptionsFingerprint);
  emitDebug(false);
  internalObserver?.("incremental");
  return updated;
};

/**
 * Apply one edit to a previous incremental snapshot.
 *
 * This low-level API may throw on invalid edit contracts. Session-based callers
 * should prefer `createIncrementalSession().applyEdit(...)` for automatic
 * fallback behavior.
 */
export const updateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => updateIncrementalInternal(doc, edit, newSource, options, undefined, SOFT_ZONE_NODE_CAP);

// Result 风格的增量更新：不抛异常，返回 { ok, value } | { ok, error }。
// session 内部走这条路径，方便统一处理错误 → full rebuild 兜底。
const tryUpdateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options: IncrementalParseOptions | undefined,
  internalObserver: InternalUpdateObserver | undefined,
  zoneCap: number,
): IncrementalUpdateResult => {
  try {
    return {
      ok: true,
      value: updateIncrementalInternal(doc, edit, newSource, options, internalObserver, zoneCap),
    };
  } catch (error) {
    if (isIncrementalUpdateError(error)) {
      return {
        ok: false,
        error,
      };
    }
    return {
      ok: false,
      error: createIncrementalEditError(
        "UNKNOWN",
        `tryUpdateIncremental(): unexpected error: ${String(error)}`,
      ),
    };
  }
};

/**
 * Result-style variant of {@link updateIncremental}.
 *
 * Returns a discriminated `{ ok, value | error }` result instead of throwing,
 * which makes it convenient for session orchestration and host integrations.
 */
export const tryUpdateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalUpdateResult =>
  tryUpdateIncrementalInternal(doc, edit, newSource, options, undefined, SOFT_ZONE_NODE_CAP);

// ── Session（有状态会话 + 自适应策略）──
//
// createIncrementalSession 是生产级入口。它在 updateIncremental 外面包了一层：
// - 自动 full-rebuild 兜底（增量失败不会抛到调用方）
// - auto 策略：滑动窗口采样，如果增量频繁 fallback 或比 full 还慢 → 自动切 full 模式
// - cooldown 机制：切到 full 后连续 N 次编辑保持 full，避免反复抖动
/**
 * Create a stateful incremental parsing session with automatic fallback.
 *
 * The session reuses the previous snapshot when safe, tracks adaptive fallback
 * heuristics in `auto` mode, and can additionally emit structural diff payloads
 * through `applyEditWithDiff()`.
 */
export const createIncrementalSession = (
  source: string,
  options?: IncrementalParseOptions,
  sessionOptions?: IncrementalSessionOptions,
): IncrementalSession => {
  const zoneCap = normalizeSoftZoneNodeCap(sessionOptions?.softZoneNodeCap);
  const diffRefinementDepthCap = normalizeDiffRefinementDepthCap(sessionOptions?.diffRefinementDepthCap);
  let currentDoc = parseIncrementalInternal(source, options, zoneCap);
  const strategy: IncrementalSessionStrategy = sessionOptions?.strategy ?? "auto";
  const sampleWindowSize = Math.max(4, sessionOptions?.sampleWindowSize ?? 24);
  const minSamplesForAdaptation = Math.max(2, sessionOptions?.minSamplesForAdaptation ?? 6);
  const maxFallbackRate = Math.min(1, Math.max(0, sessionOptions?.maxFallbackRate ?? 0.35));
  const switchToFullMultiplier = Math.max(1, sessionOptions?.switchToFullMultiplier ?? 1.1);
  const fullPreferenceCooldownEdits = Math.max(1, sessionOptions?.fullPreferenceCooldownEdits ?? 12);
  const maxEditRatioForIncremental = Math.min(
    1,
    Math.max(0, sessionOptions?.maxEditRatioForIncremental ?? 0.2),
  );

  const now: () => number =
    typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

  let preferFullMode = false;
  let cooldownRemaining = 0;
  const incrementalDurations: number[] = [];
  const fallbackMarks: number[] = [];
  const fullDurations: number[] = [];

  // 进入 full 偏好模式：清空增量采样，开始 cooldown 计数。
  const enterFullPreference = () => {
    preferFullMode = true;
    cooldownRemaining = fullPreferenceCooldownEdits;
    incrementalDurations.length = 0;
    fallbackMarks.length = 0;
  };

  // 有界滑动窗口：超过 sampleWindowSize 就丢最老的样本。
  const recordBounded = (bucket: number[], value: number) => {
    bucket.push(value);
    if (bucket.length > sampleWindowSize) {
      bucket.shift();
    }
  };

  const average = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      total += values[i];
    }
    return total / values.length;
  };

  const runRebuild = (
    nextSource: string,
    nextOptions: IncrementalParseOptions | undefined,
    fallbackReason: IncrementalSessionFallbackReason,
  ): IncrementalSessionApplyResult => {
    const start = now();
    currentDoc = parseIncrementalInternal(nextSource, nextOptions ?? currentDoc.parseOptions, zoneCap);
    const elapsedMs = now() - start;
    recordBounded(fullDurations, elapsedMs);
    return {
      doc: currentDoc,
      mode: "full-fallback",
      fallbackReason,
    };
  };

  // 自适应策略决策：
  // 1. fallback 率超阈值 → 切 full
  // 2. 增量平均耗时 > full 平均耗时 × multiplier → 切 full
  // 只在 auto 模式下生效，且需要积攒够 minSamplesForAdaptation 个样本才开始判断。
  const maybeAdaptPolicy = () => {
    if (strategy !== "auto") return;
    const incrementalSampleCount = incrementalDurations.length;
    if (incrementalSampleCount < minSamplesForAdaptation) return;

    const fallbackRate = average(fallbackMarks);
    if (fallbackRate > maxFallbackRate) {
      enterFullPreference();
      return;
    }

    if (fullDurations.length < minSamplesForAdaptation) return;
    const avgIncrementalMs = average(incrementalDurations);
    const avgFullMs = average(fullDurations);
    if (avgIncrementalMs > avgFullMs * switchToFullMultiplier) {
      enterFullPreference();
    }
  };

  const rebuild = (nextSource: string, nextOptions?: IncrementalParseOptions): IncrementalDocument => {
    currentDoc = parseIncrementalInternal(nextSource, nextOptions ?? currentDoc.parseOptions, zoneCap);
    return currentDoc;
  };

  const applyEditCore = (
    edit: IncrementalEdit,
    newSource: string,
    nextOptions?: IncrementalParseOptions,
  ): { previousDoc: IncrementalDocument; result: IncrementalSessionApplyResult } => {
    const previousDoc = currentDoc;
    let result: IncrementalSessionApplyResult;
    if (strategy === "full-only") {
      result = runRebuild(newSource, nextOptions, "FULL_ONLY_STRATEGY");
      return { previousDoc, result };
    }

    const previousLength = Math.max(1, currentDoc.source.length);
    const replacedLength = Math.max(0, edit.oldEndOffset - edit.startOffset);
    const writtenLength = edit.newText.length;
    const editRatio = Math.max(replacedLength, writtenLength) / previousLength;

    if (strategy === "auto" && editRatio > maxEditRatioForIncremental) {
      result = runRebuild(newSource, nextOptions, "AUTO_LARGE_EDIT");
      maybeAdaptPolicy();
      return { previousDoc, result };
    }

    if (strategy === "auto" && preferFullMode && cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      if (cooldownRemaining === 0) {
        preferFullMode = false;
      }
      result = runRebuild(newSource, nextOptions, "AUTO_COOLDOWN");
      maybeAdaptPolicy();
      return { previousDoc, result };
    }

    const incrementalStart = now();
    let mode: InternalUpdateMode | undefined;
    const updateResult = tryUpdateIncrementalInternal(
      currentDoc,
      edit,
      newSource,
      nextOptions,
      (nextTelemetry) => {
        mode = nextTelemetry;
      },
      zoneCap,
    );
    const incrementalElapsedMs = now() - incrementalStart;
    recordBounded(incrementalDurations, incrementalElapsedMs);

    if (updateResult.ok) {
      currentDoc = updateResult.value;
      const internalFullRebuild = mode === "internal-full-rebuild";
      recordBounded(fallbackMarks, internalFullRebuild ? 1 : 0);
      maybeAdaptPolicy();
      if (internalFullRebuild) {
        result = {
          doc: currentDoc,
          mode: "full-fallback",
          fallbackReason: "INTERNAL_FULL_REBUILD",
        };
        return { previousDoc, result };
      }
      result = {
        doc: currentDoc,
        mode: "incremental",
      };
      return { previousDoc, result };
    }

    recordBounded(fallbackMarks, 1);
    result = runRebuild(newSource, nextOptions, updateResult.error.code);
    maybeAdaptPolicy();
    return { previousDoc, result };
  };

  // applyEdit：session 的编辑入口。决策流程：
  // 1. full-only 策略 → 直接 rebuild
  // 2. auto + 编辑比例过大 → rebuild（大编辑增量没意义）
  // 3. auto + cooldown 中 → rebuild（刚从增量切过来，保持稳定）
  // 4. 走增量路径 → tryUpdateIncrementalInternal
  //    4a. 成功 → 返回 incremental 或 internal-full-rebuild
  //    4b. 失败 → runRebuild 兜底
  // 每次都记录耗时采样 + 调用 maybeAdaptPolicy 更新策略。
  const applyEdit = (
    edit: IncrementalEdit,
    newSource: string,
    nextOptions?: IncrementalParseOptions,
  ): IncrementalSessionApplyResult => applyEditCore(edit, newSource, nextOptions).result;

  const applyEditWithDiff = (
    edit: IncrementalEdit,
    newSource: string,
    nextOptions?: IncrementalParseOptions,
  ): IncrementalSessionApplyWithDiffResult => {
    const { previousDoc, result } = applyEditCore(edit, newSource, nextOptions);
    let diff: TokenDiffResult;
    try {
      const skipRefinementForLargeFallback =
        result.mode === "full-fallback" &&
        (previousDoc.source.length > MAX_FULL_FALLBACK_DIFF_REFINEMENT_SOURCE_LENGTH ||
          result.doc.source.length > MAX_FULL_FALLBACK_DIFF_REFINEMENT_SOURCE_LENGTH);
      if (skipRefinementForLargeFallback) {
        diff = buildConservativeTokenDiff(previousDoc, result.doc);
      } else {
        diff = computeTokenDiff(previousDoc.tree, result.doc.tree, edit, diffRefinementDepthCap);
      }
    } catch (_error) {
      diff = buildConservativeTokenDiff(previousDoc, result.doc);
    }
    return { ...result, diff };
  };

  return {
    getDocument: () => currentDoc,
    applyEdit,
    applyEditWithDiff,
    rebuild,
  };
};
