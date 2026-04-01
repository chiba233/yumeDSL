/**
 * Smoke tests against the built dist artefacts (ESM + CJS).
 * Run `npm run build` before this test.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runGoldenCases } from "./testHarness.ts";
import { testHandlers } from "./handlers.ts";
import type { DslContext, PipeArgs, TextToken, TokenDraft } from "../src/index.ts";

// ── Load both module formats ──

const esm = await import("yume-dsl-rich-text");

const require = createRequire(import.meta.url);
const cjs = require("yume-dsl-rich-text");

// ── helpers ──

type DistModule = typeof esm;

const smokeTest = (mod: DistModule, label: string) => {
  const parse = (text: string) => mod.parseRichText(text, { handlers: testHandlers });

  const strip = (text: string) => mod.stripRichText(text, { handlers: testHandlers });

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
        assert.equal(typeof mod.createTextToken, "function");
        assert.equal(typeof mod.materializeTextTokens, "function");
        assert.equal(typeof mod.splitTokensByPipe, "function");
        assert.equal(typeof mod.parsePipeArgs, "function");
        assert.equal(typeof mod.parsePipeTextArgs, "function");
        assert.equal(typeof mod.parsePipeTextList, "function");
        assert.equal(typeof mod.unescapeInline, "function");
        assert.equal(typeof mod.readEscapedSequence, "function");
        assert.equal(typeof mod.createToken, "function");
        assert.equal(typeof mod.resetTokenIdSeed, "function");
        assert.equal(typeof mod.createSyntax, "function");
        assert.equal(typeof mod.createTagNameConfig, "function");
        assert.equal(typeof mod.parseStructural, "function");
        assert.equal(typeof mod.withSyntax, "function");
        assert.equal(typeof mod.getSyntax, "function");
        assert.equal(typeof mod.withTagNameConfig, "function");
        assert.equal(typeof mod.createSimpleInlineHandlers, "function");
        assert.equal(typeof mod.createSimpleBlockHandlers, "function");
        assert.equal(typeof mod.createSimpleRawHandlers, "function");
        assert.equal(typeof mod.createPipeHandlers, "function");
        assert.equal(typeof mod.createPipeBlockHandlers, "function");
        assert.equal(typeof mod.createPipeRawHandlers, "function");
        assert.equal(typeof mod.createPassthroughTags, "function");
        assert.equal(typeof mod.declareMultilineTags, "function");
        assert.equal(typeof mod.createEasyStableId, "function");
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
            value: "const x = 1",
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
            value: [{ type: "text", value: "content" }],
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
    {
      name: `[${label}] parseRichText 默认 id 按每次解析重置`,
      run: () => {
        const first = mod.parseRichText("hello", { handlers: testHandlers });
        const second = mod.parseRichText("world", { handlers: testHandlers });
        assert.equal(first[0].id, "rt-0");
        assert.equal(second[0].id, "rt-0");
      },
    },
    {
      name: `[${label}] parseRichText 支持自定义 tagName`,
      run: () => {
        const tokens = mod.parseRichText("$$ui:button(hi)$$", {
          handlers: {
            "ui:button": {
              inline: (value: any) => ({ type: "ui:button", value }),
            },
          },
          tagName: mod.createTagNameConfig({
            isTagChar: (char: string) => /[A-Za-z0-9_:-]/.test(char),
          }),
        });
        assert.deepEqual(normalize(tokens), [
          { type: "ui:button", value: [{ type: "text", value: "hi" }] },
        ]);
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
      name: `[${label}] parsePipeTextList`,
      run: () => {
        assert.deepEqual(mod.parsePipeTextList(" ts | Demo | Label "), ["ts", "Demo", "Label"]);
        assert.deepEqual(mod.parsePipeTextList("a||c"), ["a", "", "c"]);
        assert.deepEqual(mod.parsePipeTextList(String.raw`a \| b | c`), ["a | b", "c"]);
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
      name: `[${label}] 显式 DslContext utility 路径`,
      run: () => {
        let seed = 0;
        const syntax = mod.createSyntax({
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
        });
        const ctx = {
          syntax,
          createId: (draft: { type: string }) => `dist-${draft.type}-${seed++}`,
        };

        const args = mod.parsePipeTextArgs("ts || Demo || Label", ctx);
        assert.equal(args.has(0), true);
        assert.equal(args.has(4), false);
        assert.deepEqual(args.parts.map((_: unknown, index: number) => args.text(index)), [
          "ts",
          "Demo",
          "Label",
        ]);
        assert.equal(args.text(4, "fallback"), "fallback");
        assert.deepEqual(
          normalize(args.materializedTokens(4, [mod.createTextToken("fallback", ctx)])),
          [{ type: "text", value: "fallback" }],
        );
        assert.equal(mod.unescapeInline(String.raw`a ~|| b ~>>@@`, ctx), "a || b >>@@");
        assert.deepEqual(mod.readEscapedSequence(String.raw`~>>@@`, 0, ctx), [">>@@", 5]);
        const freshCtx = {
          syntax,
          createId: (draft: { type: string }) => `fresh-${draft.type}`,
        };
        assert.equal(mod.createToken({ type: "text", value: "x" }, undefined, freshCtx).id, "fresh-text");
        assert.equal(mod.createTextToken("x", freshCtx).id, "fresh-text");
      },
    },
    {
      name: `[${label}] legacy compat handler 路径`,
      run: () => {
        const tokens = mod.parseRichText("@@link<<https://a.com || click>>@@", {
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
          createId: () => "legacy-id",
          handlers: {
            link: {
              inline: (tokens: TextToken[]): TokenDraft => {
                const args = mod.parsePipeArgs(tokens);
                return {
                  type: "link",
                  url: args.text(0),
                  value: args.materializedTailTokens(1),
                };
              },
            },
          },
        });
        assert.deepEqual(normalize(tokens), [
          {
            type: "link",
            url: "https://a.com",
            value: [{ type: "text", value: "click" }],
          },
        ]);
        assert.equal(tokens[0].id, "legacy-id");
      },
    },
    {
      name: `[${label}] withSyntax + parseStructural legacy 闭包路径`,
      run: () => {
        const syntax = mod.createSyntax({
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
        });
        mod.withSyntax(syntax, () => {
          assert.deepEqual(
            mod.parsePipeTextList("a || b || c"),
            ["a", "b", "c"],
          );
          assert.deepEqual(
            mod.parseStructural("@@link<<a || b>>@@"),
            [
              {
                type: "inline",
                tag: "link",
                children: [
                  { type: "text", value: "a " },
                  { type: "separator" },
                  { type: "text", value: " b" },
                ],
              },
            ],
          );
        });
      },
    },
    {
      name: `[${label}] parseRichText 支持自定义 createId`,
      run: () => {
        let i = 0;
        const tokens = mod.parseRichText("$$bold(hi)$$", {
          handlers: testHandlers,
          createId: () => `custom-${i++}`,
        });
        assert.equal(tokens[0].id, "custom-1");
        const child = Array.isArray(tokens[0].value) ? tokens[0].value[0] : null;
        assert.equal(child?.id, "custom-0");
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
    {
      name: `[${label}] allowForms 只允许 inline 时被过滤掉的 block/raw-only 标签保留原文`,
      run: () => {
        const handlers = {
          ...mod.createSimpleBlockHandlers(["info"]),
          ...mod.createSimpleRawHandlers(["code"]),
        };
        const tokens = mod.parseRichText("$$info(x)$$ $$code(ts)$$", {
          handlers,
          allowForms: ["inline"],
        });
        assert.deepEqual(normalize(tokens), [{ type: "text", value: "$$info(x)$$ $$code(ts)$$" }]);
      },
    },
    {
      name: `[${label}] block/raw-only helper 不接受 inline 语法`,
      run: () => {
        const handlers = {
          ...mod.createSimpleBlockHandlers(["info"]),
          ...mod.createSimpleRawHandlers(["code"]),
        };
        const tokens = mod.parseRichText("$$info(x)$$ $$code(ts)$$", { handlers });
        assert.deepEqual(normalize(tokens), [{ type: "text", value: "$$info(x)$$ $$code(ts)$$" }]);
      },
    },
    {
      name: `[${label}] allowForms 禁用 inline 时 unknown 标签保留原文`,
      run: () => {
        const tokens = mod.parseRichText("$$unknown(x)$$", {
          handlers: {},
          allowForms: ["raw", "block"],
        });
        assert.deepEqual(normalize(tokens), [{ type: "text", value: "$$unknown(x)$$" }]);
      },
    },
    {
      name: `[${label}] createPipeHandlers 导出联动`,
      run: () => {
        const handlers = mod.createPipeHandlers({
          link: {
            inline: (args: PipeArgs): TokenDraft => ({
              type: "link",
              url: args.text(0),
              value: args.materializedTailTokens(1),
            }),
          },
          panel: {
            block: (
              args: PipeArgs,
              content: TextToken[],
              _ctx: DslContext | undefined,
              rawArg?: string,
            ): TokenDraft => ({
              type: "panel",
              arg: rawArg,
              args: args.parts.map((_, i) => args.text(i)),
              value: content,
            }),
          },
        });
        const tokens = mod.parseRichText(
          "$$link(https://a.com | click)$$\n$$panel(a | b)*\nbody\n*end$$",
          { handlers },
        );
        assert.deepEqual(normalize(tokens), [
          {
            type: "link",
            url: "https://a.com",
            value: [{ type: "text", value: "click" }],
          },
          { type: "text", value: "\n" },
          {
            type: "panel",
            arg: "a | b",
            args: ["a", "b"],
            value: [{ type: "text", value: "body" }],
          },
        ]);
      },
    },
    {
      name: `[${label}] pipe block/raw helper 导出联动`,
      run: () => {
        const handlers = {
          ...mod.createPipeBlockHandlers(["panel"]),
          ...mod.createPipeRawHandlers(["code"]),
        };
        const tokens = mod.parseRichText(
          "$$panel(a | b)*\nbody\n*end$$\n$$code(ts | demo)%\n1\n%end$$",
          { handlers },
        );
        assert.deepEqual(normalize(tokens), [
          {
            type: "panel",
            arg: "a | b",
            args: ["a", "b"],
            value: [{ type: "text", value: "body" }],
          },
          {
            type: "code",
            arg: "ts | demo",
            args: ["ts", "demo"],
            value: "1",
          },
        ]);
      },
    },
  ];
};

const cases = [...smokeTest(esm, "ESM"), ...smokeTest(cjs, "CJS")];

await runGoldenCases("Dist Smoke", " Dist smoke case", cases);
