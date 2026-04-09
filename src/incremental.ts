import { buildPositionTracker } from "./positions.js";
import { parseStructural } from "./structural.js";
import { fnv1a, fnvFeedU32, fnvInit } from "./hash.js";
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const cloneSnapshotValueInternal = <T>(value: T, seen: WeakMap<object, unknown>): T => {
  if (Array.isArray(value)) {
    const seenArray = seen.get(value);
    if (seenArray) return seenArray as T;
    const next = new Array(value.length);
    seen.set(value, next);
    for (let i = 0; i < value.length; i++) {
      next[i] = cloneSnapshotValueInternal(value[i], seen);
    }
    return next as T;
  }
  if (isPlainObject(value)) {
    const seenObject = seen.get(value);
    if (seenObject) return seenObject as T;
    const next: Record<string, unknown> = {};
    seen.set(value, next);
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      next[key] = cloneSnapshotValueInternal(value[key], seen);
    }
    return next as T;
  }
  return value;
};

const cloneSnapshotValue = <T>(value: T): T =>
  cloneSnapshotValueInternal(value, new WeakMap<object, unknown>());

const cloneHandlersSnapshot = (
  handlers: IncrementalParseOptions["handlers"] | undefined,
): IncrementalParseOptions["handlers"] | undefined => {
  if (!handlers) return undefined;
  const next: Record<string, (typeof handlers)[string]> = {};
  const keys = Object.keys(handlers);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const handler = handlers[key];
    next[key] = handler ? cloneSnapshotValue(handler) : handler;
  }
  return next;
};

// Clone parse options into an isolated snapshot used by incremental state.
// Handler function references are preserved, while plain object/array fields are
// snapshot-copied recursively to avoid external in-place mutation changing session
// behavior implicitly.
const cloneParseOptions = (
  options: IncrementalParseOptions | undefined,
): IncrementalParseOptions | undefined => {
  if (!options) return undefined;
  return {
    ...options,
    handlers: cloneHandlersSnapshot(options.handlers),
    syntax: options.syntax ? { ...options.syntax } : undefined,
    tagName: options.tagName ? { ...options.tagName } : undefined,
    allowForms: options.allowForms ? [...options.allowForms] : undefined,
  };
};

let objectIdentitySeed = 1;
const objectIdentityMap = new WeakMap<object, number>();

const getObjectIdentity = (value: object | undefined): number => {
  if (!value) return 0;
  const cached = objectIdentityMap.get(value);
  if (cached) return cached;
  const next = objectIdentitySeed;
  objectIdentitySeed += 1;
  objectIdentityMap.set(value, next);
  return next;
};

const getIdentityForUnknown = (value: unknown): number => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    return getObjectIdentity(value);
  }
  return 0;
};

const buildHandlersShapeFingerprint = (handlers: unknown): number => {
  if (!handlers || typeof handlers !== "object") return 0;
  const record = handlers as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  let hash = fnvInit();
  hash = fnvFeedU32(hash, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const handler = record[key];
    hash = fnvFeedU32(hash, hashText(key));
    if (!handler || typeof handler !== "object") continue;
    const handlerRecord = handler as Record<string, unknown>;
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.inline));
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.raw));
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.block));
  }
  return hash >>> 0;
};

const DEFAULT_PARSE_OPTIONS_FINGERPRINT = fnvFeedU32(fnvInit(), 0x9e3779b9);

