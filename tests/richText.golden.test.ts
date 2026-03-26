import assert from "node:assert/strict";
import {
  createParser,
  createPassthroughTags,
  createPipeBlockHandlers,
  createPipeRawHandlers,
  createSimpleBlockHandlers,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  createTagNameConfig,
  declareMultilineTags,
  parsePipeTextList,
  parseRichText,
  resetTokenIdSeed,
  stripRichText,
} from "../src/index.ts";
import type { ParseError, TextToken } from "../src/types.ts";
import { runGoldenCases } from "./testHarness.ts";
import { loadTestJsonFixture } from "./testFixtures.ts";
import { testHandlers } from "./handlers.ts";

// ── helpers ──

const parse = (text: string, opts?: { depthLimit?: number }) =>
  parseRichText(text, { handlers: testHandlers, ...opts });

const strip = (text: string) => stripRichText(text, { handlers: testHandlers });

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

const helperHandlers = {
  ...createSimpleInlineHandlers(["bold", "italic"] as const),
  ...createSimpleBlockHandlers(["info"] as const),
  ...createSimpleRawHandlers(["code"] as const),
  ...createPassthroughTags(["pass"] as const),
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

const commonFixture = await loadTestJsonFixture<RichTextCommonFixture>("richText.common.json");

interface RichTextInlineFixture {
  inlineCases: Array<{
    name: string;
    mode: "parse" | "strip";
    input: string;
    expectedTokens?: unknown[];
    expectedText?: string;
  }>;
}

const inlineFixture = await loadTestJsonFixture<RichTextInlineFixture>("richText.inline.json");

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
    name: "[Common/Pipe] parsePipeTextList -> 应当处理 trim / 空段 / 转义管道符",
    run: () => {
      assert.deepEqual(parsePipeTextList(" ts | Demo | Label "), ["ts", "Demo", "Label"]);
      assert.deepEqual(parsePipeTextList("a||c"), ["a", "", "c"]);
      assert.deepEqual(parsePipeTextList(String.raw`a \| b | c`), ["a | b", "c"]);
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
  {
    name: "[Common/Robustness] 自定义 syntax 随机脏输入压力测试 -> 解析器应当保持输出稳定",
    run: () => {
      const parts = [
        "@@bold<<",
        "@@thin<<",
        "@@unknown<<",
        "@@panel<<T>>*\n",
        "@@code<<ts>>%\n",
        ">>@@",
        "*end@@",
        "%end@@",
        "~>>@@",
        "~%end@@",
        "text\n",
        "||",
        "<<",
        ">>",
        "\n",
        "hello",
        "世界",
        " ",
      ] as const;

      const syntax = {
        tagPrefix: "@@",
        tagOpen: "<<",
        tagClose: ">>",
        tagDivider: "||",
        endTag: ">>@@",
        rawOpen: ">>%",
        blockOpen: ">>*",
        rawClose: "%end@@",
        blockClose: "*end@@",
        escapeChar: "~",
      } as const;

      const handlers = {
        bold: testHandlers.bold,
        thin: testHandlers.thin,
        panel: {
          block: (arg: string | undefined, tokens: TextToken[]) => ({
            type: "panel",
            arg,
            value: tokens,
          }),
        },
        code: {
          raw: (arg: string | undefined, content: string) => ({
            type: "code",
            arg,
            value: content,
          }),
        },
      };

      for (let seed = 101; seed <= 140; seed++) {
        const source = createDeterministicDirtyText(seed, parts, 20);
        assert.doesNotThrow(() => {
          const tokens = parseRichText(source, {
            handlers,
            depthLimit: 4,
            syntax,
          });
          assert.ok(Array.isArray(tokens));
        });
      }
    },
  },
  {
    name: "[Common/Syntax] 自定义多字符 token 的转义 -> endTag/rawOpen/blockOpen 应能按字面量保留",
    run: () => {
      const tokens = parseRichText("@@bold[[A ~]]>> B ~]]% C ~]]* D]]>>", {
        handlers: { bold: testHandlers.bold },
        syntax: {
          tagPrefix: "@@",
          tagOpen: "[[",
          tagClose: "]]",
          endTag: "]]>>",
          rawOpen: "]]%",
          blockOpen: "]]*",
          rawClose: "%end@@",
          blockClose: "*end@@",
          escapeChar: "~",
        },
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "bold", value: [{ type: "text", value: "A ]]>> B ]]% C ]]* D" }] },
      ]);
    },
  },
  {
    name: "[Common/TagName] 自定义起始字符规则 -> 应当允许数字开头标签",
    run: () => {
      const tokens = parseRichText("$$1tag(hello)$$", {
        handlers: {
          "1tag": {
            inline: (value) => ({ type: "1tag", value }),
          },
        },
        tagName: {
          isTagStartChar: (char) => /[A-Za-z0-9_]/.test(char),
        },
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "1tag", value: [{ type: "text", value: "hello" }] },
      ]);
    },
  },
  {
    name: "[Common/TagName] 自定义后续字符规则 -> 应当允许冒号出现在标签名中",
    run: () => {
      const tagName = createTagNameConfig({
        isTagChar: (char) => /[A-Za-z0-9_:-]/.test(char),
      });
      const tokens = parseRichText("$$ui:button(hello)$$", {
        handlers: {
          "ui:button": {
            inline: (value) => ({ type: "ui:button", value }),
          },
        },
        tagName,
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "ui:button", value: [{ type: "text", value: "hello" }] },
      ]);
    },
  },
  {
    name: "[Common/TagName] createParser 默认配置 -> 应当继承自定义标签字符规则",
    run: () => {
      const parser = createParser({
        handlers: {
          "1tag": {
            inline: (value) => ({ type: "1tag", value }),
          },
        },
        tagName: {
          isTagStartChar: (char) => /[A-Za-z0-9_]/.test(char),
        },
      });
      const tokens = parser.parse("$$1tag(hello)$$");
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "1tag", value: [{ type: "text", value: "hello" }] },
      ]);
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
      const tokens = parse("$$thin(x)$$ $$underline(y)$$ $$strike(z)$$ $$code(k)$$");
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
    name: "[Inline/Error] 孤立闭合符 -> 应当上报 UNEXPECTED_CLOSE 错误",
    run: () => {
      const { errors } = parseWithErrors("hello )$$ world");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "UNEXPECTED_CLOSE");
      assert.match(errors[0].message, /Unexpected close tag/);
    },
  },
  {
    name: "[Inline/Error] onError 回调抛异常 -> 解析器不应中断",
    run: () => {
      assert.doesNotThrow(() => {
        const tokens = parseRichText("$$bold(unclosed", {
          handlers: testHandlers,
          onError: () => {
            throw new Error("user callback failed");
          },
        });
        assert.deepEqual(normalizeTokens(tokens), [{ type: "text", value: "$$bold(unclosed" }]);
      });
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
  {
    name: "[Inline/Helpers] simple inline + passthrough helper -> 应当生成预期 token 结构",
    run: () => {
      const tokens = parseRichText("$$bold(x)$$ $$pass(y)$$", {
        handlers: helperHandlers,
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "bold", value: [{ type: "text", value: "x" }] },
        { type: "text", value: " " },
        { type: "pass", value: [{ type: "text", value: "y" }] },
      ]);
    },
  },
  {
    name: "[Inline/Syntax] 自定义多字符开闭符 -> 应当正确解析 inline 标签",
    run: () => {
      const tokens = parseRichText("@@bold<<hi>>@@", {
        handlers: { bold: testHandlers.bold },
        syntax: {
          tagPrefix: "@@",
          tagOpen: "<<",
          tagClose: ">>",
          endTag: ">>@@",
          rawOpen: ">>%",
          blockOpen: ">>*",
          rawClose: "%end@@",
          blockClose: "*end@@",
          escapeChar: "~",
        },
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "bold", value: [{ type: "text", value: "hi" }] },
      ]);
    },
  },
  {
    name: "[Inline/Syntax] 自定义多字符分隔符 -> parsePipeArgs 应当正确分段",
    run: () => {
      const tokens = parseRichText("@@link<<https://a.com || click me>>@@", {
        handlers: { link: testHandlers.link },
        syntax: {
          tagPrefix: "@@",
          tagOpen: "<<",
          tagClose: ">>",
          tagDivider: "||",
          endTag: ">>@@",
          rawOpen: ">>%",
          blockOpen: ">>*",
          rawClose: "%end@@",
          blockClose: "*end@@",
          escapeChar: "~",
        },
      });
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "link",
          url: "https://a.com",
          value: [{ type: "text", value: "click me" }],
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
      assert.equal(strip("$$raw-code(ts)%\nconst a = 1"), "$$raw-code(ts)%\nconst a = 1");
    },
  },
  {
    name: "[Raw/Error] 未闭合 raw 标签 -> 应当上报 RAW_NOT_CLOSED 错误",
    run: () => {
      const { errors } = parseWithErrors("$$raw-code(ts)%\nconst a = 1");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "RAW_NOT_CLOSED");
      assert.match(errors[0].message, /Raw block not closed/);
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
      assert.equal(strip("$$unknown(title)%\nhello\n%end$$"), "$$unknown(title)%\nhello\n%end$$");
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
  {
    name: "[Raw/Helpers] simple raw helper -> 应当保留 arg 与原始正文",
    run: () => {
      const tokens = parseRichText("$$code(ts)%\nconst x = 1\n%end$$", {
        handlers: helperHandlers,
        blockTags: declareMultilineTags(["info", "code"] as const),
      });
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "code",
          arg: "ts",
          value: "const x = 1\n",
        },
      ]);
    },
  },
  {
    name: "[Raw/Syntax] 自定义多字符开闭符 -> 应当正确解析 raw 标签",
    run: () => {
      const tokens = parseRichText("@@code<<ts>>%\nconst x = 1\n%end@@", {
        handlers: {
          code: {
            raw: (arg: string | undefined, content: string) => ({
              type: "code",
              arg,
              value: content,
            }),
          },
        },
        syntax: {
          tagPrefix: "@@",
          tagOpen: "<<",
          tagClose: ">>",
          endTag: ">>@@",
          rawOpen: ">>%",
          blockOpen: ">>*",
          rawClose: "%end@@",
          blockClose: "*end@@",
          escapeChar: "~",
        },
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "code", arg: "ts", value: "const x = 1\n" },
      ]);
    },
  },

  // --- [Block] ---
  {
    name: "[Block/Helpers] simple block helper -> 应当保留 arg 并递归解析内容",
    run: () => {
      const tokens = parseRichText("$$info(Notice)*\nA $$italic(B)$$\n*end$$", {
        handlers: helperHandlers,
        blockTags: declareMultilineTags(["info", "code"] as const),
      });
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "info",
          arg: "Notice",
          value: [
            { type: "text", value: "A " },
            { type: "italic", value: [{ type: "text", value: "B" }] },
            { type: "text", value: "\n" },
          ],
        },
      ]);
    },
  },
  {
    name: "[Block/Helpers] declareMultilineTags -> 应当执行块级换行归一化",
    run: () => {
      const tokens = parseRichText("$$info(Title)*\nline\n*end$$\nnext", {
        handlers: helperHandlers,
        blockTags: declareMultilineTags(["info"] as const),
      });
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "info",
          arg: "Title",
          value: [{ type: "text", value: "line\n" }],
        },
        { type: "text", value: "next" },
      ]);
    },
  },
  {
    name: "[Block/Syntax] 自定义多字符开闭符 -> 应当正确解析 block 标签",
    run: () => {
      const tokens = parseRichText("@@info<<Notice>>*\nA @@bold<<B>>@@\n*end@@", {
        handlers: {
          bold: testHandlers.bold,
          info: {
            block: (arg: string | undefined, tokens: TextToken[]) => ({
              type: "info",
              arg,
              value: tokens,
            }),
          },
        },
        syntax: {
          tagPrefix: "@@",
          tagOpen: "<<",
          tagClose: ">>",
          endTag: ">>@@",
          rawOpen: ">>%",
          blockOpen: ">>*",
          rawClose: "%end@@",
          blockClose: "*end@@",
          escapeChar: "~",
        },
      });
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "info",
          arg: "Notice",
          value: [
            { type: "text", value: "A " },
            { type: "bold", value: [{ type: "text", value: "B" }] },
            { type: "text", value: "\n" },
          ],
        },
      ]);
    },
  },
  {
    name: "[Forms] allowForms 只允许 inline -> raw 与 block 应当整体退化为文本",
    run: () => {
      const input =
        "$$bold(x)$$\n$$info(Title)*\nline\n*end$$\n$$code(ts)%\n1\n%end$$\n$$pass(y)$$";
      const tokens = parseRichText(input, {
        handlers: helperHandlers,
        allowForms: ["inline"],
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "bold", value: [{ type: "text", value: "x" }] },
        { type: "text", value: "\n$$info(Title)*\nline\n*end$$\n$$code(ts)%\n1\n%end$$\n" },
        { type: "pass", value: [{ type: "text", value: "y" }] },
      ]);
    },
  },
  {
    name: "[Forms] allowForms 只允许 inline -> 已注册但被过滤掉的 block/raw-only inline 标签应保留原文",
    run: () => {
      const tokens = parseRichText("$$info(hello)$$ $$code(ts)$$", {
        handlers: helperHandlers,
        allowForms: ["inline"],
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "text", value: "$$info(hello)$$ $$code(ts)$$" },
      ]);
    },
  },
  {
    name: "[Forms] allowForms 禁用 inline -> passthrough 与 inline helper 也应整体保留原文",
    run: () => {
      const tokens = parseRichText("$$bold(x)$$ $$pass(y)$$", {
        handlers: helperHandlers,
        allowForms: ["raw", "block"],
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "text", value: "$$bold(x)$$ $$pass(y)$$" },
      ]);
    },
  },
  {
    name: "[Forms] allowForms 禁用 inline -> 未注册 inline 标签也应整体保留原文",
    run: () => {
      const tokens = parseRichText("$$unknown(hello)$$", {
        handlers: {},
        allowForms: ["raw", "block"],
      });
      assert.deepEqual(normalizeTokens(tokens), [{ type: "text", value: "$$unknown(hello)$$" }]);
      assert.equal(
        stripRichText("$$unknown(hello)$$", {
          handlers: {},
          allowForms: ["raw", "block"],
        }),
        "$$unknown(hello)$$",
      );
    },
  },
  {
    name: "[Forms] allowForms 禁用 inline -> 保留 raw/block 的标签不应再接受 inline 语法",
    run: () => {
      const tokens = parseRichText("$$info(T)$$ $$code(ts)$$", {
        handlers: helperHandlers,
        allowForms: ["raw", "block"],
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "text", value: "$$info(T)$$ $$code(ts)$$" },
      ]);
    },
  },
  {
    name: "[Forms/Matrix] 同标签同时支持 inline/raw/block -> complex form 仍应优先于 inline",
    run: () => {
      const handlers = {
        multi: {
          inline: (tokens: TextToken[]) => ({ type: "multi-inline", value: tokens }),
          raw: (arg: string | undefined, content: string) => ({
            type: "multi-raw",
            arg,
            value: content,
          }),
          block: (arg: string | undefined, tokens: TextToken[]) => ({
            type: "multi-block",
            arg,
            value: tokens,
          }),
        },
      };

      const tokens = parseRichText(
        "$$multi(i)$$\n$$multi(r)%\nraw\n%end$$\n$$multi(b)*\nblock\n*end$$",
        { handlers },
      );

      assert.deepEqual(normalizeTokens(tokens), [
        { type: "multi-inline", value: [{ type: "text", value: "i" }] },
        { type: "multi-raw", arg: "r", value: "raw\n" },
        { type: "multi-block", arg: "b", value: [{ type: "text", value: "block\n" }] },
      ]);
    },
  },
  {
    name: "[Forms/Matrix] 同标签多 form + allowForms 只允许 raw/block -> inline 形态应保留原文，complex 形态正常",
    run: () => {
      const handlers = {
        multi: {
          inline: (tokens: TextToken[]) => ({ type: "multi-inline", value: tokens }),
          raw: (arg: string | undefined, content: string) => ({
            type: "multi-raw",
            arg,
            value: content,
          }),
          block: (arg: string | undefined, tokens: TextToken[]) => ({
            type: "multi-block",
            arg,
            value: tokens,
          }),
        },
      };

      const tokens = parseRichText(
        "$$multi(i)$$\n$$multi(r)%\nraw\n%end$$\n$$multi(b)*\nblock\n*end$$",
        { handlers, allowForms: ["raw", "block"] },
      );

      assert.deepEqual(normalizeTokens(tokens), [
        { type: "text", value: "$$multi(i)$$\n" },
        { type: "multi-raw", arg: "r", value: "raw\n" },
        { type: "multi-block", arg: "b", value: [{ type: "text", value: "block\n" }] },
      ]);
    },
  },
  {
    name: "[Forms/Matrix] 同标签多 form + allowForms 只允许 inline -> complex 形态应整体退化为文本",
    run: () => {
      const handlers = {
        multi: {
          inline: (tokens: TextToken[]) => ({ type: "multi-inline", value: tokens }),
          raw: (arg: string | undefined, content: string) => ({
            type: "multi-raw",
            arg,
            value: content,
          }),
          block: (arg: string | undefined, tokens: TextToken[]) => ({
            type: "multi-block",
            arg,
            value: tokens,
          }),
        },
      };

      const tokens = parseRichText(
        "$$multi(i)$$\n$$multi(r)%\nraw\n%end$$\n$$multi(b)*\nblock\n*end$$",
        { handlers, allowForms: ["inline"] },
      );

      assert.deepEqual(normalizeTokens(tokens), [
        { type: "multi-inline", value: [{ type: "text", value: "i" }] },
        { type: "text", value: "\n$$multi(r)%\nraw\n%end$$\n$$multi(b)*\nblock\n*end$$" },
      ]);
    },
  },
  {
    name: "[Helpers] block/raw-only helper -> 不应偷偷接受 inline 语法",
    run: () => {
      const tokens = parseRichText("$$info(T)$$ $$code(ts)$$", {
        handlers: helperHandlers,
      });
      assert.deepEqual(normalizeTokens(tokens), [
        { type: "text", value: "$$info(T)$$ $$code(ts)$$" },
      ]);
    },
  },
  {
    name: "[Helpers] pipe block helper -> 应当透传 arg、解析 args 并保留 block 内容",
    run: () => {
      const handlers = {
        ...createPipeBlockHandlers(["panel"] as const),
      };
      const tokens = parseRichText("$$panel(a | b | c)*\nbody\n*end$$", { handlers });
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "panel",
          arg: "a | b | c",
          args: ["a", "b", "c"],
          value: [{ type: "text", value: "body\n" }],
        },
      ]);
    },
  },
  {
    name: "[Helpers] pipe raw helper -> 应当透传 arg、解析 args 并保留 raw 内容",
    run: () => {
      const handlers = {
        ...createPipeRawHandlers(["code"] as const),
      };
      const tokens = parseRichText("$$code(ts | Demo | Label)%\nconst x = 1\n%end$$", { handlers });
      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "code",
          arg: "ts | Demo | Label",
          args: ["ts", "Demo", "Label"],
          value: "const x = 1\n",
        },
      ]);
    },
  },
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
  {
    name: "[Block/Error] 未闭合 block 标签 -> 应当上报 BLOCK_NOT_CLOSED 错误",
    run: () => {
      const { errors } = parseWithErrors("$$collapse(Title)*\nhello");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "BLOCK_NOT_CLOSED");
      assert.match(errors[0].message, /Block tag not closed/);
    },
  },
  {
    name: "[Depth/Error] 超过嵌套深度限制 -> 应当上报 DEPTH_LIMIT 错误",
    run: () => {
      const { errors } = parseWithErrors("$$bold($$bold($$bold(deep)$$)$$)$$", {
        depthLimit: 1,
      });
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "DEPTH_LIMIT");
      assert.match(errors[0].message, /Nesting too deep/);
    },
  },
];

// Reset token ID seed before running to ensure deterministic output
resetTokenIdSeed();

await runGoldenCases("Rich Text DSL", " Rich Text golden case", cases);
