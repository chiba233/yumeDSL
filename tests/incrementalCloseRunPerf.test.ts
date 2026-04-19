import assert from "node:assert/strict";
import {
  type StructuralNode,
  createEasySyntax,
  createIncrementalSession,
  createSimpleInlineHandlers,
} from "../src/index.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

const applyEdit = (source: string, start: number, end: number, newText: string): string =>
  source.slice(0, start) + newText + source.slice(end);

const makeNestedEasyShorthand = (depth: number): string =>
  `=bold<${"bold<".repeat(depth - 1)}${">".repeat(depth - 2)}>=`;

const summarizeInlineTree = (tree: readonly StructuralNode[]) => {
  const root = tree[0];
  const summary = {
    rootType: root?.type ?? "none",
    rootChildCount: root?.type === "inline" ? root.children.length : -1,
    maxInlineDepth: 0,
  };
  const stack = tree.map((node) => ({ node, depth: 1 }));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.node.type !== "inline") continue;
    if (current.depth > summary.maxInlineDepth) summary.maxInlineDepth = current.depth;
    for (let i = current.node.children.length - 1; i >= 0; i--) {
      stack.push({ node: current.node.children[i], depth: current.depth + 1 });
    }
  }
  return summary;
};

const collectText = (tree: readonly StructuralNode[]): string =>
  tree
    .map((node) => {
      if (node.type === "text") return node.value;
      return "";
    })
    .join("");

const cases: GoldenCase[] = [
  {
    name: "[Incremental/Session] single 10000-layer shorthand close-run deletion should stay under 200ms",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const syntax = createEasySyntax({ tagPrefix: "=", tagOpen: "<", tagClose: ">" });
      const depth = 10_000;
      const depthLimit = 9_999;
      const source0 = makeNestedEasyShorthand(depth);
      const closeStart = source0.indexOf(">");
      assert.notEqual(closeStart, -1);
      const deleteIndex = closeStart + depthLimit - 1;
      const nextSource = applyEdit(source0, deleteIndex, deleteIndex + 1, "");
      const session = createIncrementalSession(source0, {
        handlers,
        syntax,
        implicitInlineShorthand: true,
        depthLimit,
      });

      const startedAt = performance.now();
      const result = session.applyEdit(
        { startOffset: deleteIndex, oldEndOffset: deleteIndex + 1, newText: "" },
        nextSource,
      );
      const elapsedMs = performance.now() - startedAt;

      assert.equal(result.doc.source, nextSource);
      assert.ok(
        elapsedMs < 200,
        `expected single close-run delete to stay under 200ms, got ${elapsedMs.toFixed(3)}ms`,
      );
    },
  },
  {
    name: "[Incremental/Session] deleting 51 close tokens near depthLimit should fallback to full parse without drifting",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const syntax = createEasySyntax({ tagPrefix: "=", tagOpen: "<", tagClose: ">" });
      const depth = 10_000;
      const depthLimit = 9_950;
      const deleteCount = 51;
      const source0 = makeNestedEasyShorthand(depth);
      const deleteStart = source0.length - 2 - deleteCount;
      const nextSource = applyEdit(source0, deleteStart, deleteStart + deleteCount, "");
      const session = createIncrementalSession(source0, {
        handlers,
        syntax,
        implicitInlineShorthand: true,
        depthLimit,
      });

      const startedAt = Date.now();
      const result = session.applyEdit(
        { startOffset: deleteStart, oldEndOffset: deleteStart + deleteCount, newText: "" },
        nextSource,
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.mode, "full-fallback");
      assert.equal(result.doc.source, nextSource);
      assert.deepEqual(summarizeInlineTree(result.doc.tree), {
        rootType: "inline",
        rootChildCount: 2,
        maxInlineDepth: 9_948,
      });
      assert.ok(
        elapsedMs < 1_000,
        `expected depth-limit close-run deletion to stay below 1s, got ${elapsedMs}ms`,
      );
    },
  },
  {
    name: "[Incremental/Session] deleting the entire close run should not hang when no legal close remains",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const syntax = createEasySyntax({ tagPrefix: "=", tagOpen: "<", tagClose: ">" });
      const depth = 10_000;
      const depthLimit = 9_950;
      const source0 = makeNestedEasyShorthand(depth);
      const closeStart = source0.indexOf(">");
      assert.notEqual(closeStart, -1);
      const nextSource = applyEdit(source0, closeStart, source0.length - 1, "");
      const session = createIncrementalSession(source0, {
        handlers,
        syntax,
        implicitInlineShorthand: true,
        depthLimit,
      });

      const startedAt = Date.now();
      const result = session.applyEdit(
        { startOffset: closeStart, oldEndOffset: source0.length - 1, newText: "" },
        nextSource,
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.mode, "full-fallback");
      assert.equal(result.doc.source, nextSource);
      assert.equal(collectText(result.doc.tree), nextSource);
      assert.ok(
        elapsedMs < 1_000,
        `expected full close-run deletion to stay below 1s, got ${elapsedMs}ms`,
      );
    },
  },
  {
    name: "[Incremental/Session] re-adding close tokens one-by-one after deleting the close run should stay bounded",
    run: () => {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const syntax = createEasySyntax({ tagPrefix: "=", tagOpen: "<", tagClose: ">" });
      const depth = 10_000;
      const depthLimit = 9_950;
      const source0 = makeNestedEasyShorthand(depth);
      const closeStart = source0.indexOf(">");
      assert.notEqual(closeStart, -1);
      let nextSource = applyEdit(source0, closeStart, source0.length - 1, "");
      const session = createIncrementalSession(nextSource, {
        handlers,
        syntax,
        implicitInlineShorthand: true,
        depthLimit,
      });
      const startedAt = Date.now();

      for (let step = 1; step <= 5; step++) {
        const insertAt = nextSource.length - 1;
        const updatedSource = applyEdit(nextSource, insertAt, insertAt, ">");
        const result = session.applyEdit(
          { startOffset: insertAt, oldEndOffset: insertAt, newText: ">" },
          updatedSource,
        );
        nextSource = updatedSource;
        assert.equal(result.mode, "full-fallback");
        assert.equal(result.doc.source, updatedSource);
      }

      const elapsedMs = Date.now() - startedAt;
      assert.ok(
        elapsedMs < 1_500,
        `expected five close re-add edits to stay below 1.5s total, got ${elapsedMs}ms`,
      );
    },
  },
];

await runGoldenCases("Incremental Close-run Perf", " incremental close-run perf case", cases, { quietPasses: true });
