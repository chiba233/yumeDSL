/**
 * Tests for opt-in source position tracking (`trackPositions: true`).
 */
import assert from "node:assert/strict";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";
import type { SourceSpan, StructuralNode, TextToken } from "../src/types/index.ts";
import { createParser, createSyntax } from "../src/index.ts";
import { parseRichText } from "../src/core/parse.ts";
import { parseStructural } from "../src/index.ts";
import { buildPositionTracker } from "../src/index.ts";
import { testHandlers } from "./handlers.ts";

const parse = (text: string) =>
  parseRichText(text, { handlers: testHandlers, trackPositions: true });

const parseNoPos = (text: string) =>
  parseRichText(text, { handlers: testHandlers });

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

const position = (
  sl: number, sc: number, so: number,
  el: number, ec: number, eo: number,
): SourceSpan => ({
  start: { line: sl, column: sc, offset: so },
  end: { line: el, column: ec, offset: eo },
});

const cases: GoldenCase[] = [
  // ── Disabled by default ──
  {
    name: "[Position/Off] 默认不追踪 -> token 不应包含 position 属性",
    run() {
      const tokens = parseNoPos("hello");
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].position, undefined);
    },
  },

  // ── Plain text ──
  {
    name: "[Position/Text] 纯文本 -> 应当覆盖完整范围",
    run() {
      const tokens = parse("hello");
      assert.equal(tokens.length, 1);
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 1, 6, 5));
    },
  },

  // ── Multiline text ──
  {
    name: "[Position/Text] 多行文本 -> 应当正确计算行列号",
    run() {
      const tokens = parse("ab\ncd");
      assert.equal(tokens.length, 1);
      // "ab\ncd" = 5 chars, starts at (1,1,0), ends at (2,3,5)
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 2, 3, 5));
    },
  },
  {
    name: "[Position/Text] CRLF 文本 -> line/column 应按 LF 分行且 offset 保持原始宽度",
    run() {
      const tokens = parse("ab\r\ncd");
      assert.equal(tokens.length, 1);
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 2, 3, 6));
    },
  },

  // ── Inline tag ──
  {
    name: "[Position/Inline] 基础 inline 标签 -> position 应覆盖整个标签语法",
    run() {
      // "$$bold(hi)$$" = 12 chars
      const tokens = parse("$$bold(hi)$$");
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "bold");
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 1, 13, 12));
    },
  },

  // ── Text + inline tag ──
  {
    name: "[Position/Mixed] 文本 + inline 标签 -> 每个 token 有独立 position",
    run() {
      // "ab$$bold(cd)$$ef"
      //  01 234567890123 4567
      //  text "ab" = [0,2), bold = [2,14), text "ef" = [14,16)
      const tokens = parse("ab$$bold(cd)$$ef");
      assert.equal(tokens.length, 3);
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 1, 3, 2));
      assert.deepEqual(tokens[1].position, position(1, 3, 2, 1, 15, 14));
      assert.deepEqual(tokens[2].position, position(1, 15, 14, 1, 17, 16));
    },
  },

  // ── Nested inline ──
  {
    name: "[Position/Nested] 嵌套 inline -> 外层和内层均有正确 position",
    run() {
      // "$$bold(a$$code(b)$$c)$$"
      //  0123456789...
      const text = "$$bold(a$$code(b)$$c)$$";
      const tokens = parse(text);
      assert.equal(tokens.length, 1);
      const bold = tokens[0];
      assert.equal(bold.type, "bold");
      assert.deepEqual(bold.position, position(1, 1, 0, 1, text.length + 1, text.length));

      // Inner children of bold
      const children = bold.value as TextToken[];
      assert.equal(children.length, 3); // "a", code("b"), "c"
      // $$code(b)$$ at offset 8..19
      // "$$code(" = 8-14, "b" = 15, ")$$" = 16-18, end = 19
      const codeToken = children[1];
      assert.equal(codeToken.type, "code");
      assert.deepEqual(codeToken.position, position(1, 9, 8, 1, 20, 19));
    },
  },

  // ── Raw tag ──
  {
    name: "[Position/Raw] raw 标签 -> position 覆盖从 $$ 到 %end$$",
    run() {
      const text = "$$raw-code(ts)%\nconst x = 1\n%end$$";
      const tokens = parse(text);
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "raw-code");
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 3, 7, text.length));
    },
  },

  {
    name: "[Position/Raw] raw 归一化换行 -> token position.end 应覆盖被消费的 trailing newline",
    run() {
      const text = "$$raw-code(ts)%\nconst x = 1\n%end$$\nnext";
      const tokens = parse(text);
      assert.equal(tokens.length, 2);
      assert.equal(tokens[0].type, "raw-code");
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 4, 1, 35));
      assert.equal(tokens[1].type, "text");
      assert.deepEqual(tokens[1].position, position(4, 1, 35, 4, 5, 39));
    },
  },

  // ── Block tag ──
  {
    name: "[Position/Block] block 标签 -> position 覆盖从 $$ 到 *end$$",
    run() {
      // $$info()*\nhello\n*end$$
      const text = "$$info()*\nhello\n*end$$";
      const tokens = parse(text);
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "info");
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 3, 7, text.length));
    },
  },

  {
    name: "[Position/Block] block 归一化换行 -> token position.end 应覆盖被消费的 trailing newline",
    run() {
      const text = "$$info()*\nhello\n*end$$\nnext";
      const tokens = parse(text);
      assert.equal(tokens.length, 2);
      assert.equal(tokens[0].type, "info");
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 4, 1, 23));
      assert.equal(tokens[1].type, "text");
      assert.deepEqual(tokens[1].position, position(4, 1, 23, 4, 5, 27));
    },
  },

  // ── Block tag with nested content positions ──
  {
    name: "[Position/Block] block 内嵌套 inline -> 内部 token 位置映射回原始文本",
    run() {
      // $$info()*\n$$bold(x)$$\n*end$$
      const text = "$$info()*\n$$bold(x)$$\n*end$$";
      const tokens = parse(text);
      assert.equal(tokens.length, 1);
      const info = tokens[0];
      assert.equal(info.type, "info");

      const children = info.value as TextToken[];
      const boldToken = children.find(t => t.type === "bold");
      assert.ok(boldToken);
      // After leading \n strip, block content is "$$bold(x)$$\n"
      // innerBaseOffset = contentStart(9) + stripCount(1) = 10
      // bold: offset 0 in substring → 10 in original, end 11 → 21
      assert.ok(boldToken.position);
      assert.equal(boldToken.position!.start.offset, 10);
      assert.equal(boldToken.position!.end.offset, 21);
    },
  },

  // ── Multiline with tag on second line ──
  {
    name: "[Position/Multiline] 第二行的标签 -> 行列号正确",
    run() {
      // "hello\n$$bold(world)$$"
      const text = "hello\n$$bold(world)$$";
      const tokens = parse(text);
      assert.equal(tokens.length, 2);
      // text "hello\n" = [0,6)
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 2, 1, 6));
      // bold at line 2, column 1, offset 6..21
      assert.equal(tokens[1].type, "bold");
      assert.deepEqual(tokens[1].position, position(2, 1, 6, 2, 16, 21));
    },
  },

  // ── Escape sequences ──
  {
    name: "[Position/Escape] 转义字符 -> 文本 token 的 position 包含转义序列",
    run() {
      // "a\\$$b" -> text "a$$b" with position covering all 5 source chars
      const text = "a\\$$b";
      const tokens = parse(text);
      assert.equal(tokens.length, 1);
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 1, 6, 5));
    },
  },

  // ── Empty input ──
  {
    name: "[Position/Empty] 空输入 -> 返回空数组",
    run() {
      const tokens = parse("");
      assert.equal(tokens.length, 0);
    },
  },

  // ── Escape: source span covers escape backslash (issue #1) ──
  {
    name: "[Position/Escape] 根级转义 -> position.end 按源码消费长度计算，不按输出文本长度",
    run() {
      // "a\*b" source = 4 chars, output text = "a*b" (3 chars)
      // position should be [0,4) not [0,3)
      const text = "a\\*b";
      const tokens = parse(text);
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "text");
      assert.deepEqual(tokens[0].position, position(1, 1, 0, 1, 5, 4));
    },
  },

  // ── Degrade: unclosed inline preserves position (issue #2) ──
  {
    name: "[Position/Degrade] 未闭合 inline 标签退化 -> 退化文本 token 仍有 position",
    run() {
      // "$$bold(hi" — unclosed → degraded to text tokens
      const text = "$$bold(hi";
      const tokens = parse(text);
      // degraded: should be text with position covering the full source
      assert.ok(tokens.length >= 1);
      const first = tokens[0];
      assert.ok(first.position, "degraded text token should have position");
      assert.equal(first.position!.start.offset, 0);
    },
  },

  // ── Structural: inline tag ──
  {
    name: "[Position/Structural] inline 标签 -> StructuralNode 有 position",
    run() {
      const text = "$$bold(hi)$$";
      const nodes = parseStructural(text, { trackPositions: true });
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      assert.deepEqual(nodes[0].position, position(1, 1, 0, 1, 13, 12));
    },
  },

  // ── Structural: disabled by default ──
  {
    name: "[Position/Structural] 默认不追踪 -> StructuralNode 不应包含 position",
    run() {
      const nodes = parseStructural("hello");
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].position, undefined);
    },
  },

  // ── Structural: text + escape ──
  {
    name: "[Position/Structural] text + escape 节点 -> 各有正确 position",
    run() {
      // "ab\)c" = text "ab" + escape "\)" + text "c"
      const text = "ab\\)c";
      const nodes = parseStructural(text, { trackPositions: true });
      assert.equal(nodes.length, 3);
      assert.equal(nodes[0].type, "text");
      assert.deepEqual(nodes[0].position, position(1, 1, 0, 1, 3, 2));
      assert.equal(nodes[1].type, "escape");
      assert.deepEqual(nodes[1].position, position(1, 3, 2, 1, 5, 4));
      assert.equal(nodes[2].type, "text");
      assert.deepEqual(nodes[2].position, position(1, 5, 4, 1, 6, 5));
    },
  },

  // ── Structural: raw tag ──
  {
    name: "[Position/Structural] raw 标签 -> position 覆盖完整 tag",
    run() {
      const text = "$$raw-code(ts)%\ncode\n%end$$";
      const nodes = parseStructural(text, { trackPositions: true });
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "raw");
      assert.deepEqual(nodes[0].position, position(1, 1, 0, 3, 7, text.length));
    },
  },

  // ── Structural: block tag ──
  {
    name: "[Position/Structural] block 标签 -> position 覆盖完整 tag",
    run() {
      const text = "$$info()*\nhello\n*end$$";
      const nodes = parseStructural(text, { trackPositions: true });
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "block");
      assert.deepEqual(nodes[0].position, position(1, 1, 0, 3, 7, text.length));
    },
  },
  {
    name: "[Position/Structural] separator 节点 -> position 应仅覆盖 divider 本身",
    run() {
      const text = "$$link(a | b)$$";
      const nodes = parseStructural(text, { trackPositions: true });
      assert.equal(nodes.length, 1);
      const inline = nodes[0] as Extract<StructuralNode, { type: "inline" }>;
      assert.equal(inline.children[1]?.type, "separator");
      assert.deepEqual(inline.children[1]?.position, position(1, 10, 9, 1, 11, 10));
    },
  },

  // ── Structural: nested children have correct offset ──
  {
    name: "[Position/Structural] block 嵌套 inline -> 子节点位置映射回原始文本",
    run() {
      // $$info()* $$bold(x)$$ *end$$
      // Block content starts after )*: " $$bold(x)$$ "
      const text = "$$info()*\n$$bold(x)$$\n*end$$";
      const nodes = parseStructural(text, { trackPositions: true });
      assert.equal(nodes.length, 1);
      const block = nodes[0];
      assert.equal(block.type, "block");

      const children = (block as { children: StructuralNode[] }).children;
      // Children are parsed from text.slice(contentStart, closeStart)
      // contentStart = 9 (after ")*"), "\n$$bold(x)$$\n" → children
      const boldNode = children.find(n => n.type === "inline");
      assert.ok(boldNode);
      // $$bold(x)$$ in original text: offset 10..21
      assert.ok(boldNode.position);
      assert.equal(boldNode.position!.start.offset, 10);
      assert.equal(boldNode.position!.end.offset, 21);
    },
  },

  {
    name: "[Position/Structural] block 子节点保持原始语法位置，前导换行仍单独占位",
    run() {
      const text = "$$info()*\n$$bold(x)$$\n*end$$";
      const nodes = parseStructural(text, { trackPositions: true });
      assert.equal(nodes.length, 1);
      const block = nodes[0] as Extract<StructuralNode, { type: "block" }>;
      assert.equal(block.children.length, 3);
      assert.equal(block.children[0].type, "text");
      assert.deepEqual(block.children[0].position, position(1, 10, 9, 2, 1, 10));
      assert.equal(block.children[1].type, "inline");
      assert.deepEqual(block.children[1].position, position(2, 1, 10, 2, 12, 21));
      assert.equal(block.children[2].type, "text");
      assert.deepEqual(block.children[2].position, position(2, 12, 21, 3, 1, 22));
    },
  },
  {
    name: "[Position/BaseOffset] parseRichText + tracker -> 切片 position 应完整回指原文",
    run() {
      const fullText = "hello\n$$bold(world)$$\nnext";
      const sliceStart = 6;
      const slice = fullText.slice(sliceStart, 21);
      const tracker = buildPositionTracker(fullText);
      const tokens = parseRichText(slice, {
        handlers: testHandlers,
        trackPositions: true,
        tracker,
        baseOffset: sliceStart,
      });

      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "bold");
      assert.deepEqual(tokens[0].position, position(2, 1, 6, 2, 16, 21));
    },
  },
  {
    name: "[Position/BaseOffset] parseRichText 仅 baseOffset -> line/column 仍按切片局部计算",
    run() {
      const fullText = "hello\n$$bold(world)$$\nnext";
      const sliceStart = 6;
      const slice = fullText.slice(sliceStart, 21);
      const tokens = parseRichText(slice, {
        handlers: testHandlers,
        trackPositions: true,
        baseOffset: sliceStart,
      });

      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "bold");
      assert.deepEqual(tokens[0].position, position(1, 1, 6, 1, 16, 21));
    },
  },
  {
    name: "[Position/BaseOffset] parseStructural + tracker -> 切片 position 应完整回指原文",
    run() {
      const fullText = "hello\n$$bold(world)$$\nnext";
      const sliceStart = 6;
      const slice = fullText.slice(sliceStart, 21);
      const tracker = buildPositionTracker(fullText);
      const nodes = parseStructural(slice, {
        trackPositions: true,
        tracker,
        baseOffset: sliceStart,
      });

      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      assert.deepEqual(nodes[0].position, position(2, 1, 6, 2, 16, 21));
    },
  },
  {
    name: "[Position/BaseOffset] parseStructural 仅 baseOffset -> line/column 仍按切片局部计算",
    run() {
      const fullText = "hello\n$$bold(world)$$\nnext";
      const sliceStart = 6;
      const slice = fullText.slice(sliceStart, 21);
      const nodes = parseStructural(slice, {
        trackPositions: true,
        baseOffset: sliceStart,
      });

      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      assert.deepEqual(nodes[0].position, position(1, 1, 6, 1, 16, 21));
    },
  },
  {
    name: "[Position/BaseOffset] parseStructural + custom syntax + tracker -> separator 子节点应完整回指原文",
    run() {
      const fullText = "pre\n@@link<<a || b>>@@\npost";
      const sliceStart = 4;
      const slice = fullText.slice(sliceStart, 22);
      const tracker = buildPositionTracker(fullText);
      const nodes = parseStructural(slice, {
        syntax: compatSyntax,
        trackPositions: true,
        tracker,
        baseOffset: sliceStart,
      });

      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      assert.deepEqual(nodes[0].position, position(2, 1, 4, 2, 19, 22));

      const inline = nodes[0] as Extract<StructuralNode, { type: "inline" }>;
      assert.equal(inline.children.length, 3);
      assert.equal(inline.children[1]?.type, "separator");
      assert.deepEqual(inline.children[1]?.position, position(2, 11, 14, 2, 13, 16));
    },
  },
  {
    name: "[Position/BaseOffset] createParser.structural -> 默认 trackPositions 与 custom syntax 应一并生效",
    run() {
      const parser = createParser({
        syntax: compatSyntax,
        trackPositions: true,
      });

      const fullText = "pre\n@@link<<a || b>>@@\npost";
      const sliceStart = 4;
      const slice = fullText.slice(sliceStart, 22);
      const tracker = buildPositionTracker(fullText);
      const nodes = parser.structural(slice, {
        tracker,
        baseOffset: sliceStart,
      });

      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      assert.deepEqual(nodes[0].position, position(2, 1, 4, 2, 19, 22));
      const inline = nodes[0] as Extract<StructuralNode, { type: "inline" }>;
      assert.deepEqual(inline.children[0]?.position, position(2, 9, 12, 2, 11, 14));
      assert.deepEqual(inline.children[1]?.position, position(2, 11, 14, 2, 13, 16));
      assert.deepEqual(inline.children[2]?.position, position(2, 13, 16, 2, 15, 18));
    },
  },
  {
    name: "[Position/Tracker] buildPositionTracker -> CRLF 行尾后的 offset 应映射到下一行",
    run() {
      const tracker = buildPositionTracker("ab\r\ncd");
      assert.deepEqual(tracker.resolve(0), { line: 1, column: 1, offset: 0 });
      assert.deepEqual(tracker.resolve(2), { line: 1, column: 3, offset: 2 });
      assert.deepEqual(tracker.resolve(3), { line: 1, column: 4, offset: 3 });
      assert.deepEqual(tracker.resolve(4), { line: 2, column: 1, offset: 4 });
      assert.deepEqual(tracker.resolve(6), { line: 2, column: 3, offset: 6 });
    },
  },
  {
    name: "[Position/BaseOffset] parseRichText + tracker + CRLF -> offset 回指原文且 line/column 取原文坐标",
    run() {
      const fullText = "head\r\n$$bold(x)$$\r\ntail";
      const sliceStart = 6;
      const slice = fullText.slice(sliceStart, 17);
      const tracker = buildPositionTracker(fullText);
      const tokens = parseRichText(slice, {
        handlers: testHandlers,
        trackPositions: true,
        tracker,
        baseOffset: sliceStart,
      });

      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "bold");
      assert.deepEqual(tokens[0].position, position(2, 1, 6, 2, 12, 17));
    },
  },
  {
    name: "[Position/Semantics] block leading newline -> render 与 structural 的子节点 start 必须不同",
    run() {
      const text = "$$info()*\nhello\n*end$$";
      const rich = parseRichText(text, { handlers: testHandlers, trackPositions: true });
      const structural = parseStructural(text, { handlers: testHandlers, trackPositions: true });

      assert.equal(rich[0]?.type, "info");
      assert.equal(structural[0]?.type, "block");

      const richChildren = rich[0]!.value as TextToken[];
      const block = structural[0] as Extract<StructuralNode, { type: "block" }>;
      assert.equal(richChildren[0]?.type, "text");
      assert.equal(block.children[0]?.type, "text");
      assert.equal(richChildren[0]?.position?.start.offset, 10);
      assert.equal(block.children[0]?.position?.start.offset, 9);
      assert.notEqual(richChildren[0]?.position?.start.offset, block.children[0]?.position?.start.offset);
    },
  },
  {
    name: "[Position/Semantics] trailing newline normalization (inline/raw/block + LF/CRLF) -> render end 应覆盖被消费换行",
    run() {
      const scenarios = [
        {
          text: "$$bold(x)$$\nbar",
          richType: "bold",
          structuralType: "inline",
          consumedLbWidth: 1,
          richOptions: { blockTags: [{ tag: "bold", forms: ["inline"] as const }] },
        },
        {
          text: "$$bold(x)$$\r\nbar",
          richType: "bold",
          structuralType: "inline",
          consumedLbWidth: 2,
          richOptions: { blockTags: [{ tag: "bold", forms: ["inline"] as const }] },
        },
        {
          text: "$$raw-code(ts)%\nconst x = 1\n%end$$\nnext",
          richType: "raw-code",
          structuralType: "raw",
          consumedLbWidth: 1,
          richOptions: {},
        },
        {
          text: "$$raw-code(ts)%\r\nconst x = 1\r\n%end$$\r\nnext",
          richType: "raw-code",
          structuralType: "raw",
          consumedLbWidth: 2,
          richOptions: {},
        },
        {
          text: "$$info()*\nhello\n*end$$\nnext",
          richType: "info",
          structuralType: "block",
          consumedLbWidth: 1,
          richOptions: {},
        },
        {
          text: "$$info()*\r\nhello\r\n*end$$\r\nnext",
          richType: "info",
          structuralType: "block",
          consumedLbWidth: 2,
          richOptions: {},
        },
      ] as const;

      for (const scenario of scenarios) {
        const rich = parseRichText(scenario.text, {
          handlers: testHandlers,
          trackPositions: true,
          ...scenario.richOptions,
        });
        const structural = parseStructural(scenario.text, {
          handlers: testHandlers,
          trackPositions: true,
        });

        assert.equal(rich[0]?.type, scenario.richType);
        assert.equal(structural[0]?.type, scenario.structuralType);
        assert.equal(rich[1]?.type, "text");
        assert.equal(
          rich[0]?.position?.end.offset,
          structural[0]?.position?.end.offset! + scenario.consumedLbWidth,
        );
        assert.equal(rich[0]?.position?.end.offset, rich[1]?.position?.start.offset);
      }
    },
  },
  {
    name: "[Position/Semantics] inline plain path -> render 与 structural 位置仍应一致",
    run() {
      const text = "$$bold(hi)$$";
      const rich = parseRichText(text, { handlers: testHandlers, trackPositions: true });
      const structural = parseStructural(text, { handlers: testHandlers, trackPositions: true });

      assert.equal(rich[0]?.type, "bold");
      assert.equal(structural[0]?.type, "inline");
      assert.deepEqual(rich[0]?.position, structural[0]?.position);
    },
  },
];

await runGoldenCases("Position Tracking", "Position tracking case", cases);
