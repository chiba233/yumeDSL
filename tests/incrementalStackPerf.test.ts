import assert from "node:assert/strict";
import {
  createIncrementalSession,
  createSimpleInlineHandlers,
} from "../src/index.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

const applyEdit = (source: string, start: number, end: number, newText: string): string =>
  source.slice(0, start) + newText + source.slice(end);

const makeNestedInline = (depth: number): string => {
  let text = "x";
  for (let i = 0; i < depth; i++) {
    text = `$$bold(${text})$$`;
  }
  return text;
};

const cases: GoldenCase[] = [
  {
    name: "[Incremental/SessionDiff] applyEditWithDiff should stay stack-safe for deeply nested inline trees",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const source = makeNestedInline(4_000);
      const session = createIncrementalSession(source, { handlers, depthLimit: 4_100 });
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
    name: "[Incremental/Session] deleting many inline closes should not stall on unclosed nested tails",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const depthLimit = 256;
      const nested = makeNestedInline(20);
      const source = `${nested}\n$$bold(tail)$$`;
      const removedClosers = 15;
      const suffix = ")$$".repeat(removedClosers);
      const startOffset = source.indexOf(suffix);
      assert.notEqual(startOffset, -1);
      const oldEndOffset = startOffset + suffix.length;
      const newSource = applyEdit(source, startOffset, oldEndOffset, "");
      const session = createIncrementalSession(source, { handlers, depthLimit });
      const startedAt = Date.now();

      const result = session.applyEdit(
        { startOffset, oldEndOffset, newText: "" },
        newSource,
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.doc.source, newSource);
      assert.ok(elapsedMs < 2_000, `expected nested-close deletion to finish quickly, got ${elapsedMs}ms`);
    },
  },
];

await runGoldenCases("Incremental Stack Perf", " incremental stack perf case", cases, { quietPasses: true });