const buildParseOptionsFingerprint = (options: IncrementalParseOptions | undefined): number => {
  if (!options) return DEFAULT_PARSE_OPTIONS_FINGERPRINT;
  const syntax = options.syntax ?? {};
  const tagName = options.tagName ?? {};
  const allowForms = options.allowForms ?? [];

  let hash = fnvInit();
  hash = fnvFeedU32(hash, buildHandlersShapeFingerprint(options.handlers));
  hash = fnvFeedU32(hash, allowForms.length);
  for (let i = 0; i < allowForms.length; i++) {
    hash = fnvFeedU32(hash, hashText(allowForms[i]));
  }

  hash = fnvFeedU32(hash, hashText(syntax.tagOpen ?? ""));
  hash = fnvFeedU32(hash, hashText(syntax.tagClose ?? ""));
  hash = fnvFeedU32(hash, hashText(syntax.endTag ?? ""));
  hash = fnvFeedU32(hash, hashText(syntax.tagDivider ?? ""));
  hash = fnvFeedU32(hash, hashText(syntax.rawOpen ?? ""));
  hash = fnvFeedU32(hash, hashText(syntax.rawClose ?? ""));
  hash = fnvFeedU32(hash, hashText(syntax.blockOpen ?? ""));
  hash = fnvFeedU32(hash, hashText(syntax.blockClose ?? ""));

  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagStartChar as object | undefined));
  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagChar as object | undefined));
  return hash >>> 0;
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

// Right-reuse safety gate:
// `updateIncremental(...)` only reuses shifted right-side zones after a seam probe reparse
// confirms boundary-adjacent structure remains stable. Mismatch => full rebuild.

const LEFT_LOOKBEHIND_ZONES = 1;
const RIGHT_REUSE_PROBE_ZONES = 2;
const RIGHT_REUSE_PROBE_EXTRA_ZONES = 1;
const RIGHT_REUSE_PROBE_SIGNATURE_NODE_BUDGET = 4096;

const NODE_TAG_TEXT = 1;
const NODE_TAG_ESCAPE = 2;
const NODE_TAG_SEPARATOR = 3;
const NODE_TAG_INLINE = 4;
const NODE_TAG_RAW = 5;
const NODE_TAG_BLOCK = 6;
const ZONE_TAG = 7;

const zoneSignatureCache = new WeakMap<Zone, number>();
const parseOptionsFingerprintCache = new WeakMap<IncrementalDocument, number>();

interface SignatureBudget {
  remaining: number;
}

interface IncrementalDebugStats {
  cumulativeReparsedBytes: number;
  probeSliceBytes: number;
  fellBackToFull: boolean;
}

type IncrementalDebugSink = (stats: IncrementalDebugStats) => void;
type InternalUpdateMode = "incremental" | "internal-full-rebuild";
type InternalUpdateObserver = (mode: InternalUpdateMode) => void;

let incrementalDebugSink: IncrementalDebugSink | undefined;

/** @internal test-only hook */
export const __setIncrementalDebugSink = (sink?: IncrementalDebugSink): void => {
  incrementalDebugSink = sink;
};

const hashText = (value: string): number => fnv1a(value);

const getCachedOptionsFingerprint = (doc: IncrementalDocument): number | undefined =>
  parseOptionsFingerprintCache.get(doc);

const setCachedOptionsFingerprint = (doc: IncrementalDocument, fingerprint: number): void => {
  parseOptionsFingerprintCache.set(doc, fingerprint);
};

const tryConsumeSignatureBudget = (budget: SignatureBudget): boolean => {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
};

