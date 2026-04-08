import assert from "node:assert/strict";
import {
  type TagHandler,
  createSimpleInlineHandlers,
  buildZones,
  parseIncremental,
  parseStructural,
  tryUpdateIncremental,
  updateIncremental,
} from "../src/index.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

const parseFull = (source: string) => {
  const tree = parseStructural(source, { trackPositions: true });
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
];

await runGoldenCases("Incremental", "incremental case", cases);
