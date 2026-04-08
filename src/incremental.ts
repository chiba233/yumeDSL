import { buildPositionTracker } from "./positions.js";
import { parseStructural } from "./structural.js";
import type {
  IncrementalDocument,
  IncrementalEdit,
  IncrementalParseOptions,
  IncrementalSessionFallbackReason,
  IncrementalSessionOptions,
  IncrementalSession,
  IncrementalSessionApplyResult,
  IncrementalSessionStrategy,
  IncrementalUpdateError,
  IncrementalUpdateErrorCode,
  IncrementalUpdateResult,
  PositionTracker,
  SourcePosition,
  StructuralNode,
  Zone,
} from "./types.js";
import { buildZones } from "./zones.js";

// Performance note:
// This implementation reparses only the dirty range.
// Zones strictly to the right are reprojected via recursive deep-copy.
// This keeps returned nodes as plain data objects (no Proxy semantics), but
// updates near the beginning of very large documents may still pay O(right-side size).

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

// Shallow clone only: nested fields are intentionally shared.
// Callers should treat parse options as immutable after passing them in.
const cloneParseOptions = (
  options: IncrementalParseOptions | undefined,
): IncrementalParseOptions | undefined => {
  if (!options) return undefined;
  return {
    ...options,
    syntax: options.syntax ? { ...options.syntax } : undefined,
    tagName: options.tagName ? { ...options.tagName } : undefined,
    allowForms: options.allowForms ? [...options.allowForms] : undefined,
  };
};

const hasUnsafeZoneCoverageTailGap = (doc: IncrementalDocument, edit: IncrementalEdit): boolean => {
  const lastZone = doc.zones[doc.zones.length - 1];
  if (!lastZone) return false;
  return edit.startOffset > lastZone.endOffset || edit.oldEndOffset > lastZone.endOffset;
};

const parseWithPositions = (
  source: string,
  tracker: PositionTracker,
  options?: IncrementalParseOptions,
  baseOffset = 0,
): StructuralNode[] =>
  // `parseStructural` public path hardcodes its internal `baseOffset` entry call to 0.
  // Absolute positions are still correct here because `resolveBaseOptions(...)` wraps
  // the provided `tracker` with `baseOffset` before scanning.
  parseStructural(source, {
    ...options,
    trackPositions: true,
    baseOffset,
    tracker,
  });

const flattenZones = (zones: readonly Zone[]): StructuralNode[] => {
  const tree: StructuralNode[] = [];
  for (const zone of zones) {
    tree.push(...zone.nodes);
  }
  return tree;
};

const mapOldOffsetToNew = (edit: IncrementalEdit, delta: number, oldOffset: number): number => {
  if (oldOffset <= edit.startOffset) return oldOffset;
  if (oldOffset >= edit.oldEndOffset) return oldOffset + delta;
  return edit.startOffset + edit.newText.length;
};

const shiftPosition = (
  position: SourcePosition | undefined,
  delta: number,
  tracker: PositionTracker,
): SourcePosition | undefined => {
  if (!position) return undefined;
  return tracker.resolve(position.offset + delta);
};

const assertUnreachable = (value: never): never => {
  throw new Error(`shiftNode(): unexpected node type: ${String((value as { type?: unknown }).type)}`);
};

const createShiftedNodeShell = (
  node: StructuralNode,
  delta: number,
  tracker: PositionTracker,
): StructuralNode => {
  const position = node.position
    ? {
        start: shiftPosition(node.position.start, delta, tracker)!,
        end: shiftPosition(node.position.end, delta, tracker)!,
      }
    : undefined;

  if (node.type === "text") {
    return { type: "text", value: node.value, position };
  }

  if (node.type === "escape") {
    return { type: "escape", raw: node.raw, position };
  }

  if (node.type === "separator") {
    return { type: "separator", position };
  }

  if (node.type === "inline") {
    return {
      type: "inline",
      tag: node.tag,
      children: [],
      position,
    };
  }

  if (node.type === "raw") {
    return {
      type: "raw",
      tag: node.tag,
      args: [],
      content: node.content,
      position,
    };
  }

  if (node.type === "block") {
    return {
      type: "block",
      tag: node.tag,
      args: [],
      children: [],
      position,
    };
  }

  return assertUnreachable(node);
};

