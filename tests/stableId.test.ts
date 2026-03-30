import assert from "node:assert/strict";
import { createEasyStableId, createParser } from "../src/index.ts";
import type { TokenDraft } from "../src/index.ts";
import { testHandlers } from "./handlers.ts";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";

const cases: GoldenCase[] = [
  {
    name: "[StableId/Default] 每次新建 generator 时相同输入应生成相同 id",
    run() {
      const firstDsl = createParser({ handlers: testHandlers, createId: createEasyStableId() });
      const secondDsl = createParser({ handlers: testHandlers, createId: createEasyStableId() });

      const first = firstDsl.parse("$$bold(hi)$$");
      const second = secondDsl.parse("$$bold(hi)$$");

      assert.equal(first[0].id, second[0].id);
      assert.equal(first[0].id.startsWith("s-"), true);
    },
  },
  {
    name: "[StableId/Stateful] 共享 generator 时重复 fingerprint 应跨 parse 继续追加后缀",
    run() {
      const createId = createEasyStableId();
      const dsl = createParser({ handlers: testHandlers, createId });

      const first = dsl.parse("$$bold(hi)$$");
      const second = dsl.parse("$$bold(hi)$$");

      assert.notEqual(first[0].id, second[0].id);
      assert.equal(second[0].id.startsWith(`${first[0].id}-`), true);
    },
  },
  {
    name: "[StableId/Duplicate] 相同 fingerprint 应按出现顺序追加后缀",
    run() {
      const createId = createEasyStableId();
      const dsl = createParser({ handlers: testHandlers, createId });

      const tokens = dsl.parse("$$bold(a)$$ $$bold(a)$$");
      const boldTokens = tokens.filter((token) => token.type === "bold");

      assert.equal(boldTokens.length, 2);
      assert.notEqual(boldTokens[0].id, boldTokens[1].id);
      assert.equal(boldTokens[1].id.startsWith(`${boldTokens[0].id}-`), true);
    },
  },
  {
    name: "[StableId/Prefix] 自定义前缀 -> 应当应用到最终 id",
    run() {
      const createId = createEasyStableId({ prefix: "blog" });
      const dsl = createParser({ handlers: testHandlers, createId });

      const tokens = dsl.parse("$$bold(hi)$$");

      assert.equal(tokens[0].id.startsWith("blog-"), true);
    },
  },
  {
    name: "[StableId/Fingerprint] 自定义 fingerprint -> 可覆盖默认 type+value 策略",
    run() {
      const factoryOptions = {
        fingerprint: (token: TokenDraft) => {
          const title = typeof token.title === "string" ? token.title : "";
          return `${token.type}:${title}`;
        },
      };
      const parseWithFreshGenerator = (text: string) =>
        createParser({
          handlers: testHandlers,
          createId: createEasyStableId(factoryOptions),
        }).parse(text);

      const a = parseWithFreshGenerator("$$info(One | A)$$");
      const b = parseWithFreshGenerator("$$info(One | B)$$");
      const c = parseWithFreshGenerator("$$info(Two | A)$$");

      assert.equal(a[0].id, b[0].id);
      assert.notEqual(a[0].id, c[0].id);
    },
  },
];

await runGoldenCases("Stable Id", " Stable id case", cases);
