import assert from "node:assert/strict";
import {
  type TagHandler,
  type TextToken,
  createSimpleBlockHandlers,
  createIncrementalSession,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  buildZones,
  parseIncremental,
  parseStructural,
} from "../src/index.ts";
import { __setIncrementalDebugSink, tryUpdateIncremental, updateIncremental } from "../src/incremental.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

const parseFull = (source: string, options?: Parameters<typeof parseStructural>[1]) => {
  const tree = parseStructural(source, { ...options, trackPositions: true });
  const zones = buildZones(tree);
  return { tree, zones };
};

const applyEdit = (source: string, start: number, end: number, newText: string): string =>
  source.slice(0, start) + newText + source.slice(end);

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
];

await runGoldenCases("Incremental", "incremental case", cases);