const shiftNode = (node: StructuralNode, delta: number, tracker: PositionTracker): StructuralNode => {
  const root = createShiftedNodeShell(node, delta, tracker);
  const stack: Array<{ source: StructuralNode; target: StructuralNode }> = [{ source: node, target: root }];
  const shouldExpandNestedNode = (candidate: StructuralNode): boolean =>
    candidate.type === "inline" || candidate.type === "raw" || candidate.type === "block";
  const appendShiftedNodes = (
    sourceNodes: readonly StructuralNode[],
    targetNodes: StructuralNode[],
  ): void => {
    for (let i = 0; i < sourceNodes.length; i++) {
      const sourceNode = sourceNodes[i];
      const targetNode = createShiftedNodeShell(sourceNode, delta, tracker);
      targetNodes.push(targetNode);
      if (shouldExpandNestedNode(sourceNode)) {
        stack.push({ source: sourceNode, target: targetNode });
      }
    }
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.source.type === "inline" && frame.target.type === "inline") {
      appendShiftedNodes(frame.source.children, frame.target.children);
      continue;
    }

    if (frame.source.type === "raw" && frame.target.type === "raw") {
      appendShiftedNodes(frame.source.args, frame.target.args);
      continue;
    }

    if (frame.source.type === "block" && frame.target.type === "block") {
      appendShiftedNodes(frame.source.args, frame.target.args);
      appendShiftedNodes(frame.source.children, frame.target.children);
      continue;
    }

    if (
      frame.source.type === "text" ||
      frame.source.type === "escape" ||
      frame.source.type === "separator"
    ) {
      continue;
    }

    throw new Error(`shiftNode(): unsupported frame source type: ${frame.source.type}`);
  }

  return root;
};

const shiftZone = (zone: Zone, delta: number, tracker: PositionTracker): Zone => ({
  startOffset: zone.startOffset + delta,
  endOffset: zone.endOffset + delta,
  nodes: zone.nodes.map((node) => shiftNode(node, delta, tracker)),
});

const findDirtyRange = (zones: readonly Zone[], edit: IncrementalEdit): { from: number; to: number } => {
  let firstOverlap = -1;
  let lastOverlap = -1;

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const intersects = zone.endOffset > edit.startOffset && zone.startOffset < edit.oldEndOffset;
    if (!intersects) continue;
    if (firstOverlap === -1) firstOverlap = i;
    lastOverlap = i;
  }

  if (firstOverlap !== -1) {
    return {
      from: Math.max(0, firstOverlap - 1),
      to: Math.min(zones.length - 1, lastOverlap + 1),
    };
  }

  let insertionIndex = zones.length;
  for (let i = 0; i < zones.length; i++) {
    if (zones[i].startOffset >= edit.startOffset) {
      insertionIndex = i;
      break;
    }
  }

  return {
    from: Math.max(0, insertionIndex - 1),
    to: Math.min(zones.length - 1, insertionIndex),
  };
};

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

