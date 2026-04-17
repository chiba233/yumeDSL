// noinspection DuplicatedCode

import assert from "node:assert/strict";
import {
  type StructuralNode,
  type TagHandler,
  type TextToken,
  type TokenDiffResult,
  createSimpleBlockHandlers,
  createIncrementalSession,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  buildZones,
  parseIncremental,
  parseStructural,
} from "../src/index.ts";
import { buildConservativeTokenDiff, computeTokenDiff } from "../src/incremental/diff.ts";
import { __setIncrementalDebugSink, tryUpdateIncremental, updateIncremental } from "../src/incremental/incremental.ts";
import { buildParseOptionsFingerprint, cloneParseOptions } from "../src/incremental/options.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

type StructuralDiffOp = TokenDiffResult["ops"][number];

const parseFull = (source: string, options?: Parameters<typeof parseStructural>[1]) => {
  const tree = parseStructural(source, { ...options, trackPositions: true });
  const zones = buildZones(tree);
  return { tree, zones };
};

const applyEdit = (source: string, start: number, end: number, newText: string): string =>
  source.slice(0, start) + newText + source.slice(end);

const makeNestedInline = (depth: number): string => {
  let text = "x";
  for (let i = 0; i < depth; i++) {
    text = `$$bold(${text})$$`;
  }
  return text;
};

const stripNodePositions = (node: StructuralNode): StructuralNode => {
  if (node.type === "text") {
    return { type: "text", value: node.value };
  }
  if (node.type === "escape") {
    return { type: "escape", raw: node.raw };
  }
  if (node.type === "separator") {
    return { type: "separator" };
  }
  if (node.type === "inline") {
    const inlineNode: Extract<StructuralNode, { type: "inline" }> = {
      type: "inline",
      tag: node.tag,
      children: node.children.map(stripNodePositions),
    };
    if (node.implicitInlineShorthand) {
      inlineNode.implicitInlineShorthand = true;
    }
    return inlineNode;
  }
  if (node.type === "raw") {
    return {
      type: "raw",
      tag: node.tag,
      args: node.args.map(stripNodePositions),
      content: node.content,
    };
  }
  return {
    type: "block",
    tag: node.tag,
    args: node.args.map(stripNodePositions),
    children: node.children.map(stripNodePositions),
  };
};

const stripTreePositions = (nodes: readonly StructuralNode[]): StructuralNode[] => nodes.map(stripNodePositions);

const resolveNodeAtPath = (
  nodes: StructuralNode[],
  path: ReadonlyArray<{ field: "root" | "children" | "args"; index: number }>,
): StructuralNode => {
  let currentNode: StructuralNode | undefined;
  for (const segment of path) {
    let container: StructuralNode[];
    if (segment.field === "root") {
      container = nodes;
    } else if (segment.field === "children") {
      assert.ok(currentNode);
      assert.ok(currentNode.type === "inline" || currentNode.type === "block");
      container = currentNode.children;
    } else {
      assert.ok(currentNode);
      assert.ok(currentNode.type === "raw" || currentNode.type === "block");
      container = currentNode.args;
    }
    currentNode = container[segment.index];
    assert.ok(currentNode);
  }
  assert.ok(currentNode);
  return currentNode;
};

const resolveContainerForSplice = (
  nodes: StructuralNode[],
  op: Extract<StructuralDiffOp, { kind: "splice" }>,
): StructuralNode[] => {
  if (op.field === "root") {
    assert.equal(op.path.length, 0);
    return nodes;
  }
  const owner = resolveNodeAtPath(nodes, op.path);
  if (op.field === "children") {
    assert.ok(owner.type === "inline" || owner.type === "block");
    return owner.children;
  }
  assert.ok(owner.type === "raw" || owner.type === "block");
  return owner.args;
};

const applyStructuralDiffOps = (
  previous: readonly StructuralNode[],
  ops: readonly StructuralDiffOp[],
): StructuralNode[] => {
  const draft = stripTreePositions(previous);
  for (const op of ops) {
    if (op.kind === "splice") {
      const container = resolveContainerForSplice(draft, op);
      container.splice(op.oldRange.start, op.oldRange.end - op.oldRange.start, ...stripTreePositions(op.newNodes));
      continue;
    }
    const node = resolveNodeAtPath(draft, op.path);
    if (op.kind === "set-text") {
      assert.equal(node.type, "text");
      node.value = op.newValue;
      continue;
    }
    if (op.kind === "set-escape") {
      assert.equal(node.type, "escape");
      node.raw = op.newValue;
      continue;
    }
    if (op.kind === "set-raw-content") {
      assert.equal(node.type, "raw");
      node.content = op.newValue;
      continue;
    }
    assert.equal(op.kind, "set-implicit-inline-shorthand");
    assert.equal(node.type, "inline");
    if (op.newValue) {
      node.implicitInlineShorthand = true;
    } else {
      delete node.implicitInlineShorthand;
    }
  }
  return draft;
};

const assertDiffRebuildsNextTree = (
  previous: readonly StructuralNode[],
  next: readonly StructuralNode[],
  diff: {
    patches: Array<{ oldRange: { start: number; end: number }; newRange: { start: number; end: number } }>;
    unchangedRanges: Array<{ oldRange: { start: number; end: number }; newRange: { start: number; end: number } }>;
    ops: StructuralDiffOp[];
  },
): void => {
  const segments = [...diff.unchangedRanges, ...diff.patches].sort(
    (a, b) => a.newRange.start - b.newRange.start || a.oldRange.start - b.oldRange.start,
  );
  const rebuilt: StructuralNode[] = [];
  let oldCursor = 0;
  let newCursor = 0;

  for (const segment of segments) {
    assert.equal(segment.oldRange.start, oldCursor);
    assert.equal(segment.newRange.start, newCursor);

    const previousSlice = previous.slice(segment.oldRange.start, segment.oldRange.end);
    const nextSlice = next.slice(segment.newRange.start, segment.newRange.end);
    if (
      segment.oldRange.end > segment.oldRange.start &&
      segment.newRange.end > segment.newRange.start &&
      diff.unchangedRanges.includes(segment)
    ) {
      assert.deepEqual(previousSlice.map(stripNodePositions), nextSlice.map(stripNodePositions));
    }

    rebuilt.push(...nextSlice);
    oldCursor = segment.oldRange.end;
    newCursor = segment.newRange.end;
  }

  assert.equal(oldCursor, previous.length);
  assert.equal(newCursor, next.length);
  assert.deepEqual(rebuilt, next);
  assert.deepEqual(applyStructuralDiffOps(previous, diff.ops), stripTreePositions(next));
};

const captureIncrementalDebug = (run: () => void) => {
  let captured:
    | {
        cumulativeReparsedBytes: number;
        probeSliceBytes: number;
        fellBackToFull: boolean;
      }
    | undefined;
  __setIncrementalDebugSink((stats) => {
    captured = stats;
  });
  try {
    run();
  } finally {
    __setIncrementalDebugSink(undefined);
  }
  return captured;
};