const nodeSignature = (node: StructuralNode, budget?: SignatureBudget): number | undefined => {
  if (budget && !tryConsumeSignatureBudget(budget)) return undefined;
  if (node.type === "text") {
    let hash = fnvInit();
    hash = fnvFeedU32(hash, NODE_TAG_TEXT);
    hash = fnvFeedU32(hash, node.value.length);
    hash = fnvFeedU32(hash, hashText(node.value));
    return hash >>> 0;
  }
  if (node.type === "escape") {
    let hash = fnvInit();
    hash = fnvFeedU32(hash, NODE_TAG_ESCAPE);
    hash = fnvFeedU32(hash, node.raw.length);
    hash = fnvFeedU32(hash, hashText(node.raw));
    return hash >>> 0;
  }
  if (node.type === "separator") {
    return NODE_TAG_SEPARATOR;
  }
  if (node.type === "inline") {
    let hash = fnvInit();
    hash = fnvFeedU32(hash, NODE_TAG_INLINE);
    hash = fnvFeedU32(hash, hashText(node.tag));
    for (let i = 0; i < node.children.length; i++) {
      const childHash = nodeSignature(node.children[i], budget);
      if (childHash === undefined) return undefined;
      hash = fnvFeedU32(hash, childHash);
    }
    return hash >>> 0;
  }
  if (node.type === "raw") {
    let hash = fnvInit();
    hash = fnvFeedU32(hash, NODE_TAG_RAW);
    hash = fnvFeedU32(hash, hashText(node.tag));
    hash = fnvFeedU32(hash, node.content.length);
    hash = fnvFeedU32(hash, hashText(node.content));
    for (let i = 0; i < node.args.length; i++) {
      const argHash = nodeSignature(node.args[i], budget);
      if (argHash === undefined) return undefined;
      hash = fnvFeedU32(hash, argHash);
    }
    return hash >>> 0;
  }
  if (node.type === "block") {
    let hash = fnvInit();
    hash = fnvFeedU32(hash, NODE_TAG_BLOCK);
    hash = fnvFeedU32(hash, hashText(node.tag));
    for (let i = 0; i < node.args.length; i++) {
      const argHash = nodeSignature(node.args[i], budget);
      if (argHash === undefined) return undefined;
      hash = fnvFeedU32(hash, argHash);
    }
    for (let i = 0; i < node.children.length; i++) {
      const childHash = nodeSignature(node.children[i], budget);
      if (childHash === undefined) return undefined;
      hash = fnvFeedU32(hash, childHash);
    }
    return hash >>> 0;
  }
  return assertUnreachable(node);
};

const zoneSignature = (zone: Zone, budget?: SignatureBudget): number | undefined => {
  if (!budget) {
    const cached = zoneSignatureCache.get(zone);
    if (cached !== undefined) return cached;
  }
  let hash = fnvInit();
  hash = fnvFeedU32(hash, ZONE_TAG);
  hash = fnvFeedU32(hash, zone.endOffset - zone.startOffset);
  for (let i = 0; i < zone.nodes.length; i++) {
    const signature = nodeSignature(zone.nodes[i], budget);
    if (signature === undefined) return undefined;
    hash = fnvFeedU32(hash, signature);
  }
  const finalized = hash >>> 0;
  if (!budget) {
    zoneSignatureCache.set(zone, finalized);
  }
  return finalized;
};

const isSafeRightReuse = (
  oldRightZones: readonly Zone[],
  newSource: string,
  seamNewOffset: number,
  delta: number,
  tracker: PositionTracker,
  parseOptions: IncrementalParseOptions | undefined,
): { ok: boolean; probeSliceBytes: number } => {
  if (oldRightZones.length === 0) return { ok: true, probeSliceBytes: 0 };

  const probeZoneCount = Math.min(RIGHT_REUSE_PROBE_ZONES, oldRightZones.length);
  const probeWindowZoneCount = Math.min(
    oldRightZones.length,
    probeZoneCount + RIGHT_REUSE_PROBE_EXTRA_ZONES,
  );
  const probeStartOld = oldRightZones[0].startOffset;
  const probeEndOld = oldRightZones[probeWindowZoneCount - 1].endOffset;
  const probeLength = probeEndOld - probeStartOld;
  const probeEndNew = seamNewOffset + probeLength;

  const probeTree = parseWithPositions(
    newSource.slice(seamNewOffset, probeEndNew),
    tracker,
    parseOptions,
    seamNewOffset,
  );
  const probeZones = buildZones(probeTree);
  if (probeZones.length < probeZoneCount) return { ok: false, probeSliceBytes: probeLength };
  const signatureBudget: SignatureBudget = {
    remaining: RIGHT_REUSE_PROBE_SIGNATURE_NODE_BUDGET,
  };

  for (let i = 0; i < probeZoneCount; i++) {
    const expected = oldRightZones[i];
    const actual = probeZones[i];
    if (actual.startOffset !== expected.startOffset + delta) return { ok: false, probeSliceBytes: probeLength };
    if (actual.endOffset !== expected.endOffset + delta) return { ok: false, probeSliceBytes: probeLength };
    if (actual.nodes.length !== expected.nodes.length) return { ok: false, probeSliceBytes: probeLength };
    const actualSignature = zoneSignature(actual, signatureBudget);
    if (actualSignature === undefined) return { ok: false, probeSliceBytes: probeLength };
    const expectedSignature = zoneSignature(expected);
    if (expectedSignature === undefined || actualSignature !== expectedSignature) {
      return { ok: false, probeSliceBytes: probeLength };
    }
  }

  return { ok: true, probeSliceBytes: probeLength };
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

const shiftZoneWithSignature = (zone: Zone, delta: number, tracker: PositionTracker): Zone => {
  const shifted = shiftZone(zone, delta, tracker);
  const signature = zoneSignature(zone);
  if (signature !== undefined) {
    zoneSignatureCache.set(shifted, signature);
  }
  return shifted;
};

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
      from: Math.max(0, firstOverlap - LEFT_LOOKBEHIND_ZONES),
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
    from: Math.max(0, insertionIndex - LEFT_LOOKBEHIND_ZONES),
    to: Math.min(zones.length - 1, insertionIndex),
  };
};