export const parseIncremental = (
  source: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => {
  const tracker = buildPositionTracker(source);
  const tree = parseWithPositions(source, tracker, options);
  const zones = buildZones(tree);
  return {
    source,
    tree,
    zones,
    parseOptions: cloneParseOptions(options),
  };
};

/**
 * Update an incremental structural snapshot with one edit and a new full source.
 *
 * @experimental
 * Low-level updater for controlled integration paths.
 * For production applications, prefer `createIncrementalSession(...).applyEdit(...)`,
 * which guarantees fallback to full rebuild on errors.
 *
 * Assumption:
 * - Left boundary stabilization is conservative but fixed to one-zone lookbehind.
 * - Right boundary is expanded until stable (or EOF).
 *
 * If your edit may invalidate parsing state further left than one zone, prefer a full
 * rebuild via `parseIncremental(newSource, options)` for correctness.
 */
export const updateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => {
  assertValidEdit(doc, edit, newSource);

  // Fast path: empty cache means no incremental reuse is possible.
  if (doc.zones.length === 0) {
    return parseIncremental(newSource, options ?? doc.parseOptions);
  }

  // Defensive fallback for malformed snapshots where zones do not cover the tail.
  // Normal parser output should not hit this branch.
  if (hasUnsafeZoneCoverageTailGap(doc, edit)) {
    return parseIncremental(newSource, options ?? doc.parseOptions);
  }

  const parseOptions = options ? cloneParseOptions(options) : doc.parseOptions;
  const newTracker = buildPositionTracker(newSource);
  const cumulativeBudget = Math.max(newSource.length * 2, 1024);
  let cumulativeReparsedBytes = 0;

  const delta = newSource.length - doc.source.length;
  const dirty = findDirtyRange(doc.zones, edit);

  const dirtyFrom = dirty.from;
  let dirtyTo = dirty.to;
  let dirtyZones: Zone[] = [];

  // Boundary stabilization is right-expanding only.
  // We conservatively include one zone to the left in `findDirtyRange(...)`, then keep
  // expanding right until the reparsed right boundary matches or we reach EOF.
  while (true) {
    const dirtyStartOld = doc.zones[dirtyFrom].startOffset;
    const dirtyEndOld = doc.zones[dirtyTo].endOffset;
    const dirtyStartNew = mapOldOffsetToNew(edit, delta, dirtyStartOld);
    const dirtyEndNew = mapOldOffsetToNew(edit, delta, dirtyEndOld);
    const reparsedWindowSize = dirtyEndNew - dirtyStartNew;
    cumulativeReparsedBytes += reparsedWindowSize;

    if (cumulativeReparsedBytes > cumulativeBudget) {
      return parseIncremental(newSource, parseOptions);
    }

    const dirtyTree = parseWithPositions(
      newSource.slice(dirtyStartNew, dirtyEndNew),
      newTracker,
      parseOptions,
      dirtyStartNew,
    );
    dirtyZones = buildZones(dirtyTree);

    const reparsedEnd = dirtyZones.length > 0 ? dirtyZones[dirtyZones.length - 1].endOffset : dirtyStartNew;

    if (reparsedEnd === dirtyEndNew || dirtyTo === doc.zones.length - 1) {
      break;
    }

    dirtyTo += 1;
  }

  const leftZones = doc.zones.slice(0, dirtyFrom);
  const rightZones = doc.zones
    .slice(dirtyTo + 1)
    .map((zone) => shiftZone(zone, delta, newTracker));

  const zones = [...leftZones, ...dirtyZones, ...rightZones];

  return {
    source: newSource,
    zones,
    tree: flattenZones(zones),
    parseOptions,
  };
};

/**
 * @experimental
 * Low-level result-style updater.
 * For production applications, prefer `createIncrementalSession(...).applyEdit(...)`.
 */
export const tryUpdateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalUpdateResult => {
  try {
    return {
      ok: true,
      value: updateIncremental(doc, edit, newSource, options),
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

export const createIncrementalSession = (
  source: string,
  options?: IncrementalParseOptions,
  sessionOptions?: IncrementalSessionOptions,
): IncrementalSession => {
  let currentDoc = parseIncremental(source, options);
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

  const enterFullPreference = () => {
    preferFullMode = true;
    cooldownRemaining = fullPreferenceCooldownEdits;
    incrementalDurations.length = 0;
    fallbackMarks.length = 0;
  };

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
    currentDoc = parseIncremental(nextSource, nextOptions ?? currentDoc.parseOptions);
    const elapsedMs = now() - start;
    recordBounded(fullDurations, elapsedMs);
    return {
      doc: currentDoc,
      mode: "full-fallback",
      fallbackReason,
    };
  };

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
    currentDoc = parseIncremental(nextSource, nextOptions ?? currentDoc.parseOptions);
    return currentDoc;
  };

  const applyEdit = (
    edit: IncrementalEdit,
    newSource: string,
    nextOptions?: IncrementalParseOptions,
  ): IncrementalSessionApplyResult => {
    if (strategy === "full-only") {
      return runRebuild(newSource, nextOptions, "FULL_ONLY_STRATEGY");
    }

    const previousLength = Math.max(1, currentDoc.source.length);
    const replacedLength = Math.max(0, edit.oldEndOffset - edit.startOffset);
    const writtenLength = edit.newText.length;
    const editRatio = Math.max(replacedLength, writtenLength) / previousLength;

    if (strategy === "auto" && editRatio > maxEditRatioForIncremental) {
      const rebuiltResult = runRebuild(newSource, nextOptions, "AUTO_LARGE_EDIT");
      maybeAdaptPolicy();
      return rebuiltResult;
    }

    if (strategy === "auto" && preferFullMode && cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      if (cooldownRemaining === 0) {
        preferFullMode = false;
      }
      const rebuiltResult = runRebuild(newSource, nextOptions, "AUTO_COOLDOWN");
      maybeAdaptPolicy();
      return rebuiltResult;
    }

    const incrementalStart = now();
    const result = tryUpdateIncremental(currentDoc, edit, newSource, nextOptions);
    const incrementalElapsedMs = now() - incrementalStart;
    recordBounded(incrementalDurations, incrementalElapsedMs);

    if (result.ok) {
      currentDoc = result.value;
      recordBounded(fallbackMarks, 0);
      maybeAdaptPolicy();
      return { doc: currentDoc, mode: "incremental" };
    }

    recordBounded(fallbackMarks, 1);
    const rebuiltResult = runRebuild(newSource, nextOptions, result.error.code);
    maybeAdaptPolicy();
    return rebuiltResult;
  };

  return {
    getDocument: () => currentDoc,
    applyEdit,
    rebuild,
  };
};
