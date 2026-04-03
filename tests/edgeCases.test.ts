/**
 * Edge-case coverage for tricky parse scenarios that have historically
 * produced subtle regressions. Each case documents the exact expected
 * output — do not adjust assertions without understanding the underlying
 * parser invariant being tested.
 */
import assert from "node:assert/strict";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";
import { parseRichText } from "../src/parse.ts";
import { parseStructural } from "../src/structural.ts";
import { testHandlers } from "./handlers.ts";

const parse = (text: string) =>
  parseRichText(text, { handlers: testHandlers, trackPositions: true });

const cases: GoldenCase[] = [
  // ── Escape vs. merge boundary ──
  {
    name: "[Edge/Escape] 转义字符合并后 position 仍按源码宽度计算",
    run() {
      // "x\)y" → output "x)y" (3 chars), but source consumed 4 chars
      // AI may "fix" end offset to 3 — that would be wrong
      const tokens = parse("x\\)y");
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "text");
      assert.equal(tokens[0].value, "x)y");
      assert.equal(tokens[0].position!.end.offset, 4);
    },
  },
  {
    name: "[Edge/Escape] 连续转义 -> 每个转义消费 2 源码字符",
    run() {
      // "\(\)" → output "()" (2 chars), source = 4 chars
      const tokens = parse("\\(\\)");
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].value, "()");
      assert.equal(tokens[0].position!.start.offset, 0);
      assert.equal(tokens[0].position!.end.offset, 4);
    },
  },

  // ── Unclosed tag degradation ──
  {
    name: "[Edge/Degrade] 未闭合标签退化为文本 -> 保留原始语法字符",
    run() {
      // "$$bold(oops" → no close → degrades to text tokens
      // The opening "$$bold(" must appear verbatim in the output text
      const tokens = parse("$$bold(oops");
      const text = tokens.map(t =>
        typeof t.value === "string" ? t.value : "",
      ).join("");
      assert.ok(text.includes("$$bold("), `degraded text should contain opening syntax, got: ${text}`);
    },
  },
  {
    name: "[Edge/Degrade] 退化后的 token 数量不应为 0",
    run() {
      const tokens = parse("$$unknown(hello");
      assert.ok(tokens.length > 0, "degraded parse should produce at least one token");
    },
  },

  // ── Empty and minimal inputs ──
  {
    name: "[Edge/Empty] 空字符串 -> 返回空数组而非含空 token 的数组",
    run() {
      // AI might think "empty input should produce one empty text token"
      const tokens = parse("");
      assert.equal(tokens.length, 0);
    },
  },
  {
    name: "[Edge/Minimal] 仅转义字符 -> 单个文本 token",
    run() {
      // "\\" → escaped backslash, output "\" (1 char), source = 2 chars
      const tokens = parse("\\\\");
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "text");
      assert.equal(tokens[0].value, "\\");
      // source is 2 chars, output is 1 char
      assert.equal(tokens[0].position!.end.offset, 2);
    },
  },

  // ── Inline close consumed exactly ──
  {
    name: "[Edge/Close] inline 闭合后紧跟文本 -> 文本从闭合标签结尾开始",
    run() {
      // "$$bold(a)$$bc" → bold token ends at 11, text "bc" starts at 11
      const tokens = parse("$$bold(a)$$bc");
      assert.equal(tokens.length, 2);
      assert.equal(tokens[0].type, "bold");
      assert.equal(tokens[0].position!.end.offset, 11);
      assert.equal(tokens[1].type, "text");
      assert.equal(tokens[1].value, "bc");
      assert.equal(tokens[1].position!.start.offset, 11);
    },
  },

  // ── Structural parse edge cases ──
  {
    name: "[Edge/Structural] 不带 handler 的 structural parse 接受所有标签",
    run() {
      // parseStructural without handlers accepts everything —
      // AI may assume it needs handlers and "fix" this test
      const nodes = parseStructural("$$anything(content)$$");
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
    },
  },
  {
    name: "[Edge/Structural] 纯文本输入 -> 单个 text 节点而非空数组",
    run() {
      const nodes = parseStructural("hello world");
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "text");
      // AI might expect value to be ["hello", "world"] or similar
      assert.equal((nodes[0] as { value: string }).value, "hello world");
    },
  },

  // ── Trailing newline after block/raw (v1.0.7 regression area) ──
  {
    name: "[Edge/Newline] inline 关闭不应吞后续换行",
    run() {
      // This is the exact bug that v1.0.7 fixed.
      // "$$bold(x)$$\ny" → bold ends at 11, NOT 12
      const tokens = parse("$$bold(x)$$\ny");
      assert.equal(tokens.length, 2);
      assert.equal(tokens[0].type, "bold");
      assert.equal(tokens[0].position!.end.offset, 11);
      assert.equal(tokens[1].type, "text");
      assert.equal(tokens[1].value, "\ny");
    },
  },

  // ── Nested depth boundary ──
  {
    name: "[Edge/Depth] 达到深度限制时内层标签退化为文本",
    run() {
      // depthLimit: 1 means only root-level tags parse; inner tags degrade
      const tokens = parseRichText("$$bold($$code(x)$$)$$", {
        handlers: testHandlers,
        depthLimit: 1,
      });
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].type, "bold");
      // Inner content should contain the raw "$$code(x)$$" as text, not a parsed code token
      const inner = tokens[0].value;
      assert.ok(Array.isArray(inner));
      const innerText = inner.filter(t => t.type === "text").map(t => t.value).join("");
      assert.ok(innerText.includes("$$code("), `inner should contain raw syntax, got: ${innerText}`);
    },
  },
];

await runGoldenCases("Edge Cases", "Edge case", cases, { quietPasses: true });
