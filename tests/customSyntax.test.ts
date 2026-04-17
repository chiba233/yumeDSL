/**
 * Custom-syntax guard tests.
 *
 * When users define their own syntax tokens via `createSyntax`, token prefixes
 * can overlap in ways the default config never encounters. These tests lock
 * the invariant:
 *
 *   "Non-inline endTag handling must consume only `tagClose`; `tagPrefix` is
 *    always left for the next iteration, regardless of what follows."
 *
 * Each case constructs a syntax where `tagPrefix` overlaps with the start of
 * another structural token and verifies the parser does not mis-consume.
 */
import assert from "node:assert/strict";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";
import type { ParseError } from "../src/types/index.ts";
import {
  parseRichText,
  createSyntax,
  materializeTextTokens,
} from "../src/index.ts";

// ── Helpers ──

const collectErrors = () => {
  const errors: ParseError[] = [];
  const onError = (e: ParseError) => errors.push(e);
  return { errors, onError };
};

// ── rawClose starts with tagPrefix ──

const rawPrefixSyntax = createSyntax({
  tagPrefix: "$$",
  tagOpen: "(",
  tagClose: ")",
  endTag: ")$$",
  rawOpen: ")%",
  rawClose: "$$end%%",
  blockOpen: ")*",
  blockClose: "*end$$",
  tagDivider: "|",
  escapeChar: "\\",
});

// ── blockClose starts with tagPrefix ──

const blockPrefixSyntax = createSyntax({
  tagPrefix: "$$",
  tagOpen: "(",
  tagClose: ")",
  endTag: ")$$",
  rawOpen: ")%",
  rawClose: "%end$$",
  blockOpen: ")*",
  blockClose: "$$end**",
  tagDivider: "|",
  escapeChar: "\\",
});

// ── both rawClose and blockClose start with tagPrefix ──

const bothPrefixSyntax = createSyntax({
  tagPrefix: "$$",
  tagOpen: "(",
  tagClose: ")",
  endTag: ")$$",
  rawOpen: ")%",
  rawClose: "$$end%%",
  blockOpen: ")*",
  blockClose: "$$end**",
  tagDivider: "|",
  escapeChar: "\\",
});

