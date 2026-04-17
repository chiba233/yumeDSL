// noinspection DuplicatedCode

import assert from "node:assert/strict";
import {
  createParser,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  createSyntax,
  createTextToken,
  createToken,
  materializeTextTokens,
  parsePipeArgs,
  parsePipeTextArgs,
  parsePipeTextList,
  parseRichText,
  parseStructural,
  readEscapedSequence,
  unescapeInline,
  withSyntax,
} from "../src/index.ts";
import { withTagNameConfig } from "../src/index.ts";
import type { DslContext, StructuralNode, TagHandler, TextToken } from "../src/types/index.ts";
import { runGoldenCases } from "./testHarness.ts";

const normalizeTokens = (tokens: TextToken[]): unknown[] =>
  tokens.map((token) => {
    const { id: _id, value, position: _position, ...rest } = token;
    return {
      ...rest,
      value: typeof value === "string" ? value : normalizeTokens(value),
    };
  });

const normalizeStructuralNodes = (nodes: StructuralNode[]): unknown[] =>
  nodes.map((node) => {
    switch (node.type) {
      case "text":
        return { type: "text", value: node.value };
      case "escape":
        return { type: "escape", raw: node.raw };
      case "separator":
        return { type: "separator" };
      case "inline":
        return {
          type: "inline",
          tag: node.tag,
          children: normalizeStructuralNodes(node.children),
        };
      case "raw":
        return {
          type: "raw",
          tag: node.tag,
          args: normalizeStructuralNodes(node.args),
          content: node.content,
        };
      case "block":
        return {
          type: "block",
          tag: node.tag,
          args: normalizeStructuralNodes(node.args),
          children: normalizeStructuralNodes(node.children),
        };
    }
  });