const reparseDirtyWindowUntilStable = (
  doc: IncrementalDocument,
  dirtyFrom: number,
  dirtyTo: number,
  edit: IncrementalEdit,
  delta: number,
  newSource: string,
  tracker: PositionTracker,
  parseOptions: IncrementalParseOptions | undefined,
  cumulativeBudget: number,
  cumulativeReparsedBytes: number,
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
    const dirtyStartOld = doc.zones[dirtyFrom].startOffset;
    const dirtyEndOld = doc.zones[nextDirtyTo].endOffset;
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
    nextDirtyZones = buildZones(dirtyTree);

    const reparsedEnd =
      nextDirtyZones.length > 0 ? nextDirtyZones[nextDirtyZones.length - 1].endOffset : dirtyStartNew;
    if (reparsedEnd === dirtyEndNew || nextDirtyTo === doc.zones.length - 1) {
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
  for (let i = 0; i < zones.length; i++) {
    zoneSignature(zones[i]);
  }
  const parseOptions = cloneParseOptions(options);
  const fingerprint = buildParseOptionsFingerprint(parseOptions);
  const doc = {
    source,
    tree,
    zones,
    parseOptions,
  };
  setCachedOptionsFingerprint(doc, fingerprint);
  return doc;
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
 *
 */
const updateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
  __internalObserver?: InternalUpdateObserver,
): IncrementalDocument => {
  assertValidEdit(doc, edit, newSource);
  let cumulativeReparsedBytes = 0;
  let probeSliceBytes = 0;
  const emitDebug = (fellBackToFull: boolean) => {
    incrementalDebugSink?.({
      cumulativeReparsedBytes,
      probeSliceBytes,
      fellBackToFull,
    });
  };

  const previousOptionsFingerprint =
    getCachedOptionsFingerprint(doc) ?? buildParseOptionsFingerprint(doc.parseOptions);
  const nextOptionsFingerprint = options
    ? buildParseOptionsFingerprint(options)
    : previousOptionsFingerprint;
  const runtimeParseOptions = options ?? doc.parseOptions;
  const nextParseOptionsSnapshot = options ? cloneParseOptions(options) : doc.parseOptions;
  if (previousOptionsFingerprint !== nextOptionsFingerprint) {
    const rebuilt = parseIncremental(newSource, runtimeParseOptions);
    emitDebug(true);
    __internalObserver?.("internal-full-rebuild");
    return rebuilt;
  }

  // Fast path: empty cache means no incremental reuse is possible.
  if (doc.zones.length === 0) {
    const rebuilt = parseIncremental(newSource, runtimeParseOptions);
    emitDebug(true);
    __internalObserver?.("internal-full-rebuild");
    return rebuilt;
  }

  // Defensive fallback for malformed snapshots where zones do not cover the tail.
  // Normal parser output should not hit this branch.
  if (hasUnsafeZoneCoverageTailGap(doc, edit)) {
    const rebuilt = parseIncremental(newSource, runtimeParseOptions);
    emitDebug(true);
    __internalObserver?.("internal-full-rebuild");
    return rebuilt;
  }

  const newTracker = buildPositionTracker(newSource);
  const cumulativeBudget = Math.max(newSource.length * 2, 1024);

  const delta = newSource.length - doc.source.length;
  const dirty = findDirtyRange(doc.zones, edit);

  let dirtyFrom = dirty.from;
  let dirtyTo = dirty.to;
  let dirtyZones: Zone[] = [];

  const firstReparse = reparseDirtyWindowUntilStable(
    doc,
    dirtyFrom,
    dirtyTo,
    edit,
    delta,
    newSource,
    newTracker,
    runtimeParseOptions,
    cumulativeBudget,
    cumulativeReparsedBytes,
  );
  cumulativeReparsedBytes = firstReparse.cumulativeReparsedBytes;
  if (firstReparse.budgetExceeded) {
    const rebuilt = parseIncremental(newSource, runtimeParseOptions);
    emitDebug(true);
    __internalObserver?.("internal-full-rebuild");
    return rebuilt;
  }
  dirtyTo = firstReparse.dirtyTo;
  dirtyZones = firstReparse.dirtyZones;

  const leftZones = doc.zones.slice(0, dirtyFrom);
  const oldRightZones = doc.zones.slice(dirtyTo + 1);
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
    );
    probeSliceBytes = rightReuseCheck.probeSliceBytes;
    if (!rightReuseCheck.ok) {
      const rebuilt = parseIncremental(newSource, runtimeParseOptions);
      emitDebug(true);
      __internalObserver?.("internal-full-rebuild");
      return rebuilt;
    }
  }
  const rightZones = oldRightZones.map((zone) => shiftZoneWithSignature(zone, delta, newTracker));

  const zones = [...leftZones, ...dirtyZones, ...rightZones];

  const updated = {
    source: newSource,
    zones,
    tree: flattenZones(zones),
    parseOptions: nextParseOptionsSnapshot,
  };
  setCachedOptionsFingerprint(updated, nextOptionsFingerprint);
  emitDebug(false);
  __internalObserver?.("incremental");
  return updated;
};

