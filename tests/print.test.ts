import assert from "node:assert/strict";
import { parseStructural, printStructural, createParser } from "../src/index.ts";
import type { StructuralNode } from "../src/types.ts";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";

// ── Round-trip helper ──

const roundTrip = (input: string, label?: string) => {
  const tree = parseStructural(input);
  const output = printStructural(tree);
  assert.equal(output, input, label ?? `round-trip failed for: ${input}`);
};

// ── Cases ──

const cases: GoldenCase[] = [
  {
    name: "printStructural: empty array produces empty string",
    run: () => {
      assert.equal(printStructural([]), "");
    },
  },
  {
    name: "printStructural: plain text round-trips",
    run: () => {
      roundTrip("hello world");
    },
  },
  {
    name: "printStructural: inline tag round-trips",
    run: () => {
      roundTrip("$$bold(text)$$");
    },
  },
  {
    name: "printStructural: nested inline tags round-trip",
    run: () => {
      roundTrip("$$bold(hello $$italic(world)$$)$$");
    },
  },
  {
    name: "printStructural: raw tag round-trips",
    run: () => {
      roundTrip("$$code(js)%\nconst x = 1;\n%end$$");
    },
  },
  {
    name: "printStructural: block tag round-trips",
    run: () => {
      roundTrip("$$div(class)*\ncontent\n*end$$");
    },
  },
  {
    name: "printStructural: block with nested children round-trips",
    run: () => {
      roundTrip("$$section()*\n$$bold(hello)$$ world\n*end$$");
    },
  },
  {
    name: "printStructural: escape sequences round-trip",
    run: () => {
      roundTrip("hello \\)$$ world");
    },
  },
  {
    name: "printStructural: separator in args round-trips",
    run: () => {
      roundTrip("$$tag(a|b|c)$$");
    },
  },
  {
    name: "printStructural: mixed content round-trips",
    run: () => {
      roundTrip("before $$bold(hello $$italic(world)$$)$$ middle $$code(lang)%\nx = 1\n%end$$ after");
    },
  },
  {
    name: "printStructural: mixed hand-built tree prints each node kind exactly once",
    run: () => {
      const tree: StructuralNode[] = [
        { type: "text", value: "A" },
        { type: "escape", raw: "\\)$$" },
        { type: "separator" },
        { type: "inline", tag: "b", children: [{ type: "text", value: "B" }] },
        { type: "raw", tag: "code", args: [{ type: "text", value: "js" }], content: "C" },
        { type: "block", tag: "box", args: [], children: [{ type: "text", value: "D" }] },
      ];

      assert.equal(
        printStructural(tree),
        "A\\)$$|$$b(B)$$$$code(js)%C%end$$$$box()*D*end$$",
      );
    },
  },
  {
    name: "printStructural: multiline block round-trips",
    run: () => {
      roundTrip("$$div()*\nline 1\nline 2\n*end$$");
    },
  },
  {
    name: "printStructural: raw with no args round-trips",
    run: () => {
      roundTrip("$$code()%\ncontent\n%end$$");
    },
  },
  {
    name: "printStructural: custom syntax round-trips",
    run: () => {
      const syntax = { tagPrefix: "@@", tagOpen: "[", tagClose: "]", tagDivider: ";", endTag: "]@@", rawOpen: "]%", blockOpen: "]*", rawClose: "%end@@", blockClose: "*end@@", escapeChar: "~" };
      const input = "@@bold[text]@@";
      const tree = parseStructural(input, { syntax });
      assert.equal(tree.length, 1);
      assert.equal(tree[0].type, "inline");
      assert.equal((tree[0] as { tag: string }).tag, "bold");
      assert.deepEqual((tree[0] as { children: StructuralNode[] }).children, [{ type: "text", value: "text" }]);
      const output = printStructural(tree, { syntax });
      assert.equal(output, input);
    },
  },
  {
    name: "printStructural: hand-built tree serializes correctly",
    run: () => {
      const tree: StructuralNode[] = [
        { type: "text", value: "hello " },
        {
          type: "inline",
          tag: "bold",
          children: [{ type: "text", value: "world" }],
        },
      ];
      assert.equal(printStructural(tree), "hello $$bold(world)$$");
    },
  },
  {
    name: "printStructural: hand-built raw node serializes correctly",
    run: () => {
      const tree: StructuralNode[] = [
        {
          type: "raw",
          tag: "code",
          args: [{ type: "text", value: "js" }],
          content: "\nconst x = 1;\n",
        },
      ];
      assert.equal(printStructural(tree), "$$code(js)%\nconst x = 1;\n%end$$");
    },
  },
  {
    name: "printStructural: hand-built block node serializes correctly",
    run: () => {
      const tree: StructuralNode[] = [
        {
          type: "block",
          tag: "div",
          args: [],
          children: [{ type: "text", value: "\ncontent\n" }],
        },
      ];
      assert.equal(printStructural(tree), "$$div()*\ncontent\n*end$$");
    },
  },
  {
    name: "printStructural: escape node serializes raw field",
    run: () => {
      const tree: StructuralNode[] = [
        { type: "text", value: "before " },
        { type: "escape", raw: "\\)$$" },
        { type: "text", value: " after" },
      ];
      assert.equal(printStructural(tree), "before \\)$$ after");
    },
  },
  {
    name: "printStructural: separator node serializes as tagDivider",
    run: () => {
      const tree: StructuralNode[] = [
        { type: "text", value: "a" },
        { type: "separator" },
        { type: "text", value: "b" },
      ];
      assert.equal(printStructural(tree), "a|b");
    },
  },

  {
    name: "printStructural: unsupported forms print full syntax (no lossy gating)",
    run: () => {
      const tree: StructuralNode[] = [
        {
          type: "block",
          tag: "div",
          args: [],
          children: [{ type: "text", value: "hello" }],
        },
      ];
      // No gating in printer — full tag syntax always preserved
      assert.equal(printStructural(tree), "$$div()*hello*end$$");
    },
  },
  {
    name: "printStructural: createParser.print inherits syntax",
    run: () => {
      const dsl = createParser({
        syntax: { tagPrefix: "@@", tagOpen: "[", tagClose: "]", tagDivider: ";", endTag: "]@@", rawOpen: "]%", blockOpen: "]*", rawClose: "%end@@", blockClose: "*end@@", escapeChar: "~" },
      });
      const tree: StructuralNode[] = [
        { type: "inline", tag: "bold", children: [{ type: "text", value: "ok" }] },
      ];
      assert.equal(dsl.print(tree), "@@bold[ok]@@");
    },
  },
  {
    name: "printStructural: createParser.print per-call override merges with defaults",
    run: () => {
      // defaults: @@…]@@  syntax
      const dsl = createParser({
        syntax: { tagPrefix: "@@", tagOpen: "[", tagClose: "]", tagDivider: ";", endTag: "]@@", rawOpen: "]%", blockOpen: "]*", rawClose: "%end@@", blockClose: "*end@@", escapeChar: "~" },
      });
      const tree: StructuralNode[] = [
        { type: "inline", tag: "bold", children: [{ type: "text", value: "ok" }] },
      ];

      // override only tagPrefix → endTag 等 compound 保持 defaults 的值（不重新派生），
      // 所以必须连同 endTag 一起显式传才能 round-trip。
      // 这里测的是：override 的 tagPrefix 和 endTag 确实被采纳，而其他字段仍继承 defaults。
      assert.equal(
        dsl.print(tree, { syntax: { tagPrefix: "%%", endTag: "]%%" } }),
        "%%bold[ok]%%",
      );

      // 不带 override 应当仍用 defaults
      assert.equal(dsl.print(tree), "@@bold[ok]@@");
    },
  },
];

await runGoldenCases("Print", "print case", cases);
