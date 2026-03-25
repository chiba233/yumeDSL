import assert from "node:assert/strict";
import {
  parseRichText,
  stripRichText,
  resetTokenIdSeed,
} from "../src/index.ts";
import type { TextToken, ParseError } from "../src/types.ts";
import { runGoldenCases } from "./testHarness.ts";
import { loadTestJsonFixture } from "./testFixtures.ts";
import { testHandlers } from "./handlers.ts";

// ── helpers ──

const parse = (text: string, opts?: { depthLimit?: number }) =>
  parseRichText(text, { handlers: testHandlers, ...opts });

const strip = (text: string) =>
  stripRichText(text, { handlers: testHandlers });

const parseWithErrors = (text: string, opts?: { depthLimit?: number }) => {
  const errors: ParseError[] = [];
  const tokens = parseRichText(text, {
    handlers: testHandlers,
    onError: (e) => errors.push(e),
    ...opts,
  });
  return { tokens, errors };
};

const normalizeTokens = (tokens: TextToken[]): unknown[] =>
  tokens.map((token) => {
    const { id: _id, value, ...rest } = token;
    return {
      ...rest,
      value: typeof value === "string" ? value : normalizeTokens(value),
    };
  });

const createDeterministicDirtyText = (
  seed: number,
  parts: readonly string[],
  length: number,
): string => {
  let state = seed >>> 0;
  let output = "";
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    output += parts[state % parts.length];
  }
  return output;
};

const createDeterministicNumbers = (
  seed: number,
  count: number,
  minInclusive: number,
  maxInclusive: number,
): number[] => {
  let state = seed >>> 0;
  const values: number[] = [];
  const span = maxInclusive - minInclusive + 1;
  for (let i = 0; i < count; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    values.push(minInclusive + (state % span));
  }
  return values;
};

const formatIsoDay = (base: string, offsetDays: number): string => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const formatIsoInstant = (base: string, offsetDays: number): string => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
};

// ── fixtures ──

interface RichTextCommonFixture {
  commonCases: Array<{
    name: string;
    mode: "parse" | "strip";
    input: string;
    depth?: number;
    richTextEnabled?: boolean;
    expectedTokens?: unknown[];
    expectedText?: string;
  }>;
  pipeCases: Array<{
    input: string;
    expectedTitle: string;
    expectedValue: unknown[];
  }>;
}

const commonFixture =
  await loadTestJsonFixture<RichTextCommonFixture>("richText.common.json");

interface RichTextInlineFixture {
  inlineCases: Array<{
    name: string;
    mode: "parse" | "strip";
    input: string;
    expectedTokens?: unknown[];
    expectedText?: string;
  }>;
}

const inlineFixture =
  await loadTestJsonFixture<RichTextInlineFixture>("richText.inline.json");

interface RichTextRawBlockFixture {
  cases: Array<{
    name: string;
    mode: "parse" | "strip";
    input: string;
    expectedTokens?: unknown[];
    expectedText?: string;
  }>;
}

const rawBlockFixture =
  await loadTestJsonFixture<RichTextRawBlockFixture>("richText.rawBlock.json");

// ── fixture-driven cases ──

const commonCases = commonFixture.commonCases.map((tc) => ({
  name: tc.name,
  run: () => {
    if (tc.mode === "strip") {
      assert.equal(strip(tc.input), tc.expectedText);
      return;
    }
    const tokens = parse(tc.input, { depthLimit: tc.depth ?? 50 });
    assert.deepEqual(normalizeTokens(tokens), tc.expectedTokens);
  },
}));

const inlineFixtureCases = inlineFixture.inlineCases.map((tc) => ({
  name: tc.name,
  run: () => {
    if (tc.mode === "strip") {
      assert.equal(strip(tc.input), tc.expectedText);
      return;
    }
    const tokens = parse(tc.input);
    assert.deepEqual(normalizeTokens(tokens), tc.expectedTokens);
  },
}));

