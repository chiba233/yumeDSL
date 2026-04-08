import assert from "node:assert/strict";
import {
  type TagHandler,
  createSimpleBlockHandlers,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  buildZones,
  parseIncremental,
  parseStructural,
  tryUpdateIncremental,
  updateIncremental,
} from "../src/index.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

const parseFull = (source: string, options?: Parameters<typeof parseStructural>[1]) => {
  const tree = parseStructural(source, { ...options, trackPositions: true });
  const zones = buildZones(tree);
  return { tree, zones };
};

const applyEdit = (source: string, start: number, end: number, newText: string): string =>
  source.slice(0, start) + newText + source.slice(end);

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
];

await runGoldenCases("Incremental", "incremental case", cases);
