import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createSimpleInlineHandlers, parseRichText, parseStructural } from "../src/index.ts";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";

const makeNestedInline = (depth: number): string => {
  let text = "x";
  for (let i = 0; i < depth; i++) text = `$$bold(${text})$$`;
  return text;
};

const measureMs = <T>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

const cases: GoldenCase[] = [
  {
    name: "[Deep] 2000 层 inline 嵌套不应因调用栈爆掉",
    run() {
      const input = makeNestedInline(2000);
      const handlers = createSimpleInlineHandlers(["bold"]);
      const options = { handlers, depthLimit: 3000, trackPositions: true } as const;

      const nodes = parseStructural(input, options);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0]?.type, "inline");

      const tokens = parseRichText(input, options);
      assert.equal(tokens.length, 1);

      let depth = 0;
      let current: unknown = tokens[0];
      while (
        current &&
        typeof current === "object" &&
        "type" in current &&
        current.type === "bold" &&
        "value" in current &&
        Array.isArray(current.value) &&
        current.value.length === 1
      ) {
        depth++;
        current = current.value[0];
      }

      assert.equal(depth, 2000);
      assert.ok(current && typeof current === "object");
      assert.equal((current as { type: string }).type, "text");
      assert.equal((current as { value: string }).value, "x");
    },
  },
  {
    name: "[Deep/Perf] 2 万层 inline 嵌套不应退回灾难级复杂度",
    run() {
      const input = makeNestedInline(20_000);
      const handlers = createSimpleInlineHandlers(["bold"]);
      const options = { handlers, depthLimit: 20_100 } as const;

      const structural = measureMs(() => parseStructural(input, options));
      assert.equal(structural.value.length, 1);
      assert.equal(structural.value[0]?.type, "inline");
      assert.ok(
        structural.ms < 4_000,
        `parseStructural(20000) unexpectedly slow: ${structural.ms.toFixed(1)} ms`,
      );

      const rich = measureMs(() => parseRichText(input, options));
      assert.equal(rich.value.length, 1);
      assert.ok(
        rich.ms < 4_000,
        `parseRichText(20000) unexpectedly slow: ${rich.ms.toFixed(1)} ms`,
      );
    },
  },
  {
    name: "[Deep/Perf] 5 万层 structural parse 应保持可运行",
    run() {
      const input = makeNestedInline(50_000);
      const handlers = createSimpleInlineHandlers(["bold"]);
      const options = { handlers, depthLimit: 50_100 } as const;

      const structural = measureMs(() => parseStructural(input, options));
      assert.equal(structural.value.length, 1);
      assert.equal(structural.value[0]?.type, "inline");
      assert.ok(
        structural.ms < 5_000,
        `parseStructural(50000) unexpectedly slow: ${structural.ms.toFixed(1)} ms`,
      );
    },
  },
];

await runGoldenCases("Deep Nesting", "Deep nesting case", cases);