const rawBlockFixtureCases = rawBlockFixture.cases.map((tc) => ({
  name: tc.name,
  run: () => {
    if (tc.mode === "strip") {
      assert.equal(strip(tc.input), tc.expectedText);
      return;
    }
    const tokens = parse(tc.input);
    assert.deepEqual(normalizeTokens(tokens), tc.expectedTokens);
  },
}));

// ── hand-written cases ──

const cases: Array<{ name: string; run: () => void }> = [
  // --- [Common] ---
  ...commonCases,
  {
    name: "[Common/Pipe] 管道符周围空格消费行为 -> 应当吞掉右侧空格并由处理器 trim 左侧",
    run: () => {
      commonFixture.pipeCases.forEach((pipeCase) => {
        const [token] = parse(pipeCase.input);
        assert.equal((token as any).title, pipeCase.expectedTitle);
        if (!Array.isArray(token.value)) throw new Error("value should be array");
        assert.deepEqual(normalizeTokens(token.value), pipeCase.expectedValue);
      });
    },
  },
  {
    name: "[Common/Hybrid] raw/block/inline 混合边界 -> 应当严格保持声明顺序与树状结构",
    run: () => {
      const tokens = parse(
        "$$collapse(A)*\n$$raw-code(ts)%\nconst a = 1\n%end$$\n$$bold(x)$$\n*end$$",
      );
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "collapse",
          title: "A",
          value: [
            {
              type: "raw-code",
              codeLang: "typescript",
              title: "Code:",
              label: "",
              value: "const a = 1\n",
            },
            {
              type: "bold",
              value: [{ type: "text", value: "x" }],
            },
            { type: "text", value: "\n" },
          ],
        },
      ]);
    },
  },
  {
    name: "[Common/Robustness] 随机脏输入压力测试 -> 解析器应当永不崩溃并保持输出稳定",
    run: () => {
      const parts = [
        "$$bold(",
        "$$thin(",
        "$$unknown(",
        "$$collapse(T)*\n",
        "$$raw-code(ts)%\n",
        ")$$",
        "*end$$",
        "%end$$",
        "\\)$$",
        "\\%end$$",
        "@text\n",
        "@end\n",
        "|",
        "(",
        ")",
        "\n",
        "hello",
        "世界",
        " ",
      ] as const;

      for (let seed = 1; seed <= 80; seed++) {
        const source = createDeterministicDirtyText(seed, parts, 24);
        assert.doesNotThrow(() => {
          const tokens = parse(source, { depthLimit: 4 });
          assert.ok(Array.isArray(tokens));
          assert.equal(typeof strip(source), "string");
        });
      }
    },
  },

  // --- [Inline] ---
  {
    name: "[Inline/Date] date 标签自定义格式与语言 -> 应当保留运行时渲染所需参数",
    run: () => {
      const tokens = parse("$$date(2024-01-02|YYYY/MM/DD|en)$$");
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "date", date: "2024-01-02", format: "YYYY/MM/DD", timeLang: "en", value: "" },
      ]);
    },
  },
  {
    name: "[Inline/Date] date 标签省略 format -> 应当保留日期与语言，交给运行时格式化",
    run: () => {
      const offsets = createDeterministicNumbers(42, 24, 0, 3650);
      offsets.forEach((offset) => {
        const date = formatIsoDay("2020-01-01", offset);
        const tokens = parse(`$$date(${date}||th)$$`);
        assert.deepEqual(normalizeTokens(tokens), [
          { type: "date", date, format: undefined, timeLang: "th", value: "" },
        ]);
      });
    },
  },
  {
    name: "[Inline/Time] fromNow 标签带语言参数 -> 应当保留运行时相对时间参数",
    run: () => {
      const baseNow = "2026-03-23T00:00:00.000Z";
      const offsets = createDeterministicNumbers(7, 20, -400, 400);
      offsets.forEach((offset) => {
        const date = formatIsoInstant(baseNow, offset);
        const tokens = parse(`$$fromNow(${date}|en)$$`);
        assert.deepEqual(normalizeTokens(tokens), [
          { type: "fromNow", date, timeLang: "en", value: "" },
        ]);
      });
    },
  },
  {
    name: "[Inline/Basic] 基础标签 -> 应当生成正确的嵌套 token 结构",
    run: () => {
      const tokens = parse("$$bold(Hello)$$");
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "bold", value: [{ type: "text", value: "Hello" }] },
      ]);
    },
  },
  ...inlineFixtureCases,
  {
    name: "[Inline/Variety] 多种 inline 标签并存 -> 应当生成对应的各类型 token",
    run: () => {
      const tokens = parse(
        "$$thin(x)$$ $$underline(y)$$ $$strike(z)$$ $$code(k)$$",
      );
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "thin", value: [{ type: "text", value: "x" }] },
        { type: "text", value: " " },
        { type: "underline", value: [{ type: "text", value: "y" }] },
        { type: "text", value: " " },
        { type: "strike", value: [{ type: "text", value: "z" }] },
        { type: "text", value: " " },
        { type: "code", value: [{ type: "text", value: "k" }] },
      ]);
    },
  },
  {
    name: "[Inline/Error] 未闭合 inline 标签 -> 应当上报 INLINE_NOT_CLOSED 错误",
    run: () => {
      const { errors } = parseWithErrors("line1\n$$bold(hello");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "INLINE_NOT_CLOSED");
      assert.equal(errors[0].line, 2);
      assert.equal(errors[0].column, 1);
      assert.match(errors[0].message, /Inline tag not closed/);
    },
  },
  {
    name: "[Inline/Specific] center 标签 -> 应当仅作为 inline 解析并生成正确 token",
    run: () => {
      const tokens = parse("$$center(hello)$$");
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "center", value: [{ type: "text", value: "hello" }] },
      ]);
    },
  },
  {
    name: "[Inline/Unknown] 未知标签 -> stripRichText 应当去壳并保留内部纯文本",
    run: () => {
      assert.equal(strip("$$unknown(hello world)$$"), "hello world");
    },
  },
  {
    name: "[Inline/Unknown] 未知标签嵌套 -> 去壳时应当递归保留内部的 known 标签",
    run: () => {
      const tokens = parse("$$unknown(hello $$bold(world)$$)$$");
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "text", value: "hello " },
        { type: "bold", value: [{ type: "text", value: "world" }] },
      ]);
    },
  },
  {
    name: "[Inline/Unknown] 未知标签 -> 应当 fallback 但不产生 runtime 错误",
    run: () => {
      const { errors } = parseWithErrors("$$unknown(hello world)$$");
      const text = strip("$$unknown(hello world)$$");
      assert.equal(text, "hello world");
      assert.equal(errors.length, 0);
    },
  },
  {
    name: "[Inline/Nested] 多层 inline 嵌套 -> 应当正确保持文本与子节点的相对顺序",
    run: () => {
      const tokens = parse("$$bold(outer $$thin(inner)$$ tail)$$");
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "bold",
          value: [
            { type: "text", value: "outer " },
            { type: "thin", value: [{ type: "text", value: "inner" }] },
            { type: "text", value: " tail" },
          ],
        },
      ]);
    },
  },

  // --- [Raw] ---
  {
    name: "[Raw/Code] 基础 raw-code -> 应当保留正文原始格式并归一化语言别名",
    run: () => {
      const tokens = parse("$$raw-code(js | demo)%\nconst a = 1\n%end$$");
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "raw-code",
          codeLang: "typescript",
          title: "demo",
          label: "",
          value: "const a = 1\n",
        },
      ]);
    },
  },
  ...rawBlockFixtureCases,
  {
    name: "[Raw/Escape] 内容中包含转义闭合符 -> 应当保留闭合符并继续解析到末尾",
    run: () => {
      const tokens = parse("$$raw-code(ts | Demo | Label)%\na\\%end$$\n%end$$");
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "raw-code",
          codeLang: "typescript",
          title: "Demo",
          label: "Label",
          value: "a%end$$\n",
        },
      ]);
    },
  },
  {
    name: "[Raw/Boundary] 空 raw-code (无正文段) -> 应当退化为普通文本处理",
    run: () => {
      assert.equal(strip("$$raw-code()%%end$$"), "$$raw-code()%%end$$");
    },
  },
  {
    name: "[Raw/Boundary] 未闭合 raw 标签 -> 应当退化为普通文本",
    run: () => {
      assert.equal(
        strip("$$raw-code(ts)%\nconst a = 1"),
        "$$raw-code(ts)%\nconst a = 1",
      );
    },
  },
  {
    name: "[Raw/Boundary] close 行格式错误 -> 应当 fallback 并上报 RAW_CLOSE_MALFORMED 错误",
    run: () => {
      const { errors } = parseWithErrors("$$raw-code(ts)%\nconst a = 1\n  %end$$");
      assert.equal(
        strip("$$raw-code(ts)%\nconst a = 1\n  %end$$"),
        "$$raw-code(ts)%\nconst a = 1\n  %end$$",
      );
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "RAW_CLOSE_MALFORMED");
      assert.match(errors[0].message, /Malformed raw close/);
    },
  },
  {
    name: "[Raw/Unknown] 未知 raw 语法 -> 应当整体退化为普通文本",
    run: () => {
      assert.equal(
        strip("$$unknown(title)%\nhello\n%end$$"),
        "$$unknown(title)%\nhello\n%end$$",
      );
    },
  },
  {
    name: "[Raw/Morph] info 的 raw 形态 -> 应当生成带对应标题的富文本块 token",
    run: () => {
      const tokens = parse("$$info(标题)%\n正文\n%end$$");
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "info",
          title: "标题",
          value: [{ type: "text", value: "正文\n" }],
        },
      ]);
    },
  },
  {
    name: "[Raw/Morph] warning 的 raw 形态 -> 应当生成带对应标题的富文本块 token",
    run: () => {
      const tokens = parse("$$warning(标题)%\n正文\n%end$$");
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "warning",
          title: "标题",
          value: [{ type: "text", value: "正文\n" }],
        },
      ]);
    },
  },
  {
    name: "[Raw/Morph] collapse 的 raw 形态 -> 应当生成带对应标题的富文本块 token",
    run: () => {
      const tokens = parse("$$collapse(标题)%\n正文\n%end$$");
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "collapse",
          title: "标题",
          value: [{ type: "text", value: "正文\n" }],
        },
      ]);
    },
  },
  {
    name: "[Raw/Degrade] 仅支持 inline 的标签使用 raw 语法 -> 应当整体退化为文本",
    run: () => {
      assert.equal(strip("$$center(标题)%\n正文\n%end$$"), "$$center(标题)%\n正文\n%end$$");
    },
  },

  // --- [Block] ---
  {
    name: "[Block/Boundary] close 行格式错误 -> 应当 fallback 并上报 BLOCK_CLOSE_MALFORMED 错误",
    run: () => {
      const { errors } = parseWithErrors("$$collapse(Title)*\nhello\n  *end$$");
      assert.equal(
        strip("$$collapse(Title)*\nhello\n  *end$$"),
        "$$collapse(Title)*\nhello\n  *end$$",
      );
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "BLOCK_CLOSE_MALFORMED");
      assert.match(errors[0].message, /Malformed block close/);
    },
  },
];

// Reset token ID seed before running to ensure deterministic output
resetTokenIdSeed();

await runGoldenCases("Rich Text DSL", " Rich Text golden case", cases);