export const updateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalDocument => updateIncrementalInternal(doc, edit, newSource, options);

/**
 * @experimental
 * Low-level result-style updater.
 * For production applications, prefer `createIncrementalSession(...).applyEdit(...)`.
 *
 */
const tryUpdateIncrementalInternal = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
  __internalObserver?: InternalUpdateObserver,
): IncrementalUpdateResult => {
  try {
    return {
      ok: true,
      value: updateIncrementalInternal(doc, edit, newSource, options, __internalObserver),
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

export const tryUpdateIncremental = (
  doc: IncrementalDocument,
  edit: IncrementalEdit,
  newSource: string,
  options?: IncrementalParseOptions,
): IncrementalUpdateResult => tryUpdateIncrementalInternal(doc, edit, newSource, options);

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
    let mode: InternalUpdateMode | undefined;
    const result = tryUpdateIncrementalInternal(currentDoc, edit, newSource, nextOptions, (nextTelemetry) => {
      mode = nextTelemetry;
    });
    const incrementalElapsedMs = now() - incrementalStart;
    recordBounded(incrementalDurations, incrementalElapsedMs);

    if (result.ok) {
      currentDoc = result.value;
      const internalFullRebuild = mode === "internal-full-rebuild";
      recordBounded(fallbackMarks, internalFullRebuild ? 1 : 0);
      maybeAdaptPolicy();
      if (internalFullRebuild) {
        return {
          doc: currentDoc,
          mode: "full-fallback",
          fallbackReason: "INTERNAL_FULL_REBUILD",
        };
      }
      return {
        doc: currentDoc,
        mode: "incremental",
      };
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