const cases: GoldenCase[] = [
  {
    name: "[Incremental/Init] parseIncremental should match full structural parse",
    run: () => {
      const source = "a $$bold(b)$$ c\\n$$code(ts)%\\nx\\n%end$$\\nend";
      const doc = parseIncremental(source);
      const full = parseFull(source);

      assert.deepEqual(doc.tree, full.tree);
      assert.deepEqual(doc.zones, full.zones);
    },
  },
  {
    name: "[Incremental/Init] parseIncremental may split pure-inline zones for incremental granularity",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const source = "$$bold(x)$$ ".repeat(120);
      const doc = parseIncremental(source, { handlers });
      const full = parseFull(source, { handlers });

      assert.deepEqual(doc.tree, full.tree);
      assert.ok(doc.zones.length > full.zones.length);
    },
  },
  {
    name: "[Incremental/Replace] updateIncremental should match full reparse",
    run: () => {
      const source = "hello $$bold(world)$$";
      const start = source.indexOf("world");
      const end = start + "world".length;
      const newSource = applyEdit(source, start, end, "DSL");

      const doc = parseIncremental(source);
      const next = updateIncremental(
        doc,
        { startOffset: start, oldEndOffset: end, newText: "DSL" },
        newSource,
      );
      const full = parseFull(newSource);

      assert.equal(next.source, newSource);
      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/Insert] updateIncremental should handle insertion between zones",
    run: () => {
      const source = "$$code(ts)%\\nA\\n%end$$\\n$$note()*\\nB\\n*end$$";
      const insertAt = source.indexOf("\\n$$note");
      const inserted = "\\nmid-text";
      const newSource = applyEdit(source, insertAt, insertAt, inserted);

      const doc = parseIncremental(source);
      const next = updateIncremental(
        doc,
        { startOffset: insertAt, oldEndOffset: insertAt, newText: inserted },
        newSource,
      );
      const full = parseFull(newSource);

      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/InsertAt0] updateIncremental should handle insertion at offset 0",
    run: () => {
      const source = "$$code(ts)%\\nA\\n%end$$\\nend";
      const inserted = "prefix\\n";
      const newSource = applyEdit(source, 0, 0, inserted);

      const doc = parseIncremental(source);
      const next = updateIncremental(doc, { startOffset: 0, oldEndOffset: 0, newText: inserted }, newSource);
      const full = parseFull(newSource);

      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/Expand] dirty range should expand when right boundary is unstable",
    run: () => {
      const source = "$$note()*\\nA\\n*end$$\\nmid\\n$$code(ts)%\\nB\\n%end$$\\nend";
      const closeStart = source.indexOf("*end$$");
      const closeEnd = closeStart + "*end$$".length;
      const newSource = applyEdit(source, closeStart, closeEnd, "");

      const doc = parseIncremental(source);
      const next = updateIncremental(
        doc,
        { startOffset: closeStart, oldEndOffset: closeEnd, newText: "" },
        newSource,
      );
      const full = parseFull(newSource);

      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/EmptyZones] updateIncremental should rebuild when zones are empty",
    run: () => {
      const source = "";
      const doc = parseIncremental(source);

      const newSource = "a";
      const next = updateIncremental(doc, { startOffset: 0, oldEndOffset: 0, newText: "a" }, newSource);
      const full = parseFull(newSource);

      assert.equal(next.source, newSource);
      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/Fallback] malformed tail gap snapshot should fallback to full rebuild",
    run: () => {
      const source = "$$bold(x)$$ tail";
      const doc = parseIncremental(source);
      assert.ok(doc.zones.length > 0);

      const zones = [...doc.zones];
      const last = zones[zones.length - 1];
      // Construct a malformed snapshot: pretend zones stop early.
      zones[zones.length - 1] = { ...last, endOffset: Math.max(0, last.endOffset - 1) };

      const malformedDoc = { ...doc, zones };

      const newSource = source + "X";
      const startOffset = source.length;
      const result = updateIncremental(
        malformedDoc,
        { startOffset, oldEndOffset: startOffset, newText: "X" },
        newSource,
      );
      const full = parseFull(newSource);

      assert.deepEqual(result.tree, full.tree);
      assert.deepEqual(result.zones, full.zones);
    },
  },
  {
    name: "[Incremental/ShiftRight] updateIncremental should shift untouched right-side zones",
    run: () => {
      const handlers = {
        ...createSimpleInlineHandlers(["bold"]),
        ...createSimpleRawHandlers(["code"]),
        ...createSimpleBlockHandlers(["note"]),
      };

      const source = [
        "head $$bold(a)$$",
        "$$code(ts)%",
        "A",
        "%end$$",
        "$$code(js)%",
        "B",
        "%end$$",
        "$$note(title|x)*",
        "C\\\\$$",
        "*end$$",
        "trail $$bold(c|d)$$",
      ].join("\n");

      const start = source.indexOf("a");
      const end = start + 1;
      const newText = "abcdef";
      const newSource = applyEdit(source, start, end, newText);

      const doc = parseIncremental(source, { handlers });
      const next = updateIncremental(
        doc,
        { startOffset: start, oldEndOffset: end, newText },
        newSource,
      );
      const full = parseFull(newSource, { handlers });

      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/ExpandRight] malformed zone endOffset should trigger right expansion",
    run: () => {
      const handlers = {
        ...createSimpleRawHandlers(["code"]),
      };

      const source = [
        "L",
        "$$code(ts)%",
        "A",
        "%end$$",
        "R",
        "$$code(js)%",
        "B",
        "%end$$",
        "END",
      ].join("\n");
      const doc = parseIncremental(source, { handlers });
      assert.ok(doc.zones.length >= 3, `expected >=3 zones, got: ${doc.zones.length}`);

      const zones = [...doc.zones];
      const dirtyIndex = 1;
      zones[dirtyIndex] = { ...zones[dirtyIndex], endOffset: zones[dirtyIndex].endOffset + 1000 };
      const malformedDoc = { ...doc, zones };

      const insertAt = 1;
      const newText = "X";
      const newSource = applyEdit(source, insertAt, insertAt, newText);

      const next = updateIncremental(
        malformedDoc,
        { startOffset: insertAt, oldEndOffset: insertAt, newText },
        newSource,
      );
      const full = parseFull(newSource, { handlers });

      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/Validation] invalid edit/newSource pair should throw",
    run: () => {
      const source = "abc";
      const doc = parseIncremental(source);

      assert.throws(
        () => updateIncremental(doc, { startOffset: 1, oldEndOffset: 2, newText: "XYZ" }, "abc"),
        /newSource length/,
      );

      try {
        updateIncremental(doc, { startOffset: 1, oldEndOffset: 2, newText: "XYZ" }, "abc");
      } catch (error) {
        assert.equal((error as { code?: string }).code, "NEW_SOURCE_LENGTH_MISMATCH");
      }
    },
  },
  {
    name: "[Incremental/Validation] edit.newText should match newSource slice",
    run: () => {
      const source = "abcd";
      const doc = parseIncremental(source);
      const newSource = "abXYd";

      assert.throws(
        () => updateIncremental(doc, { startOffset: 2, oldEndOffset: 3, newText: "ZZ" }, newSource),
        /edit\.newText/,
      );
    },
  },
  {
    name: "[Incremental/Options] parse options snapshot should not be mutated by caller",
    run: () => {
      const source = "$$bold(x)$$";
      const options: { handlers: Record<string, TagHandler> } = {
        handlers: createSimpleInlineHandlers(["bold"]),
      };

      const doc = parseIncremental(source, options);
      options.handlers = {};

      const next = updateIncremental(
        doc,
        { startOffset: source.indexOf("x"), oldEndOffset: source.indexOf("x") + 1, newText: "y" },
        "$$bold(y)$$",
      );
      const full = parseFull("$$bold(y)$$");

      assert.deepEqual(next.tree, full.tree);
    },
  },
  {
    name: "[Incremental/Options] external handler mutation should not affect captured snapshot",
    run: () => {
      // 文档需要 >1 zone 才能走增量路径（≤1 zone 会被 guard 短路到 full rebuild）
      const source = "$$bold(x)$$\n$$code(ts)%\nhello\n%end$$";
      const baseHandlers = createSimpleInlineHandlers(["bold"]);
      const rawHandlers = createSimpleRawHandlers(["code"]);
      const handlers: Record<string, TagHandler & { meta?: { unstable: boolean } }> = {
        ...rawHandlers,
        bold: {
          ...baseHandlers.bold,
          meta: { unstable: true },
        },
      };
      const doc = parseIncremental(source, { handlers });
      const snapshotHandlers = doc.parseOptions?.handlers as
        | Record<string, TagHandler & { meta?: { unstable: boolean } }>
        | undefined;
      assert.equal(snapshotHandlers?.bold.meta?.unstable, true);

      handlers.bold.meta!.unstable = false;
      assert.equal(snapshotHandlers?.bold.meta?.unstable, true);

      const nextSource = "$$bold(y)$$\n$$code(ts)%\nhello\n%end$$";
      const stats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: source.indexOf("x"), oldEndOffset: source.indexOf("x") + 1, newText: "y" },
          nextSource,
        );
      });

      assert.ok(stats);
      assert.equal(stats.fellBackToFull, false);
    },
  },
  {
    name: "[Incremental/Options] equivalent fingerprint options should still replace snapshot",
    run: () => {
      const source = "$$bold(x)$$";
      const inline = (tokens: TextToken[]) => ({ type: "bold", value: tokens });
      const handlers1: Record<string, TagHandler & { meta: { mode: string } }> = {
        bold: { inline, meta: { mode: "a" } },
      };
      const handlers2: Record<string, TagHandler & { meta: { mode: string } }> = {
        bold: { inline, meta: { mode: "b" } },
      };
      const doc = parseIncremental(source, { handlers: handlers1 });
      const next = updateIncremental(
        doc,
        { startOffset: source.indexOf("x"), oldEndOffset: source.indexOf("x") + 1, newText: "y" },
        "$$bold(y)$$",
        { handlers: handlers2 },
      );
      const snapshotHandlers = next.parseOptions?.handlers as
        | Record<string, TagHandler & { meta?: { mode: string } }>
        | undefined;

      assert.equal(snapshotHandlers?.bold.meta?.mode, "b");
    },
  },
  {
    name: "[Incremental/Options] cyclic metadata should be snapshot-safe",
    run: () => {
      const source = "$$bold(x)$$";
      const inline = (tokens: TextToken[]) => ({ type: "bold", value: tokens });
      const meta: { mode: string; self?: unknown } = { mode: "a" };
      meta.self = meta;
      const handlers: Record<string, TagHandler & { meta: { mode: string; self?: unknown } }> = {
        bold: { inline, meta },
      };

      const doc = parseIncremental(source, { handlers });
      const snapshotHandlers = doc.parseOptions?.handlers as
        | Record<string, TagHandler & { meta?: { mode: string; self?: unknown } }>
        | undefined;
      const snapshotMeta = snapshotHandlers?.bold.meta;

      assert.ok(snapshotMeta);
      assert.notEqual(snapshotMeta, meta);
      assert.equal(snapshotMeta?.mode, "a");
      assert.equal(snapshotMeta?.self, snapshotMeta);
    },
  },
  {
    name: "[Incremental/Options] cloneParseOptions should re-clone nested arrays from frozen snapshots",
    run: () => {
      const inline = (tokens: TextToken[]) => ({ type: "bold", value: tokens });
      const handlers: Record<string, TagHandler & { meta: { variants: Array<{ mode: string }> } }> = {
        bold: {
          inline,
          meta: {
            variants: [{ mode: "a" }, { mode: "b" }],
          },
        },
      };
      const first = cloneParseOptions({
        handlers,
      });
      const second = cloneParseOptions(first);
      const firstHandlers = first?.handlers as
        | Record<string, TagHandler & { meta?: { variants?: Array<{ mode: string }> } }>
        | undefined;
      const secondHandlers = second?.handlers as
        | Record<string, TagHandler & { meta?: { variants?: Array<{ mode: string }> } }>
        | undefined;
      const firstVariants = firstHandlers?.bold.meta?.variants;
      const secondVariants = secondHandlers?.bold.meta?.variants;

      assert.ok(first);
      assert.ok(second);
      assert.notEqual(second, first);
      assert.ok(firstVariants);
      assert.ok(secondVariants);
      assert.notEqual(secondVariants, firstVariants);
      assert.notEqual(secondVariants?.[0], firstVariants?.[0]);

      if (secondVariants?.[0]) {
        secondVariants[0].mode = "changed";
      }

      assert.equal(firstVariants?.[0]?.mode, "a");
      assert.equal(secondVariants?.[0]?.mode, "changed");
    },
  },
  {
    name: "[Incremental/Fingerprint] shorthand boolean mode should change fingerprint",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const base = { handlers };

      const defaultFingerprint = buildParseOptionsFingerprint(base);
      const falseFingerprint = buildParseOptionsFingerprint({ ...base, implicitInlineShorthand: false });
      const trueFingerprint = buildParseOptionsFingerprint({ ...base, implicitInlineShorthand: true });

      assert.equal(falseFingerprint, defaultFingerprint);
      assert.notEqual(trueFingerprint, defaultFingerprint);
      assert.notEqual(trueFingerprint, falseFingerprint);
    },
  },
  {
    name: "[Incremental/TryUpdate] should return ok:true on valid update",
    run: () => {
      const source = "hello $$bold(world)$$";
      const doc = parseIncremental(source);
      const start = source.indexOf("world");
      const end = start + "world".length;
      const newSource = applyEdit(source, start, end, "dsl");

      const result = tryUpdateIncremental(
        doc,
        { startOffset: start, oldEndOffset: end, newText: "dsl" },
        newSource,
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        const full = parseFull(newSource);
        assert.deepEqual(result.value.tree, full.tree);
      }
    },
  },
  {
    name: "[Incremental/TryUpdate] should return ok:false on invalid update",
    run: () => {
      const source = "abc";
      const doc = parseIncremental(source);
      const result = tryUpdateIncremental(
        doc,
        { startOffset: 1, oldEndOffset: 2, newText: "XYZ" },
        "abc",
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "NEW_SOURCE_LENGTH_MISMATCH");
      }
    },
  },
  {
    name: "[Incremental/TryUpdate] should return ok:false with INVALID_EDIT_RANGE",
    run: () => {
      const source = "abc";
      const doc = parseIncremental(source);

      const result = tryUpdateIncremental(
        doc,
        { startOffset: 2, oldEndOffset: 1, newText: "" },
        source,
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_EDIT_RANGE");
      }
    },
  },
  {
    name: "[Incremental/TryUpdate] should return ok:false with EDIT_TEXT_MISMATCH",
    run: () => {
      const source = "abcd";
      const doc = parseIncremental(source);
      const newSource = "abYd";

      const result = tryUpdateIncremental(
        doc,
        { startOffset: 2, oldEndOffset: 3, newText: "X" },
        newSource,
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "EDIT_TEXT_MISMATCH");
      }
    },
  },
  {
    name: "[Incremental/TryUpdate] should return ok:false with UNKNOWN on unexpected errors",
    run: () => {
      const source = "$$bold(x)$$";
      const doc = parseIncremental(source);
      const startOffset = source.indexOf("x");
      const newSource = "$$bold(y)$$";

      const result = tryUpdateIncremental(
        doc,
        { startOffset, oldEndOffset: startOffset + 1, newText: "y" },
        newSource,
        { syntax: { endTag: "BAD" } },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "UNKNOWN");
      }
    },
  },
  {
    name: "[Incremental/TryUpdate] malformed node type in right zones should surface as UNKNOWN",
    run: () => {
      const handlers = {
        ...createSimpleRawHandlers(["code"]),
      };

      const source = ["head", "$$code(ts)%", "A", "%end$$", "trail"].join("\n");
      const doc = parseIncremental(source, { handlers });
      assert.ok(doc.zones.length >= 2);

      // Force a right-zone shift by editing in the first zone.
      const insertAt = 0;
      const newText = "X";
      const newSource = applyEdit(source, insertAt, insertAt, newText);

      // Corrupt a node type in the right side so shiftNode hits assertUnreachable.
      const zones = [...doc.zones];
      const rightIndex = 1;
      const badNode = { type: "bogus" } as unknown as (typeof zones)[number]["nodes"][number];
      zones[rightIndex] = { ...zones[rightIndex], nodes: [badNode] };
      const malformedDoc = { ...doc, zones };

      const result = tryUpdateIncremental(
        malformedDoc,
        { startOffset: insertAt, oldEndOffset: insertAt, newText },
        newSource,
        { handlers },
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "UNKNOWN");
      }
    },
  },
  {
    name: "[Incremental/TryUpdate] shifted text and nested nodes should stay on incremental path",
    run: () => {
      const source = "L\n$$code(ts)%\nA\n%end$$\n$$code(js)%\nB\n%end$$";
      const doc = parseIncremental(source);
      assert.ok(doc.zones.length >= 3);

      const zones = [...doc.zones];
      const rightIndex = zones.length - 1;
      const rightNodes = [
        { type: "text", value: "tail" },
        {
          type: "block",
          tag: "note",
          args: [{ type: "text", value: "a" }, { type: "separator" }, { type: "text", value: "b" }],
          children: [{ type: "inline", tag: "bold", children: [{ type: "text", value: "x" }] }],
        },
      ] as (typeof zones)[number]["nodes"];
      zones[rightIndex] = { ...zones[rightIndex], nodes: rightNodes };
      const malformedDoc = { ...doc, zones };

      const insertAt = 1;
      const newText = "X";
      const newSource = applyEdit(source, insertAt, insertAt, newText);
      const result = tryUpdateIncremental(
        malformedDoc,
        { startOffset: insertAt, oldEndOffset: insertAt, newText },
        newSource,
      );

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.source, newSource);
      }
    },
  },
  {
    name: "[Incremental/TryUpdate] unstable node type read should hit unsupported frame source error",
    run: () => {
      const source = "L\n$$code(ts)%\nA\n%end$$\n$$code(js)%\nB\n%end$$";
      const doc = parseIncremental(source);
      assert.ok(doc.zones.length >= 3);

      let firstTypeRead = true;
      const flippingNode = {
        tag: "bold",
        children: [],
      } as Record<string, unknown>;
      Object.defineProperty(flippingNode, "type", {
        configurable: true,
        enumerable: true,
        get: () => {
          if (firstTypeRead) {
            firstTypeRead = false;
            return "inline";
          }
          return "inline-corrupted";
        },
      });

      const zones = [...doc.zones];
      const rightIndex = zones.length - 1;
      zones[rightIndex] = {
        ...zones[rightIndex],
        nodes: [flippingNode as unknown as (typeof zones)[number]["nodes"][number]],
      };
      const malformedDoc = { ...doc, zones };

      const insertAt = 1;
      const newText = "X";
      const newSource = applyEdit(source, insertAt, insertAt, newText);
      const result = tryUpdateIncremental(
        malformedDoc,
        { startOffset: insertAt, oldEndOffset: insertAt, newText },
        newSource,
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "UNKNOWN");
      }
    },
  },
  {
    name: "[Incremental/LazyShift] materializing reused right zones should shift nested nodes without positions",
    run: () => {
      const source = [
        "HEAD",
        "$$code(ts)%",
        "A",
        "%end$$",
        "MID",
        "$$note(title)*",
        "$$bold(x)$$",
        "*end$$",
        "TAIL",
      ].join("\n");
      const doc = parseIncremental(source);
      assert.ok(doc.zones.length >= 5, `expected >=5 zones, got ${doc.zones.length}`);

      const stripNodePosition = (
        node: (typeof doc.zones)[number]["nodes"][number],
      ): (typeof doc.zones)[number]["nodes"][number] => {
        if (node.type === "text") return { type: "text", value: node.value } as const;
        if (node.type === "escape") return { type: "escape", raw: node.raw } as const;
        if (node.type === "separator") return { type: "separator" } as const;
        if (node.type === "inline") {
          return {
            type: "inline",
            tag: node.tag,
            children: node.children.map(stripNodePosition),
          } as const;
        }
        if (node.type === "raw") {
          return {
            type: "raw",
            tag: node.tag,
            args: node.args.map(stripNodePosition),
            content: node.content,
          } as const;
        }
        return {
          type: "block",
          tag: node.tag,
          args: node.args.map(stripNodePosition),
          children: node.children.map(stripNodePosition),
        } as const;
      };

      const zones = [...doc.zones];
      const rightIndex = zones.length - 1;
      zones[rightIndex] = {
        ...zones[rightIndex],
        nodes: zones[rightIndex].nodes.map(stripNodePosition),
      };
      const malformedDoc = { ...doc, zones };

      const insertAt = 1;
      const newText = "X";
      const newSource = applyEdit(source, insertAt, insertAt, newText);
      const next = updateIncremental(
        malformedDoc,
        { startOffset: insertAt, oldEndOffset: insertAt, newText },
        newSource,
      );

      // Force lazy materialization path (materializeZone -> shiftNode).
      assert.ok(next.zones.length > 0);
      assert.ok(next.tree.length > 0);
    },
  },
  {
    name: "[Incremental/LazyShift] materialization should surface unsupported frame source type",
    run: () => {
      const source = [
        "HEAD",
        "$$code(ts)%",
        "A",
        "%end$$",
        "MID",
        "$$code(js)%",
        "B",
        "%end$$",
        "TAIL",
      ].join("\n");
      const doc = parseIncremental(source);
      assert.ok(doc.zones.length >= 5, `expected >=5 zones, got ${doc.zones.length}`);

      let shiftNodeTypeReads = 0;
      const flippingNode = {
        tag: "bold",
        children: [],
      } as Record<string, unknown>;
      Object.defineProperty(flippingNode, "type", {
        configurable: true,
        enumerable: true,
        get: () => {
          const stack = String(new Error().stack ?? "");
          if (!stack.includes("shiftNode")) return "inline";
          shiftNodeTypeReads += 1;
          if (shiftNodeTypeReads === 1) return "inline";
          return "inline-corrupted";
        },
      });

      const zones = [...doc.zones];
      const rightIndex = zones.length - 1;
      zones[rightIndex] = {
        ...zones[rightIndex],
        nodes: [flippingNode as unknown as (typeof zones)[number]["nodes"][number]],
      };
      const malformedDoc = { ...doc, zones };

      const insertAt = 1;
      const newText = "X";
      const newSource = applyEdit(source, insertAt, insertAt, newText);
      const next = updateIncremental(
        malformedDoc,
        { startOffset: insertAt, oldEndOffset: insertAt, newText },
        newSource,
      );

      assert.throws(() => {
        void next.tree;
      }, /unexpected node type|unsupported frame source type/);
    },
  },
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should return reconstructable patch set",
    run: () => {
      const handlers = {
        ...createSimpleInlineHandlers(["bold"]),
        ...createSimpleRawHandlers(["code"]),
      };
      const source = "head\n$$code(ts)%\nA\n%end$$\n$$bold(x)$$";
      const session = createIncrementalSession(source, { handlers });
      const before = session.getDocument();
      const editAt = source.indexOf("x");
      const newSource = applyEdit(source, editAt, editAt + 1, "y");

      const result = session.applyEditWithDiff(
        { startOffset: editAt, oldEndOffset: editAt + 1, newText: "y" },
        newSource,
      );

      assert.equal(result.doc.source, newSource);
      assert.ok(result.diff.patches.length > 0);
      assert.ok(result.diff.dirtySpanOld.startOffset <= editAt);
      assert.ok(result.diff.dirtySpanOld.endOffset >= editAt + 1);
      assertDiffRebuildsNextTree(before.tree, result.doc.tree, result.diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should emit multiple root patches around a stable island",
    run: () => {
      const handlers = {
        ...createSimpleInlineHandlers(["bold"]),
      };
      const source = "$$bold(a)$$$$bold(mid)$$$$bold(c)$$";
      const session = createIncrementalSession(source, { handlers });
      const before = session.getDocument();
      const editStart = source.indexOf("a");
      const editEnd = source.lastIndexOf("c") + 1;
      const newSource = applyEdit(source, editStart, editEnd, "x)$$$$bold(mid)$$$$bold(y");

      const result = session.applyEditWithDiff(
        { startOffset: editStart, oldEndOffset: editEnd, newText: "x)$$$$bold(mid)$$$$bold(y" },
        newSource,
      );

      assert.equal(result.diff.patches.length, 2);
      assert.deepEqual(result.diff.unchangedRanges, [
        {
          oldRange: { start: 1, end: 2 },
          newRange: { start: 1, end: 2 },
        },
      ]);
      assert.deepEqual(
        result.diff.ops.map((op) => op.kind),
        ["set-text", "set-text"],
      );
      assertDiffRebuildsNextTree(before.tree, result.doc.tree, result.diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should emit nested child splice ops",
    run: () => {
      const handlers = {
        ...createSimpleInlineHandlers(["bold"]),
      };
      const source = "$$bold(a)$$";
      const session = createIncrementalSession(source, { handlers });
      const before = session.getDocument();
      const editAt = source.indexOf("a");
      const newText = "a $$bold(x)$$";
      const newSource = applyEdit(source, editAt, editAt + 1, newText);

      const result = session.applyEditWithDiff(
        { startOffset: editAt, oldEndOffset: editAt + 1, newText },
        newSource,
      );
      const childSplice = result.diff.ops.find(
        (op) => op.kind === "splice" && op.field === "children" && op.path.length === 1,
      );

      assert.ok(childSplice);
      assert.deepEqual(childSplice.path, [{ field: "root", index: 0 }]);
      assertDiffRebuildsNextTree(before.tree, result.doc.tree, result.diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should preserve suffix ranges across offset shifts",
    run: () => {
      const handlers = {
        ...createSimpleInlineHandlers(["bold"]),
        ...createSimpleRawHandlers(["code"]),
      };
      const source = "$$bold(x)$$ tail $$code(ts)%\nA\n%end$$";
      const session = createIncrementalSession(source, { handlers });
      const before = session.getDocument();
      const editAt = source.indexOf("x");
      const newSource = applyEdit(source, editAt, editAt + 1, "long");

      const result = session.applyEditWithDiff(
        { startOffset: editAt, oldEndOffset: editAt + 1, newText: "long" },
        newSource,
      );
      const oldSuffixNode = before.tree[before.tree.length - 1];
      const newSuffixNode = result.doc.tree[result.doc.tree.length - 1];

      assert.equal(result.doc.source, newSource);
      assert.ok(oldSuffixNode?.position);
      assert.ok(newSuffixNode?.position);
      assert.notEqual(oldSuffixNode?.position?.start.offset, newSuffixNode?.position?.start.offset);
      assertDiffRebuildsNextTree(before.tree, result.doc.tree, result.diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should work in full-only fallback mode",
    run: () => {
      const source = "abc";
      const session = createIncrementalSession(source, undefined, { strategy: "full-only" });
      const before = session.getDocument();
      const newSource = "abXc";
      const result = session.applyEditWithDiff(
        { startOffset: 2, oldEndOffset: 2, newText: "X" },
        newSource,
      );

      assert.equal(result.mode, "full-fallback");
      assert.equal(result.fallbackReason, "FULL_ONLY_STRATEGY");
      assert.equal(result.doc.source, newSource);
      assertDiffRebuildsNextTree(before.tree, result.doc.tree, result.diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should stay stack-safe for deeply nested inline trees",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const source = makeNestedInline(12_000);
      const session = createIncrementalSession(source, { handlers, depthLimit: 12_100 });
      const editAt = source.indexOf("x");
      const newSource = applyEdit(source, editAt, editAt + 1, "y");

      const result = session.applyEditWithDiff(
        { startOffset: editAt, oldEndOffset: editAt + 1, newText: "y" },
        newSource,
      );

      assert.equal(result.doc.source, newSource);
      assert.ok(result.diff.patches.length > 0 || result.diff.ops.length > 0);
    },
  },
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should conservatively fallback when diff refinement throws",
    run: () => {
      const source = "abc";
      const session = createIncrementalSession(source, undefined, { strategy: "full-only" });
      const before = session.getDocument();
      Object.defineProperty(before.tree, "0", {
        value: { type: "unexpected-node-type" },
        configurable: true,
        writable: true,
      });

      const newSource = "abXc";
      const result = session.applyEditWithDiff(
        { startOffset: 2, oldEndOffset: 2, newText: "X" },
        newSource,
      );

      assert.equal(result.doc.source, newSource);
      assert.deepEqual(result.diff.unchangedRanges, []);
      assert.equal(result.diff.patches.length, 1);
      assert.equal(result.diff.patches[0]?.kind, "replace");
      assert.equal(result.diff.ops.length, 1);
      assert.equal(result.diff.ops[0]?.kind, "splice");
      assert.equal(result.diff.dirtySpanOld.startOffset, 0);
      assert.equal(result.diff.dirtySpanOld.endOffset, source.length);
      assert.equal(result.diff.dirtySpanNew.startOffset, 0);
      assert.equal(result.diff.dirtySpanNew.endOffset, newSource.length);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should emit insert patch and fallback dirty span without positions",
    run: () => {
      const next = stripTreePositions(parseStructural("tail"));
      const diff = computeTokenDiff([], next, { startOffset: 0, oldEndOffset: 0, newText: "tail" }, 8);

      assert.equal(diff.isNoop, false);
      assert.deepEqual(diff.patches, [{ kind: "insert", oldRange: { start: 0, end: 0 }, newRange: { start: 0, end: 1 } }]);
      assert.equal(diff.dirtySpanOld.startOffset, 0);
      assert.equal(diff.dirtySpanOld.endOffset, 0);
      assert.equal(diff.dirtySpanNew.startOffset, 0);
      assert.equal(diff.dirtySpanNew.endOffset, "tail".length);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should emit remove patch and fallback dirty span without positions",
    run: () => {
      const previous = stripTreePositions(parseStructural("tail"));
      const diff = computeTokenDiff(previous, [], { startOffset: 0, oldEndOffset: 4, newText: "" }, 8);

      assert.equal(diff.isNoop, false);
      assert.deepEqual(diff.patches, [{ kind: "remove", oldRange: { start: 0, end: 1 }, newRange: { start: 0, end: 0 } }]);
      assert.equal(diff.dirtySpanOld.startOffset, 0);
      assert.equal(diff.dirtySpanOld.endOffset, 4);
      assert.equal(diff.dirtySpanNew.startOffset, 0);
      assert.equal(diff.dirtySpanNew.endOffset, 0);
    },
  },
  {
    name: "[Incremental/SessionDiff] buildConservativeTokenDiff should no-op for empty snapshots",
    run: () => {
      const previousDoc = parseIncremental("");
      const nextDoc = parseIncremental("");
      const diff = buildConservativeTokenDiff(previousDoc, nextDoc);

      assert.equal(diff.isNoop, true);
      assert.deepEqual(diff.patches, []);
      assert.deepEqual(diff.unchangedRanges, []);
      assert.deepEqual(diff.ops, []);
      assert.equal(diff.dirtySpanOld.startOffset, 0);
      assert.equal(diff.dirtySpanOld.endOffset, 0);
      assert.equal(diff.dirtySpanNew.startOffset, 0);
      assert.equal(diff.dirtySpanNew.endOffset, 0);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should refine escape raw and shorthand ops together",
    run: () => {
      const previous: StructuralNode[] = [
        { type: "separator" },
        { type: "escape", raw: "\\$" },
        { type: "raw", tag: "code", args: [{ type: "text", value: "ts" }], content: "A" },
        {
          type: "inline",
          tag: "bold",
          children: [{ type: "text", value: "x" }],
          implicitInlineShorthand: true,
        },
      ];
      const next: StructuralNode[] = [
        { type: "separator" },
        { type: "escape", raw: "\\%" },
        { type: "raw", tag: "code", args: [{ type: "text", value: "js" }], content: "B" },
        {
          type: "inline",
          tag: "bold",
          children: [{ type: "text", value: "x" }],
          implicitInlineShorthand: undefined,
        },
      ];
      const diff = computeTokenDiff(previous, next, { startOffset: 0, oldEndOffset: 4, newText: "next" }, 8);

      assert.equal(diff.isNoop, false);
      assert.ok(diff.ops.some((op) => op.kind === "set-escape"));
      assert.ok(diff.ops.some((op) => op.kind === "set-raw-content"));
      assert.ok(diff.ops.some((op) => op.kind === "set-implicit-inline-shorthand"));
      assert.ok(diff.ops.some((op) => op.kind === "set-text" && op.path.length === 2 && op.path[1]?.field === "args"));
      assertDiffRebuildsNextTree(previous, next, diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should refine block args and children text updates",
    run: () => {
      const previous: StructuralNode[] = [
        {
          type: "block",
          tag: "note",
          args: [{ type: "text", value: "old-title" }],
          children: [{ type: "text", value: "old-body" }],
        },
      ];
      const next: StructuralNode[] = [
        {
          type: "block",
          tag: "note",
          args: [{ type: "text", value: "new-title" }],
          children: [{ type: "text", value: "new-body" }],
        },
      ];
      const diff = computeTokenDiff(previous, next, { startOffset: 0, oldEndOffset: 1, newText: "next" }, 8);
      const setTextOps = diff.ops.filter((op) => op.kind === "set-text");
      const fields = setTextOps.map((op) => op.path[1]?.field).sort();

      assert.equal(diff.isNoop, false);
      assert.equal(setTextOps.length, 2);
      assert.deepEqual(fields, ["args", "children"]);
      assertDiffRebuildsNextTree(previous, next, diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should sort nested block splices by field rank",
    run: () => {
      const previous: StructuralNode[] = [
        {
          type: "block",
          tag: "note",
          args: [{ type: "text", value: "title" }],
          children: [{ type: "text", value: "body" }],
        },
      ];
      const next: StructuralNode[] = [
        {
          type: "block",
          tag: "note",
          args: [{ type: "text", value: "title" }, { type: "text", value: "more-title" }],
          children: [{ type: "text", value: "body" }, { type: "text", value: "more-body" }],
        },
      ];
      const diff = computeTokenDiff(previous, next, { startOffset: 0, oldEndOffset: 1, newText: "next" }, 8);
      const spliceOps = diff.ops.filter((op) => op.kind === "splice");

      assert.equal(spliceOps.length, 2);
      assert.equal(spliceOps[0]?.field, "args");
      assert.equal(spliceOps[1]?.field, "children");
      assertDiffRebuildsNextTree(previous, next, diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should keep duplicate middle islands as equal segments",
    run: () => {
      const previous: StructuralNode[] = [
        { type: "text", value: "left" },
        { type: "text", value: "same" },
        { type: "text", value: "same" },
        { type: "text", value: "right" },
      ];
      const next: StructuralNode[] = [
        { type: "text", value: "L" },
        { type: "text", value: "same" },
        { type: "text", value: "same" },
        { type: "text", value: "R" },
      ];
      const diff = computeTokenDiff(previous, next, { startOffset: 0, oldEndOffset: 4, newText: "next" }, 8);

      assert.equal(diff.isNoop, false);
      assert.ok(
        diff.unchangedRanges.some(
          (range) =>
            range.oldRange.start === 1 &&
            range.oldRange.end === 3 &&
            range.newRange.start === 1 &&
            range.newRange.end === 3,
        ),
      );
      assertDiffRebuildsNextTree(previous, next, diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should pick stable anchors when duplicate signatures exist",
    run: () => {
      const previous: StructuralNode[] = [
        { type: "text", value: "start" },
        { type: "text", value: "dup" },
        { type: "text", value: "one" },
        { type: "text", value: "two" },
        { type: "text", value: "three" },
        { type: "text", value: "dup" },
        { type: "text", value: "end" },
      ];
      const next: StructuralNode[] = [
        { type: "text", value: "start" },
        { type: "text", value: "dup" },
        { type: "text", value: "two" },
        { type: "text", value: "one" },
        { type: "text", value: "three" },
        { type: "text", value: "dup" },
        { type: "text", value: "end" },
      ];
      const diff = computeTokenDiff(previous, next, { startOffset: 0, oldEndOffset: 7, newText: "next" }, 8);

      assert.equal(diff.isNoop, false);
      assert.ok(diff.unchangedRanges.length >= 2);
      assert.ok(diff.patches.length >= 1);
      assertDiffRebuildsNextTree(previous, next, diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should fallback to splice when refinement depth is capped",
    run: () => {
      const previous: StructuralNode[] = [
        {
          type: "inline",
          tag: "bold",
          children: [{ type: "text", value: "x" }],
          implicitInlineShorthand: undefined,
        },
      ];
      const next: StructuralNode[] = [
        {
          type: "inline",
          tag: "bold",
          children: [{ type: "text", value: "y" }],
          implicitInlineShorthand: undefined,
        },
      ];
      const diff = computeTokenDiff(previous, next, { startOffset: 0, oldEndOffset: 1, newText: "next" }, 0);

      assert.equal(diff.patches.length, 1);
      assert.equal(diff.patches[0]?.kind, "replace");
      assert.equal(diff.ops.length, 1);
      assert.equal(diff.ops[0]?.kind, "splice");
      assert.equal(diff.ops[0]?.path.length, 0);
      assertDiffRebuildsNextTree(previous, next, diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should splice when recursive diff is ineligible",
    run: () => {
      const previous: StructuralNode[] = [
        {
          type: "raw",
          tag: "code",
          args: [{ type: "text", value: "ts" }],
          content: "A",
        },
      ];
      const next: StructuralNode[] = [
        {
          type: "raw",
          tag: "quote",
          args: [{ type: "text", value: "ts" }],
          content: "A",
        },
      ];
      const diff = computeTokenDiff(previous, next, { startOffset: 0, oldEndOffset: 1, newText: "next" }, 8);

      assert.equal(diff.patches.length, 1);
      assert.equal(diff.patches[0]?.kind, "replace");
      assert.equal(diff.ops.length, 1);
      assert.equal(diff.ops[0]?.kind, "splice");
      assertDiffRebuildsNextTree(previous, next, diff);
    },
  },
  {
    name: "[Incremental/SessionDiff] computeTokenDiff should noop for identical trees",
    run: () => {
      const tree = stripTreePositions(
        parseStructural("plain $$bold(x)$$", {
          handlers: createSimpleInlineHandlers(["bold"]),
        }),
      );
      const diff = computeTokenDiff(tree, tree, { startOffset: 0, oldEndOffset: 0, newText: "" }, 8);

      assert.equal(diff.isNoop, true);
      assert.deepEqual(diff.patches, []);
      assert.deepEqual(diff.ops, []);
      assert.ok(diff.unchangedRanges.length > 0);
    },
  },
  {
    name: "[Incremental/Session] full-only strategy should always rebuild",
    run: () => {
      const source = "abc";
      const session = createIncrementalSession(source, undefined, { strategy: "full-only" });
      const newSource = "abXc";
      const result = session.applyEdit({ startOffset: 2, oldEndOffset: 2, newText: "X" }, newSource);

      assert.equal(result.mode, "full-fallback");
      assert.equal(result.fallbackReason, "FULL_ONLY_STRATEGY");
      assert.equal(result.doc.source, newSource);
    },
  },
  {
    name: "[Incremental/Session] bounded sample window should evict oldest samples",
    run: () => {
      const source = "$$bold(x)$$";
      const session = createIncrementalSession(source, undefined, {
        strategy: "full-only",
        sampleWindowSize: 4,
      });

      let docSource = source;
      for (let i = 0; i < 8; i++) {
        const at = docSource.indexOf("x");
        const nextChar = i % 2 === 0 ? "y" : "x";
        const nextSource = applyEdit(docSource, at, at + 1, nextChar);
        const result = session.applyEdit(
          { startOffset: at, oldEndOffset: at + 1, newText: nextChar },
          nextSource,
        );
        assert.equal(result.mode, "full-fallback");
        assert.equal(result.fallbackReason, "FULL_ONLY_STRATEGY");
        docSource = nextSource;
      }
      assert.equal(session.getDocument().source, docSource);
    },
  },
  {
    name: "[Incremental/Session] invalid softZoneNodeCap should fallback to default cap",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const source = "$$bold(x)$$ ".repeat(120);
      const defaultSession = createIncrementalSession(source, { handlers });
      const invalidCapSession = createIncrementalSession(source, { handlers }, { softZoneNodeCap: Number.NaN });

      assert.equal(
        invalidCapSession.getDocument().zones.length,
        defaultSession.getDocument().zones.length,
      );
    },
  },
  {
    name: "[Incremental/Session] large edit in auto mode should fallback",
    run: () => {
      const source = "abcdef";
      const session = createIncrementalSession(source, undefined, { maxEditRatioForIncremental: 0.1 });
      const newSource = "XY";
      const result = session.applyEdit({ startOffset: 0, oldEndOffset: source.length, newText: "XY" }, newSource);

      assert.equal(result.mode, "full-fallback");
      assert.equal(result.fallbackReason, "AUTO_LARGE_EDIT");
      assert.equal(result.doc.source, newSource);
    },
  },
  {
    name: "[Incremental/Session] adaptive policy should enter and exit cooldown",
    run: () => {
      // 需要 >1 zone 才能走增量路径（≤1 zone 被 guard 短路到 full rebuild）
      const rawHandlers = createSimpleRawHandlers(["code"]);
      const source = "abc\n$$code(ts)%\nx\n%end$$\nz";
      const session = createIncrementalSession(source, { handlers: rawHandlers }, {
        strategy: "auto",
        sampleWindowSize: 4,
        minSamplesForAdaptation: 2,
        maxFallbackRate: 0,
        fullPreferenceCooldownEdits: 1,
        maxEditRatioForIncremental: 1,
      });

      // mismatch edit: newSource 长度不匹配 → 触发 fallback
      const mismatchEdit = { startOffset: 1, oldEndOffset: 2, newText: "ZZ" };
      const mismatchResult1 = session.applyEdit(mismatchEdit, source);
      const mismatchResult2 = session.applyEdit(mismatchEdit, source);
      assert.equal(mismatchResult1.mode, "full-fallback");
      assert.equal(mismatchResult2.mode, "full-fallback");

      const cooldownResult = session.applyEdit(
        { startOffset: 1, oldEndOffset: 2, newText: "b" },
        source,
      );
      assert.equal(cooldownResult.mode, "full-fallback");
      assert.equal(cooldownResult.fallbackReason, "AUTO_COOLDOWN");

      const incrementalSource = source;
      const incrementalResult = session.applyEdit(
        { startOffset: 1, oldEndOffset: 2, newText: "b" },
        incrementalSource,
      );
      assert.equal(incrementalResult.mode, "incremental");
      assert.equal(incrementalResult.doc.source, incrementalSource);
    },
  },
  {
    name: "[Incremental/Session] internal full rebuild should count as fallback mark",
    run: () => {
      // 需要 >1 zone 才能走增量路径
      const rawHandlers = createSimpleRawHandlers(["code"]);
      const source = "abc\n$$code(ts)%\nx\n%end$$\nz";
      const session = createIncrementalSession(source, { handlers: rawHandlers }, {
        strategy: "auto",
        sampleWindowSize: 4,
        minSamplesForAdaptation: 2,
        maxFallbackRate: 0,
        fullPreferenceCooldownEdits: 1,
        maxEditRatioForIncremental: 1,
      });

      const noOpEdit = { startOffset: 1, oldEndOffset: 2, newText: "b" };
      // 用不同 handler set 制造 fingerprint 不匹配 → INTERNAL_FULL_REBUILD
      // 但保留 raw handler 以保持 >1 zone
      const altRawHandlers = createSimpleRawHandlers(["code"]);
      const inlineHandlers = createSimpleInlineHandlers(["bold"]);
      const shiftedOptions = { handlers: { ...altRawHandlers, ...inlineHandlers } };
      const first = session.applyEdit(noOpEdit, source, shiftedOptions);
      // 第二次用同样的 options → fingerprint 一致 → 走增量
      const second = session.applyEdit(noOpEdit, source, shiftedOptions);
      const cooldown = session.applyEdit(noOpEdit, source, shiftedOptions);

      assert.equal(first.mode, "full-fallback");
      assert.equal(first.fallbackReason, "INTERNAL_FULL_REBUILD");
      assert.equal(second.mode, "incremental");
      assert.equal(cooldown.mode, "full-fallback");
      assert.equal(cooldown.fallbackReason, "AUTO_COOLDOWN");
    },
  },
  {
    name: "[Incremental/Session] full-time faster adaptation should trigger cooldown fallback",
    run: () => {
      const originalNow = performance.now.bind(performance);
      const values = [0, 10, 20, 30, 40, 50, 60, 61, 70, 80, 90, 91, 100, 101];
      let index = 0;
      performance.now = () => {
        const next = values[index] ?? values[values.length - 1];
        index += 1;
        return next;
      };

      try {
        // 需要 >1 zone 才能走增量路径
        const rawHandlers = createSimpleRawHandlers(["code"]);
        const source = "abc\n$$code(ts)%\nx\n%end$$\nz";
        const session = createIncrementalSession(source, { handlers: rawHandlers }, {
          strategy: "auto",
          minSamplesForAdaptation: 2,
          sampleWindowSize: 8,
          maxFallbackRate: 1,
          switchToFullMultiplier: 2,
          fullPreferenceCooldownEdits: 1,
          maxEditRatioForIncremental: 1,
        });

        const noOpEdit = { startOffset: 1, oldEndOffset: 2, newText: "b" };
        const mismatchEdit = { startOffset: 1, oldEndOffset: 2, newText: "ZZ" };
        session.applyEdit(noOpEdit, source);
        session.applyEdit(noOpEdit, source);
        session.applyEdit(mismatchEdit, source);
        session.applyEdit(mismatchEdit, source);

        const cooldownResult = session.applyEdit(noOpEdit, source);
        assert.equal(cooldownResult.mode, "full-fallback");
        assert.equal(cooldownResult.fallbackReason, "AUTO_COOLDOWN");
      } finally {
        performance.now = originalNow;
      }
    },
  },
  {
    name: "[Incremental/Session] rebuild and getDocument should keep session snapshot in sync",
    run: () => {
      const source = "$$bold(x)$$";
      const session = createIncrementalSession(source);

      assert.equal(session.getDocument().source, source);

      const rebuilt = session.rebuild("$$bold(y)$$");
      assert.equal(rebuilt.source, "$$bold(y)$$");
      assert.equal(session.getDocument().source, "$$bold(y)$$");
    },
  },
  {
    name: "[Incremental/Probe] stable seam should keep incremental path",
    run: () => {
      const source = "L\n$$code(ts)%\nA\n%end$$\nM\n$$note()*\nB\n*end$$\nR";
      const doc = parseIncremental(source);
      const editAt = source.indexOf("L");
      const newSource = applyEdit(source, editAt, editAt + 1, "X");

      let next = doc;
      const stats = captureIncrementalDebug(() => {
        next = updateIncremental(doc, { startOffset: editAt, oldEndOffset: editAt + 1, newText: "X" }, newSource);
      });
      const full = parseFull(newSource);

      assert.ok(stats);
      assert.equal(stats.fellBackToFull, false);
      assert.ok(stats.probeSliceBytes > 0);
      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/Probe] unstable seam should fallback to full rebuild",
    run: () => {
      const source = "L\n$$code(ts)%\nA\n%end$$\nM\n$$note()*\nB\n*end$$\nR";
      const doc = parseIncremental(source);
      assert.ok(doc.zones.length >= 5);
      const editAt = source.indexOf("L");
      const newSource = applyEdit(source, editAt, editAt + 1, "X");

      const zones = [...doc.zones];
      const mismatchedRight = zones[2];
      assert.ok(mismatchedRight.nodes.length > 0);
      const firstNode = mismatchedRight.nodes[0];
      if (firstNode.type !== "text") {
        throw new Error("expected first right-zone node to be text");
      }
      const mutatedNodes = [...mismatchedRight.nodes];
      mutatedNodes[0] = { ...firstNode, value: `${firstNode.value}!` };
      zones[2] = { ...mismatchedRight, nodes: mutatedNodes };
      const malformedDoc = { ...doc, zones };

      let next = doc;
      const stats = captureIncrementalDebug(() => {
        next = updateIncremental(
          malformedDoc,
          { startOffset: editAt, oldEndOffset: editAt + 1, newText: "X" },
          newSource,
        );
      });
      const full = parseFull(newSource);

      assert.ok(stats);
      assert.equal(stats.fellBackToFull, true);
      assert.deepEqual(next.tree, full.tree);
      assert.deepEqual(next.zones, full.zones);
    },
  },
  {
    name: "[Incremental/Fingerprint] syntax and allowForms changes should force fallback",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const source = "$$bold(x)$$";
      const doc = parseIncremental(source, { handlers });

      const newSource = "$$bold(y)$$";
      const syntaxStats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: source.indexOf("x"), oldEndOffset: source.indexOf("x") + 1, newText: "y" },
          newSource,
          { handlers, syntax: { tagOpen: "@@" } },
        );
      });

      const formsStats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: source.indexOf("x"), oldEndOffset: source.indexOf("x") + 1, newText: "y" },
          newSource,
          { handlers, allowForms: ["raw"] },
        );
      });

      assert.ok(syntaxStats);
      assert.equal(syntaxStats.fellBackToFull, true);
      assert.ok(formsStats);
      assert.equal(formsStats.fellBackToFull, true);
    },
  },
  {
    name: "[Incremental/Fingerprint] handlers shape controls reuse eligibility",
    run: () => {
      // 需要 >1 zone：使用 raw handler 产生 zone breaker
      const rawHandlers = createSimpleRawHandlers(["code"]);
      const inlineHandlers = createSimpleInlineHandlers(["bold"]);
      const handlers = { ...rawHandlers, ...inlineHandlers };
      const source = "$$bold(x)$$\n$$code(ts)%\nhello\n%end$$\n$$bold(y)$$";
      const doc = parseIncremental(source, { handlers });
      const editAt = source.indexOf("x");
      const newSource = applyEdit(source, editAt, editAt + 1, "z");

      const stableStats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: editAt, oldEndOffset: editAt + 1, newText: "z" },
          newSource,
          { handlers },
        );
      });
      const recreatedStats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: editAt, oldEndOffset: editAt + 1, newText: "z" },
          newSource,
          { handlers: { ...handlers } },
        );
      });
      const changedHandlerStats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: editAt, oldEndOffset: editAt + 1, newText: "z" },
          newSource,
          {
            handlers: {
              ...handlers,
              bold: {
                ...inlineHandlers.bold,
                inline: (tokens) => ({
                  type: "bold",
                  value: tokens,
                }),
              },
            },
          },
        );
      });

      assert.ok(stableStats);
      assert.equal(stableStats.fellBackToFull, false);
      assert.ok(recreatedStats);
      assert.equal(recreatedStats.fellBackToFull, false);
      assert.ok(changedHandlerStats);
      assert.equal(changedHandlerStats.fellBackToFull, true);
    },
  },
  {
    name: "[Incremental/Probe] extra margin should expand probe slice beyond compared zones",
    run: () => {
      const source = "L\n$$code(ts)%\nA\n%end$$\nM\n$$note()*\nB\n*end$$\nR";
      const doc = parseIncremental(source);
      assert.ok(doc.zones.length >= 5);

      const editAt = source.indexOf("L");
      const newSource = applyEdit(source, editAt, editAt + 1, "X");
      const stats = captureIncrementalDebug(() => {
        updateIncremental(doc, { startOffset: editAt, oldEndOffset: editAt + 1, newText: "X" }, newSource);
      });

      const expectedProbeBytes = doc.zones[4].endOffset - doc.zones[2].startOffset;
      assert.ok(stats);
      assert.equal(stats.probeSliceBytes, expectedProbeBytes);
    },
  },
  {
    name: "[Incremental/PerfGuard] long-doc head edit should keep reparse bytes bounded",
    run: () => {
      const parts: string[] = ["HEAD"];
      for (let i = 0; i < 220; i++) {
        parts.push(`$$code(ts)%\n${i}\n%end$$`);
        parts.push(`plain-${i}`);
      }
      const source = parts.join("\n");
      assert.ok(source.length > 4000);

      const doc = parseIncremental(source);
      const newSource = applyEdit(source, 0, 1, "h");
      const stats = captureIncrementalDebug(() => {
        updateIncremental(doc, { startOffset: 0, oldEndOffset: 1, newText: "h" }, newSource);
      });

      assert.ok(stats);
      const touchedBytes = stats.cumulativeReparsedBytes + stats.probeSliceBytes;
      assert.ok(touchedBytes < source.length / 4, `touched=${touchedBytes}, source=${source.length}`);
    },
  },
  {
    name: "[Incremental/Fingerprint] implicitInlineShorthand whitelist should be order/duplicate insensitive",
    run: () => {
      const handlers = {
        ...createSimpleInlineHandlers(["bold"]),
        ...createSimpleRawHandlers(["code"]),
      };
      const source = "$$bold(x)$$\n$$code(ts)%\nA\n%end$$";
      const doc = parseIncremental(source, {
        handlers,
        implicitInlineShorthand: ["bold", "italic"],
      });
      const editAt = source.indexOf("x");
      const newSource = applyEdit(source, editAt, editAt + 1, "y");

      const reorderedStats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: editAt, oldEndOffset: editAt + 1, newText: "y" },
          newSource,
          {
            handlers,
            implicitInlineShorthand: ["italic", "bold"],
          },
        );
      });
      const duplicateStats = captureIncrementalDebug(() => {
        updateIncremental(
          doc,
          { startOffset: editAt, oldEndOffset: editAt + 1, newText: "y" },
          newSource,
          {
            handlers,
            implicitInlineShorthand: ["bold", "bold", "italic"],
          },
        );
      });

      assert.ok(reorderedStats);
      assert.equal(reorderedStats.fellBackToFull, false);
      assert.ok(duplicateStats);
      assert.equal(duplicateStats.fellBackToFull, false);
    },
  },
];

await runGoldenCases("Incremental", "incremental case", cases);
