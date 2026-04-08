import { buildPositionTracker } from "./positions.js";
import { parseStructural } from "./structural.js";
import type {
  IncrementalDocument,
  IncrementalEdit,
  IncrementalParseOptions,
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

const shiftNode = (node: StructuralNode, delta: number, tracker: PositionTracker): StructuralNode => {
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
      children: node.children.map((child) => shiftNode(child, delta, tracker)),
      position,
    };
  }

  if (node.type === "raw") {
    return {
      type: "raw",
      tag: node.tag,
      args: node.args.map((arg) => shiftNode(arg, delta, tracker)),
      content: node.content,
      position,
    };
  }

  if (node.type === "block") {
    return {
      type: "block",
      tag: node.tag,
      args: node.args.map((arg) => shiftNode(arg, delta, tracker)),
      children: node.children.map((child) => shiftNode(child, delta, tracker)),
      position,
    };
  }

  return assertUnreachable(node);
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

  const delta = newSource.length - doc.source.length;
  const dirty = findDirtyRange(doc.zones, edit);

  let dirtyFrom = dirty.from;
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
