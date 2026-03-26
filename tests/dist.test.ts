/**
 * Smoke tests against the built dist artefacts (ESM + CJS).
 * Run `npm run build` before this test.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runGoldenCases } from "./testHarness.ts";
import { testHandlers } from "./handlers.ts";

// ── Load both module formats ──

const esm = await import("../dist/index.js");

const require = createRequire(import.meta.url);
const cjs = require("../dist/index.cjs");

// ── helpers ──

type DistModule = typeof esm;

const smokeTest = (mod: DistModule, label: string) => {
  const parse = (text: string) =>
    mod.parseRichText(text, { handlers: testHandlers });

  const strip = (text: string) =>
    mod.stripRichText(text, { handlers: testHandlers });

  const normalize = (tokens: any[]): unknown[] =>
    tokens.map(({ id, value, ...rest }: any) => ({
      ...rest,
      value: typeof value === "string" ? value : normalize(value),
    }));

  return [
    // ── Exports exist ──
    {
      name: `[${label}] 所有核心导出存在`,
      run: () => {
        assert.equal(typeof mod.parseRichText, "function");
        assert.equal(typeof mod.stripRichText, "function");
        assert.equal(typeof mod.extractText, "function");
        assert.equal(typeof mod.materializeTextTokens, "function");
        assert.equal(typeof mod.splitTokensByPipe, "function");
        assert.equal(typeof mod.parsePipeArgs, "function");
        assert.equal(typeof mod.parsePipeTextArgs, "function");
        assert.equal(typeof mod.unescapeInline, "function");
        assert.equal(typeof mod.createToken, "function");
        assert.equal(typeof mod.resetTokenIdSeed, "function");
        assert.equal(typeof mod.createSyntax, "function");
        assert.equal(typeof mod.createSimpleInlineHandlers, "function");
        assert.equal(typeof mod.createSimpleBlockHandlers, "function");
        assert.equal(typeof mod.createSimpleRawHandlers, "function");
        assert.equal(typeof mod.createPassthroughTags, "function");
        assert.equal(typeof mod.declareMultilineTags, "function");
        assert.ok(mod.DEFAULT_SYNTAX);
      },
    },

    // ── parseRichText ──
    {
      name: `[${label}] parseRichText 纯文本`,
      run: () => {
        const tokens = parse("hello");
        assert.equal(tokens.length, 1);
        assert.equal(tokens[0].type, "text");
        assert.equal(tokens[0].value, "hello");
      },
    },
    {
      name: `[${label}] parseRichText inline 标签`,
      run: () => {
        const tokens = parse("$$bold(hi)$$");
        assert.deepEqual(normalize(tokens), [
          { type: "bold", value: [{ type: "text", value: "hi" }] },
        ]);
      },
    },
    {
      name: `[${label}] parseRichText 嵌套 inline`,
      run: () => {
        const tokens = parse("$$bold(a $$thin(b)$$ c)$$");
        assert.deepEqual(normalize(tokens), [
          {
            type: "bold",
            value: [
              { type: "text", value: "a " },
              { type: "thin", value: [{ type: "text", value: "b" }] },
              { type: "text", value: " c" },
            ],
          },
        ]);
      },
    },
    {
      name: `[${label}] parseRichText raw 块`,
      run: () => {
        const tokens = parse("$$raw-code(ts)%\nconst x = 1\n%end$$");
        assert.deepEqual(normalize(tokens), [
          {
            type: "raw-code",
            codeLang: "typescript",
            title: "Code:",
            label: "",
            value: "const x = 1\n",
          },
        ]);
      },
    },
    {
      name: `[${label}] parseRichText block 块`,
      run: () => {
        const tokens = parse("$$collapse(Title)*\ncontent\n*end$$");
        assert.deepEqual(normalize(tokens), [
          {
            type: "collapse",
            title: "Title",
            value: [{ type: "text", value: "content\n" }],
          },
        ]);
      },
    },
    {
      name: `[${label}] parseRichText 管道参数`,
      run: () => {
        const tokens = parse("$$link(https://a.com | click)$$");
        assert.deepEqual(normalize(tokens), [
          {
            type: "link",
            url: "https://a.com",
            value: [{ type: "text", value: "click" }],
          },
        ]);
      },
    },
    {
      name: `[${label}] parseRichText 转义`,
      run: () => {
        const tokens = parse("$$bold(a \\)$$ b)$$");
        assert.deepEqual(normalize(tokens), [
          { type: "bold", value: [{ type: "text", value: "a )$$ b" }] },
        ]);
      },
    },
    {
      name: `[${label}] parseRichText 空输入`,
      run: () => {
        assert.deepEqual(parse(""), []);
      },
    },

    // ── stripRichText ──
    {
      name: `[${label}] stripRichText 基础`,
      run: () => {
        assert.equal(strip("hello $$bold(world)$$"), "hello world");
      },
    },
    {
      name: `[${label}] stripRichText 嵌套`,
      run: () => {
        assert.equal(strip("$$bold(a $$thin(b)$$ c)$$"), "a b c");
      },
    },
    {
      name: `[${label}] stripRichText 未知标签`,
      run: () => {
        assert.equal(strip("$$unknown(text)$$"), "text");
      },
    },
    {
      name: `[${label}] stripRichText 未闭合标签退化`,
      run: () => {
        assert.equal(strip("$$bold(unclosed"), "$$bold(unclosed");
      },
    },

    // ── onError callback ──
    {
      name: `[${label}] onError 回调触发`,
      run: () => {
        const errors: any[] = [];
        mod.parseRichText("$$bold(unclosed", {
          handlers: testHandlers,
          onError: (e: any) => errors.push(e),
        });
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, "INLINE_NOT_CLOSED");
      },
    },

    // ── Utility functions ──
    {
      name: `[${label}] extractText`,
      run: () => {
        const tokens = parse("$$bold(hello)$$ world");
        assert.equal(mod.extractText(tokens), "hello world");
      },
    },
    {
      name: `[${label}] createToken + resetTokenIdSeed`,
      run: () => {
        mod.resetTokenIdSeed();
        const t = mod.createToken({ type: "test", value: "v" });
        assert.equal(t.type, "test");
        assert.equal(t.value, "v");
        assert.equal(typeof t.id, "string");
      },
    },
    {
      name: `[${label}] createSyntax + DEFAULT_SYNTAX`,
      run: () => {
        const custom = mod.createSyntax({ tagPrefix: "##" });
        assert.equal(custom.tagPrefix, "##");
        assert.equal(custom.tagOpen, mod.DEFAULT_SYNTAX.tagOpen);
      },
    },
    {
      name: `[${label}] depthLimit 选项`,
      run: () => {
        const tokens = mod.parseRichText("$$bold($$bold($$bold(deep)$$)$$)$$", {
          handlers: testHandlers,
          depthLimit: 1,
        });
        assert.deepEqual(normalize(tokens), [
          {
            type: "bold",
            value: [{ type: "text", value: "$$bold($$bold(deep)$$)$$" }],
          },
        ]);
      },
    },
    {
      name: `[${label}] allowForms 与 helper 导出联动`,
      run: () => {
        const handlers = {
          ...mod.createSimpleInlineHandlers(["bold"]),
          ...mod.createSimpleBlockHandlers(["info"]),
          ...mod.createSimpleRawHandlers(["code"]),
          ...mod.createPassthroughTags(["pass"]),
        };
        const tokens = mod.parseRichText(
          "$$bold(x)$$\n$$info(T)*\nA\n*end$$\n$$code(ts)%\n1\n%end$$\n$$pass(y)$$",
          {
            handlers,
            allowForms: ["inline"],
          },
        );
        assert.deepEqual(normalize(tokens), [
          { type: "bold", value: [{ type: "text", value: "x" }] },
          { type: "text", value: "\n$$info(T)*\nA\n*end$$\n$$code(ts)%\n1\n%end$$\n" },
          { type: "pass", value: [{ type: "text", value: "y" }] },
        ]);
      },
    },
  ];
};

const cases = [
  ...smokeTest(esm, "ESM"),
  ...smokeTest(cjs, "CJS"),
];

await runGoldenCases("Dist Smoke", " Dist smoke case", cases);
