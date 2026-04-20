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

const makeNestedShorthand = (depth: number): string => {
  let text = "x";
  for (let i = depth; i >= 2; i--) text = `bold(${text})`;
  return `$$bold(${text})$$`;
};

const makeMalformedNestedShorthand = (depth: number, missingCloses: number): string => {
  const safeDepth = Math.max(depth, 2);
  const safeMissing = Math.max(1, Math.min(missingCloses, safeDepth - 1));
  const open = "bold(".repeat(safeDepth - 1);
  const closes = ")".repeat(safeDepth - safeMissing - 1);
  return `$$bold(${open}x${closes}$$`;
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
  {
    name: "[Deep/Shorthand] shorthand 嵌套应受 depthLimit 约束并降级",
    run() {
      const handlers = createSimpleInlineHandlers(["bold"]);
      // 5 layers of shorthand inside 1 full DSL, depthLimit=3 → layer 4+ degrades
      const input = "$$bold(L1: bold(L2: bold(L3: bold(L4: bold(L5: x)))))$$";
      const nodes = parseStructural(input, {
        handlers,
        depthLimit: 3,
        implicitInlineShorthand: true,
      });

      assert.equal(nodes.length, 1);
      assert.equal(nodes[0]?.type, "inline");

      // depth 0 → $$bold(...)$$ → depth 1
      // depth 1 → bold(...) → depth 2
      // depth 2 → bold(...) → depth 3 (at limit, next shorthand degrades)
      const root = nodes[0] as { children: unknown[] };
      // L1 text + bold shorthand child
      const l1Child = root.children[1] as { type: string; tag: string; children: unknown[] };
      assert.equal(l1Child.type, "inline");
      assert.equal(l1Child.tag, "bold");

      const l2Child = l1Child.children[1] as { type: string; tag: string; children: unknown[] };
      assert.equal(l2Child.type, "inline");
      assert.equal(l2Child.tag, "bold");

      // L3 should contain degraded text (bold(L4: ...) as plain text)
      const l3Text = l2Child.children.find(
        (c) => typeof c === "object" && c !== null && "type" in c && (c as { type: string }).type === "text",
      ) as { type: string; value: string } | undefined;
      assert.ok(l3Text, "L3 should have degraded text content");
      assert.ok(l3Text.value.includes("bold("), "degraded text should contain shorthand syntax as plain text");
    },
  },
  {
    name: "[Deep/Shorthand] shorthand depthLimit 降级应与完整 DSL 降级行为一致",
    run() {
      const handlers = createSimpleInlineHandlers(["bold"]);
      const depthLimit = 3;
      const opts = { handlers, depthLimit } as const;

      // Full DSL: 5 layers
      const fullDsl = "$$bold($$bold($$bold($$bold($$bold(x)$$)$$)$$)$$)$$";
      const fullNodes = parseStructural(fullDsl, opts);

      // Shorthand: 5 layers (1 full + 4 shorthand)
      const shorthand = "$$bold(bold(bold(bold(bold(x)))))$$";
      const shNodes = parseStructural(shorthand, {
        ...opts,
        implicitInlineShorthand: true,
      });

      // Both should produce a single root inline node
      assert.equal(fullNodes.length, 1);
      assert.equal(shNodes.length, 1);
      assert.equal(fullNodes[0]?.type, "inline");
      assert.equal(shNodes[0]?.type, "inline");

      // Both should have the same structural depth (3 levels of inline nodes)
      const countDepth = (node: unknown): number => {
        if (
          node &&
          typeof node === "object" &&
          "type" in node &&
          (node as { type: string }).type === "inline" &&
          "children" in node
        ) {
          const children = (node as { children: unknown[] }).children;
          const childDepths = children.map(countDepth);
          return 1 + Math.max(0, ...childDepths);
        }
        return 0;
      };

      assert.equal(countDepth(fullNodes[0]), countDepth(shNodes[0]), "structural depth should match");
    },
  },
  {
    name: "[Deep/Shorthand/Perf] 1 万层 shorthand 嵌套应保持线性性能",
    run() {
      const input = makeNestedShorthand(10_000);
      const handlers = createSimpleInlineHandlers(["bold"]);
      const options = { handlers, depthLimit: 10_100, implicitInlineShorthand: true } as const;

      const structural = measureMs(() => parseStructural(input, options));
      assert.equal(structural.value.length, 1);
      assert.equal(structural.value[0]?.type, "inline");
      assert.ok(
        structural.ms < 4_000,
        `parseStructural shorthand(10000) unexpectedly slow: ${structural.ms.toFixed(1)} ms`,
      );
    },
  },
  {
    name: "[Deep/Shorthand/Perf] 1 万层 malformed close-run 不应退化为灾难级复杂度",
    run() {
      const input = makeMalformedNestedShorthand(10_000, 120);
      const handlers = createSimpleInlineHandlers(["bold"]);
      const options = { handlers, depthLimit: 10_100, implicitInlineShorthand: true } as const;

      const structural = measureMs(() => parseStructural(input, options));
      assert.equal(structural.value.length, 1);
      assert.equal(structural.value[0]?.type, "inline");
      assert.ok(
        structural.ms < 6_000,
        `parseStructural malformed shorthand(10000) unexpectedly slow: ${structural.ms.toFixed(1)} ms`,
      );
    },
  },
];

await runGoldenCases("Deep Nesting", "Deep nesting case", cases);
