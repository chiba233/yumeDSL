import assert from "node:assert/strict";
import { createEasyStableId, createParser, type TagHandler } from "../src/index.ts";
import type { TokenDraft } from "../src/index.ts";
import type { DslContext, TextToken } from "../src/types.ts";
import { testHandlers } from "./handlers.ts";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";


const textDraft = (value: string, id: string): TextToken => ({ type: "text", value, id });
const branchDraft = (type: string, value: TextToken[], id: string): TextToken => ({ type, value, id });

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
    name: "[StableId/ParseScopeDefault] 共享 generator 时每次 parse 应重置重复计数",
    run() {
      const createId = createEasyStableId();
      const dsl = createParser({ handlers: testHandlers, createId });

      const first = dsl.parse("$$bold(hi)$$");
      const second = dsl.parse("$$bold(hi)$$");

      assert.equal(first[0].id, second[0].id);
    },
  },
  {
    name: "[StableId/ParseScopeDefault] 重入 parse 不应污染外层消歧状态",
    run() {
      const baselineDsl = createParser({ handlers: testHandlers, createId: createEasyStableId() });
      const baseline = baselineDsl
        .parse("$$bold(hi)$$ $$bold(hi)$$")
        .filter((token) => token.type === "bold")
        .map((token) => token.id);

      const sharedCreateId = createEasyStableId();
      const innerDsl = createParser({ handlers: testHandlers, createId: sharedCreateId });
      const boldBase = testHandlers.bold as TagHandler;
      const reentrantHandlers = {
        ...testHandlers,
        bold: {
          inline: (tokens: TextToken[], ctx?: DslContext) => {
            innerDsl.parse("$$bold(hi)$$");
            return boldBase.inline!(tokens, ctx);
          },
        },
      };
      const outerDsl = createParser({ handlers: reentrantHandlers, createId: sharedCreateId });

      const reentrant = outerDsl
        .parse("$$bold(hi)$$ $$bold(hi)$$")
        .filter((token) => token.type === "bold")
        .map((token) => token.id);

      assert.deepEqual(reentrant, baseline);
    },
  },
  {
    name: "[StableId/LifetimeScope] 配置 lifetime 时共享 generator 应跨 parse 继续追加后缀",
    run() {
      const createId = createEasyStableId({ disambiguationScope: "lifetime" });
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
  {
    name: "[StableId/Text] 直接生成 text draft id -> 重复值应追加后缀",
    run() {
      const createId = createEasyStableId();

      const first = createId({ type: "text", value: "hello" });
      const second = createId({ type: "text", value: "hello" });
      const third = createId({ type: "text", value: "world" });

      assert.equal(first.startsWith("s-"), true);
      assert.equal(second, `${first}-1`);
      assert.notEqual(third, first);
    },
  },
  {
    name: "[StableId/Nested] 默认 fingerprint -> 嵌套结构变化应影响 id",
    run() {
      const createId = createEasyStableId();

      const first: TokenDraft = {
        ...branchDraft("bold", [
          textDraft("a", "text-a-1"),
          branchDraft("italic", [textDraft("b", "text-b-1")], "italic-b-1"),
        ], "bold-ab-1"),
      };
      const same: TokenDraft = {
        ...branchDraft("bold", [
          textDraft("a", "text-a-2"),
          branchDraft("italic", [textDraft("b", "text-b-2")], "italic-b-2"),
        ], "bold-ab-2"),
      };
      const changed: TokenDraft = {
        ...branchDraft("bold", [
          textDraft("a", "text-a-3"),
          branchDraft("italic", [textDraft("c", "text-c-1")], "italic-c-1"),
        ], "bold-ac-1"),
      };

      const firstId = createId(first);
      const secondId = createId(same);
      const changedId = createId(changed);

      assert.equal(secondId, `${firstId}-1`);
      assert.notEqual(changedId, firstId);
      assert.notEqual(changedId, secondId);
    },
  },
];

await runGoldenCases("Stable Id", " Stable id case", cases);