const compatSyntax = createSyntax({
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

const explicitHandlers: Record<string, TagHandler> = {
  link: {
    inline: (tokens, ctx) => {
      const args = parsePipeArgs(tokens, ctx);
      return {
        type: "link",
        url: args.text(0),
        value: args.materializedTailTokens(1),
      };
    },
  },
  note: {
    raw: (arg, content, ctx) => {
      const args = parsePipeTextArgs(arg ?? "", ctx);
      return {
        type: "note",
        title: args.text(0),
        value: [createToken({ type: "text", value: unescapeInline(content, ctx) }, undefined, ctx)],
      };
    },
  },
  box: {
    block: (arg, content, ctx) => ({
      type: "box",
      title: parsePipeTextList(arg ?? "", ctx)[0] ?? "",
      value: materializeTextTokens(content, ctx),
    }),
  },
};

const legacyHandlers: Record<string, TagHandler> = {
  link: {
    inline: (tokens) => {
      const args = parsePipeArgs(tokens);
      return {
        type: "link",
        url: args.text(0),
        value: args.materializedTailTokens(1),
      };
    },
  },
  note: {
    raw: (arg, content) => {
      const args = parsePipeTextArgs(arg ?? "");
      return {
        type: "note",
        title: args.text(0),
        value: [createToken({ type: "text", value: unescapeInline(content) })],
      };
    },
  },
  box: {
    block: (arg, content) => ({
      type: "box",
      title: parsePipeTextList(arg ?? "")[0] ?? "",
      value: materializeTextTokens(content),
    }),
  },
};

const cases = [
  {
    name: "[Compat/Explicit] 显式 DslContext utility 调用 -> 应当按自定义 syntax 与 createId 生效",
    run: () => {
      let seed = 0;
      const ctx: DslContext = {
        syntax: compatSyntax,
        createId: (draft) => `ctx-${draft.type}-${seed++}`,
      };

      const args = parsePipeTextArgs("ts || Demo || Label", ctx);
      assert.equal(args.has(0), true);
      assert.equal(args.has(3), false);
      assert.deepEqual(args.parts.map((_, index) => args.text(index)), ["ts", "Demo", "Label"]);
      assert.equal(args.text(5, "fallback"), "fallback");
      assert.deepEqual(normalizeTokens(args.materializedTokens(5, [createTextToken("fallback", ctx)])), [
        { type: "text", value: "fallback" },
      ]);
      assert.deepEqual(normalizeTokens(args.materializedTailTokens(5, [createTextToken("tail", ctx)])), [
        { type: "text", value: "tail" },
      ]);
      assert.equal(unescapeInline(String.raw`a ~|| b ~>>@@ c`, ctx), "a || b >>@@ c");
      assert.deepEqual(readEscapedSequence(String.raw`~>>@@`, 0, ctx), [">>@@", 5]);

      const freshCtx: DslContext = {
        syntax: compatSyntax,
        createId: (draft) => `fresh-${draft.type}`,
      };
      const token = createToken({ type: "text", value: "hello" }, undefined, freshCtx);
      assert.equal(token.id, "fresh-text");
      assert.equal(createTextToken("world", freshCtx).id, "fresh-text");
    },
  },
  {
    name: "[Compat/Explicit] parsePipeArgs fallback -> 空段 / 越界 / 尾段拍平都应稳定",
    run: () => {
      const args = parsePipeArgs(
        [
          createTextToken("a || ", { syntax: compatSyntax }),
          { type: "bold", value: [createTextToken("x", { syntax: compatSyntax })], id: "b1" },
          createTextToken(" || c", { syntax: compatSyntax }),
        ],
        { syntax: compatSyntax },
      );

      assert.equal(args.has(0), true);
      assert.equal(args.has(1), true);
      assert.equal(args.has(2), true);
      assert.equal(args.has(3), false);
      assert.equal(args.text(1), "x");
      assert.equal(args.text(5, "fallback"), "fallback");
      assert.deepEqual(normalizeTokens(args.materializedTokens(1)), [
        { type: "bold", value: [{ type: "text", value: "x" }] },
        { type: "text", value: " " },
      ]);
      assert.deepEqual(normalizeTokens(args.materializedTokens(6, [createTextToken("fallback")])), [
        { type: "text", value: "fallback" },
      ]);
      assert.deepEqual(normalizeTokens(args.materializedTailTokens(1)), [
        { type: "bold", value: [{ type: "text", value: "x" }] },
        { type: "text", value: " " },
        { type: "text", value: "c" },
      ]);
    },
  },
  {
    name: "[Compat/Explicit] handler 显式透传 ctx -> inline/raw/block 三种路径都应正确工作",
    run: () => {
      const tokens = parseRichText(
        "@@link<<https://a.com || click me>>@@\n@@note<<Demo>>%\nA ~|| B\n%end@@\n@@box<<Title>>*\nA @@link<<https://b.com || go>>@@\n*end@@",
        {
          handlers: explicitHandlers,
          syntax: compatSyntax,
          createId: (draft) => `exp-${draft.type}`,
        },
      );

      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "link",
          url: "https://a.com",
          value: [{ type: "text", value: "click me" }],
        },
        { type: "text", value: "\n" },
        {
          type: "note",
          title: "Demo",
          value: [{ type: "text", value: "A || B" }],
        },
        {
          type: "box",
          title: "Title",
          value: [
            { type: "text", value: "A " },
            {
              type: "link",
              url: "https://b.com",
              value: [{ type: "text", value: "go" }],
            },
          ],
        },
      ]);
    },
  },
  {
    name: "[Compat/Legacy] handler 省略 ctx -> compat wrapper 仍应提供正确 syntax/createId",
    run: () => {
      const tokens = parseRichText(
        "@@link<<https://a.com || click me>>@@\n@@note<<Demo>>%\nA ~|| B\n%end@@\n@@box<<Title>>*\nA @@link<<https://b.com || go>>@@\n*end@@",
        {
          handlers: legacyHandlers,
          syntax: compatSyntax,
          createId: (draft) => `legacy-${draft.type}`,
        },
      );

      assert.deepEqual(normalizeTokens(tokens), [
        {
          type: "link",
          url: "https://a.com",
          value: [{ type: "text", value: "click me" }],
        },
        { type: "text", value: "\n" },
        {
          type: "note",
          title: "Demo",
          value: [{ type: "text", value: "A || B" }],
        },
        {
          type: "box",
          title: "Title",
          value: [
            { type: "text", value: "A " },
            {
              type: "link",
              url: "https://b.com",
              value: [{ type: "text", value: "go" }],
            },
          ],
        },
      ]);
      assert.equal(tokens[0].id, "legacy-link");
      const noteText = Array.isArray(tokens[2]?.value) ? tokens[2].value[0] : null;
      assert.equal(noteText && typeof noteText.value === "string" ? noteText.id : null, "legacy-text");
    },
  },
  {
    name: "[Compat/Legacy] withSyntax ambient fallback -> syntax-only utility 与 structural 仍应工作",
    run: () => {
      withSyntax(compatSyntax, () => {
        assert.deepEqual(parsePipeTextList("a || b || c"), ["a", "b", "c"]);
        assert.equal(unescapeInline(String.raw`x ~|| y`), "x || y");
        assert.deepEqual(readEscapedSequence(String.raw`~>>@@`, 0), [">>@@", 5]);
        assert.deepEqual(
          normalizeStructuralNodes(parseStructural("@@link<<a || b>>@@")),
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
    name: "[Compat/Legacy] withTagNameConfig -> structural parser 应继承 ambient tagName",
    run: () => {
      withTagNameConfig(
        {
          isTagStartChar: (c) => /[a-zA-Z_0-9]/.test(c),
          isTagChar: (c) => /[a-zA-Z_0-9-]/.test(c),
        },
        () => {
          assert.deepEqual(
            normalizeStructuralNodes(parseStructural("$$1tag(ok)$$")),
            [
              {
                type: "inline",
                tag: "1tag",
                children: [{ type: "text", value: "ok" }],
              },
            ],
          );
        },
      );
    },
  },
  {
    name: "[Compat/Parser] createParser -> parse/structural 都应覆盖显式与隐式路径",
    run: () => {
      const parser = createParser({
        handlers: explicitHandlers,
        syntax: compatSyntax,
        createId: (draft) => `parser-${draft.type}`,
      });

      assert.deepEqual(
        normalizeTokens(parser.parse("@@link<<https://a.com || click>>@@")),
        [
          {
            type: "link",
            url: "https://a.com",
            value: [{ type: "text", value: "click" }],
          },
        ],
      );

      assert.deepEqual(
        normalizeStructuralNodes(parser.structural("@@link<<a || b>>@@")),
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
    },
  },
  {
    name: "[Compat/Parser] compat wrapper 结束后不应泄漏 ambient syntax/createId",
    run: () => {
      parseRichText("@@link<<https://a.com || click>>@@", {
        handlers: legacyHandlers,
        syntax: compatSyntax,
        createId: (draft) => `wrapped-${draft.type}`,
      });

      assert.equal(unescapeInline(String.raw`x ~|| y`), String.raw`x ~|| y`);

      const token = createToken({ type: "text", value: "plain" });
      assert.notEqual(token.id, "wrapped-text");
      assert.match(token.id, /^rt-\d+$/);
    },
  },
  {
    name: "[Compat/Parser] createParser.structural -> 应继承 trackPositions / tagName / syntax",
    run: () => {
      const parser = createParser({
        syntax: compatSyntax,
        trackPositions: true,
        tagName: {
          isTagStartChar: (c) => /[a-zA-Z_0-9]/.test(c),
        },
      });

      const nodes = parser.structural("@@1tag<<a || b>>@@");
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      assert.deepEqual(nodes[0].position, {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 19, offset: 18 },
      });

      const inline = nodes[0] as Extract<StructuralNode, { type: "inline" }>;
      assert.deepEqual(normalizeStructuralNodes(inline.children), [
        { type: "text", value: "a " },
        { type: "separator" },
        { type: "text", value: " b" },
      ]);
      assert.deepEqual(inline.children[1]?.position, {
        start: { line: 1, column: 11, offset: 10 },
        end: { line: 1, column: 13, offset: 12 },
      });
    },
  },
  {
    name: "[Compat/Parser] createParser.structural override -> 局部关闭 trackPositions 仍应保留 syntax/tagName",
    run: () => {
      const parser = createParser({
        syntax: compatSyntax,
        trackPositions: true,
        tagName: {
          isTagStartChar: (c) => /[a-zA-Z_0-9]/.test(c),
        },
      });

      const nodes = parser.structural("@@1tag<<x || y>>@@", {
        trackPositions: false,
      });

      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      assert.equal(nodes[0].position, undefined);
      assert.deepEqual(normalizeStructuralNodes(nodes), [
        {
          type: "inline",
          tag: "1tag",
          children: [
            { type: "text", value: "x " },
            { type: "separator" },
            { type: "text", value: " y" },
          ],
        },
      ]);
    },
  },
  {
    name: "[Compat/Parser] createParser override -> 局部 syntax 覆盖后下一次调用不应污染默认值",
    run: () => {
      const parser = createParser({
        handlers: explicitHandlers,
      });

      assert.deepEqual(
        normalizeTokens(parser.parse("@@link<<https://a.com || click>>@@", { syntax: compatSyntax })),
        [
          {
            type: "link",
            url: "https://a.com",
            value: [{ type: "text", value: "click" }],
          },
        ],
      );

      assert.deepEqual(
        normalizeTokens(parser.parse("$$link(https://b.com|tap)$$")),
        [
          {
            type: "link",
            url: "https://b.com",
            value: [{ type: "text", value: "tap" }],
          },
        ],
      );
    },
  },
  {
    name: "[Compat/Parser] createParser override -> defaults.syntax 与局部 partial syntax 应深合并",
    run: () => {
      const parser = createParser({
        handlers: explicitHandlers,
        syntax: compatSyntax,
      });

      assert.deepEqual(
        normalizeTokens(
          parser.parse("@@link<<https://a.com || click>>@@", {
            syntax: { escapeChar: "\\" },
          }),
        ),
        [
          {
            type: "link",
            url: "https://a.com",
            value: [{ type: "text", value: "click" }],
          },
        ],
      );
    },
  },
  {
    name: "[Compat/Parser] createParser override -> defaults.tagName 与局部 partial tagName 应深合并",
    run: () => {
      const parser = createParser({
        handlers: {
          "bold_1": {
            inline: (tokens) => ({
              type: "bold_1",
              value: tokens,
            }),
          },
        },
        tagName: {
          isTagStartChar: (char) => /[A-Za-z]/.test(char),
          isTagChar: (char) => /[A-Za-z0-9_]/.test(char),
        },
      });

      assert.deepEqual(
        normalizeTokens(
          parser.parse("$$bold_1(x)$$", {
            tagName: {
              isTagChar: (char) => /[A-Za-z0-9_:-]/.test(char),
            },
          }),
        ),
        [
          {
            type: "bold_1",
            value: [{ type: "text", value: "x" }],
          },
        ],
      );
    },
  },
  {
    name: "[Compat/Parser] createParser override -> allowForms 局部覆盖后下一次调用不应污染默认值",
    run: () => {
      const parser = createParser({
        handlers: {
          ...createSimpleInlineHandlers(["bold"] as const),
          ...createSimpleRawHandlers(["code"] as const),
        },
      });

      assert.deepEqual(
        normalizeTokens(parser.parse("$$code(ts)%\nconst x = 1\n%end$$", { allowForms: ["inline"] })),
        [{ type: "text", value: "$$code(ts)%\nconst x = 1\n%end$$" }],
      );

      assert.deepEqual(
        normalizeTokens(parser.parse("$$code(ts)%\nconst x = 1\n%end$$")),
        [{ type: "code", arg: "ts", value: "const x = 1" }],
      );
    },
  },
];

await runGoldenCases("Context Compat", " Context compat case", cases);
