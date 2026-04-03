import assert from "node:assert/strict";
import { createSimpleInlineHandlers, parseRichText, parseStructural } from "../src/index.ts";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";

const makeNestedInline = (depth: number): string => {
  let text = "x";
  for (let i = 0; i < depth; i++) text = `$$bold(${text})$$`;
  return text;
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
];

await runGoldenCases("Deep Nesting", "Deep nesting case", cases);