const cases: GoldenCase[] = [
  // ── rawClose 以 tagPrefix 开头：root 级别 )$$ 后紧跟 rawClose 残余 ──
  // rawClose = "$$end%%"，独占一行。
  // 在 root 上下文中 ) 出现在 rawClose 行之前的行尾，
  // 扫描器不应把 ) 后的 $$ 吞掉从而破坏下一行的 rawClose 识别。
  {
    name: "[CustomSyntax/RawClose] rawClose 以 $$ 开头 -> raw tag 正确闭合",
    run() {
      // raw 内容行末有 )，rawClose 独占下一行
      const input = "$$code(js)%\nconsole.log(1)\n$$end%%";
      const { errors, onError } = collectErrors();
      const tokens = parseRichText(input, {
        syntax: rawPrefixSyntax,
        handlers: {
          code: { raw: (arg, content) => ({ type: "code", value: content, language: arg }) },
        },
        onError,
      });

      assert.equal(errors.length, 0, `expected no errors, got: ${errors.map(e => e.code).join(", ")}`);
      const flat = materializeTextTokens(tokens);
      assert.equal(flat.length, 1);
      assert.equal(flat[0]?.type, "code");
    },
  },
  {
    name: "[CustomSyntax/RawClose] rawClose 以 $$ 开头 + 内容含 ) -> raw 内容完整保留",
    run() {
      // raw 内容里有 )，确认不影响 rawClose 行的识别
      const input = "$$code(js)%\nfoo(1)\n$$end%%";
      const { errors, onError } = collectErrors();
      const tokens = parseRichText(input, {
        syntax: rawPrefixSyntax,
        handlers: {
          code: { raw: (_arg, content) => ({ type: "code", value: content }) },
        },
        onError,
      });

      assert.equal(errors.length, 0, `expected no errors, got: ${errors.map(e => e.code).join(", ")}`);
      const flat = materializeTextTokens(tokens);
      assert.equal(flat[0]?.type, "code");
      assert.ok(
        (flat[0]?.value as string).includes("foo(1)"),
        `raw content should preserve ), got: ${flat[0]?.value}`,
      );
    },
  },

  // ── blockClose 以 tagPrefix 开头 ──
  {
    name: "[CustomSyntax/BlockClose] blockClose 以 $$ 开头 -> block tag 正确闭合",
    run() {
      const input = "$$note(title)*\nhello)\n$$end**";
      const { errors, onError } = collectErrors();
      const tokens = parseRichText(input, {
        syntax: blockPrefixSyntax,
        handlers: {
          note: { block: (_arg, content) => ({ type: "note", value: content }) },
        },
        onError,
      });

      assert.equal(errors.length, 0, `expected no errors, got: ${errors.map(e => e.code).join(", ")}`);
      const flat = materializeTextTokens(tokens);
      assert.equal(flat.length, 1);
      assert.equal(flat[0]?.type, "note");
    },
  },

  // ── rawClose + blockClose 都以 tagPrefix 开头 ──
  {
    name: "[CustomSyntax/Both] rawClose 和 blockClose 均以 $$ 开头 -> 均正确闭合",
    run() {
      const rawInput = "$$code(js)%\nlet x = 1\n$$end%%";
      const blockInput = "$$note()*\nline\n$$end**";
      const { errors, onError } = collectErrors();

      const rawTokens = parseRichText(rawInput, {
        syntax: bothPrefixSyntax,
        handlers: {
          code: { raw: (_arg, content) => ({ type: "code", value: content }) },
        },
        onError,
      });
      const blockTokens = parseRichText(blockInput, {
        syntax: bothPrefixSyntax,
        handlers: {
          note: { block: (_arg, content) => ({ type: "note", value: content }) },
        },
        onError,
      });

      assert.equal(errors.length, 0, `expected no errors, got: ${errors.map(e => e.code).join(", ")}`);
      assert.equal(materializeTextTokens(rawTokens)[0]?.type, "code");
      assert.equal(materializeTextTokens(blockTokens)[0]?.type, "note");
    },
  },

  // ── root 上下文：)$$ 紧邻合法 tag head → 只消费 )，tag 正确解析 ──
  {
    name: "[CustomSyntax/Suppress] )$$ 紧邻合法 tag -> 不报 UNEXPECTED_CLOSE 且 tag 正确解析",
    run() {
      const { errors, onError } = collectErrors();
      const tokens = parseRichText(")$$bold(ok)$$", {
        syntax: rawPrefixSyntax,
        handlers: {
          bold: { inline: (t) => ({ type: "bold", value: t }) },
        },
        onError,
      });

      assert.equal(errors.length, 0, `expected no errors, got: ${errors.map(e => e.code).join(", ")}`);
      const flat = materializeTextTokens(tokens);
      assert.equal(flat.length, 2);
      assert.equal(flat[0]?.type, "text");
      assert.equal(flat[0]?.value, ")");
      assert.equal(flat[1]?.type, "bold");
    },
  },

  // ── root 上下文：孤立 )$$ → 仍报 UNEXPECTED_CLOSE ──
  {
    name: "[CustomSyntax/Error] 孤立 )$$ -> 仍报 UNEXPECTED_CLOSE",
    run() {
      const { errors, onError } = collectErrors();
      parseRichText("hello)$$ world", {
        syntax: rawPrefixSyntax,
        onError,
      });

      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "UNEXPECTED_CLOSE");
    },
  },

  // ── root 上下文：) 后 $$ 恰好是 rawClose 前缀但不在 raw 内 → 报 UNEXPECTED_CLOSE，不误吞 $$ ──
  {
    name: "[CustomSyntax/RawClose] root 中 )$$end%% 不在 raw 内 -> 报错但后续文本完整",
    run() {
      // )$$end%% 出现在 root，不在任何 raw 块内
      // ) 被识别为 endTag 的一部分（scanEndTagAt 命中），
      // readTagStartInfo 对 $$end%% 返回 null（end 后面是 % 不是 (）
      // 应报 UNEXPECTED_CLOSE 并把 ) 当文本，$$ 留给下一轮
      const { errors, onError } = collectErrors();
      const tokens = parseRichText(")$$end%% tail", {
        syntax: rawPrefixSyntax,
        onError,
      });

      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "UNEXPECTED_CLOSE");
      const flat = materializeTextTokens(tokens);
      assert.equal(flat.length, 1);
      assert.equal(flat[0]?.type, "text");
      // 整段作为文本保留
      assert.equal(flat[0]?.value, ")$$end%% tail");
    },
  },

  // ── endTag 消费宽度不因自定义 syntax 而变 ──
  {
    name: "[CustomSyntax/Width] 非 inline 帧 endTag 分支始终只消费 tagClose 宽度",
    run() {
      // 连续两个 )$$：第一个 ) 消费后 $$ 留下，第二个 )$$ 同理
      // 最终全部退化为文本
      const { errors, onError } = collectErrors();
      const tokens = parseRichText(")$$)$$ end", {
        syntax: rawPrefixSyntax,
        onError,
      });

      // 每个 )$$ 都应独立报 UNEXPECTED_CLOSE（去重 key 不同因 index 不同）
      assert.equal(errors.length, 2, `expected 2 errors, got: ${errors.map(e => `${e.code}@${e.column}`).join(", ")}`);
      assert.ok(errors.every(e => e.code === "UNEXPECTED_CLOSE"));
      const flat = materializeTextTokens(tokens);
      assert.equal(flat.length, 1);
      assert.equal(flat[0]?.value, ")$$)$$ end");
    },
  },

  // ── tagPrefix 与 rawClose 完全相同 ──
  {
    name: "[CustomSyntax/Overlap] rawClose 恰好等于 tagPrefix -> raw 仍可闭合",
    run() {
      const extremeSyntax = createSyntax({
        tagPrefix: "$$",
        tagOpen: "(",
        tagClose: ")",
        endTag: ")$$",
        rawOpen: ")%",
        rawClose: "$$",
        blockOpen: ")*",
        blockClose: "*end$$",
        tagDivider: "|",
        escapeChar: "\\",
      });

      const {  onError } = collectErrors();
      const tokens = parseRichText("$$code(js)%\nhello\n$$", {
        syntax: extremeSyntax,
        handlers: {
          code: { raw: (_arg, content) => ({ type: "code", value: content }) },
        },
        onError,
      });

      const flat = materializeTextTokens(tokens);
      const codeTokens = flat.filter(t => t.type === "code");
      assert.ok(codeTokens.length > 0, `expected code token, got types: ${flat.map(t => t.type)}`);
    },
  },
];

await runGoldenCases("Custom Syntax", "custom syntax case", cases);
