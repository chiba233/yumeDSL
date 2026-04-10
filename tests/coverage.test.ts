// noinspection DuplicatedCode

/**
 * Supplementary coverage tests for lines uncovered by existing suites.
 *
 * Target files and uncovered areas:
 * - structural.ts  557-616  (raw form inside inline frame)
 * - structural.ts  646-689  (block form inside inline frame)
 * - structural.ts  586-593  (raw gating inside inline frame)
 * - structural.ts  646-651  (block gating inside inline frame)
 * - structural.ts  565-583  (raw unclosed error inside inline frame)
 * - render.ts      170-176  (degradeToSource)
 * - render.ts      228-230  (inline degrade)
 * - render.ts      253-255  (raw degrade)
 * - render.ts      284-286  (block degrade)
 * - builders.ts    250-251  (createTokenGuard)
 * - blockTagFormatting.ts branch coverage
 */
import assert from "node:assert/strict";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";
import { parseStructural } from "../src/structural.ts";
import { parseRichText } from "../src/parse.ts";
import { createTokenGuard } from "../src/builders.ts";
import type { StructuralNode, TagHandler, TextToken } from "../src/types.ts";
import { renderNodes, type RenderContext } from "../src/render.ts";
import { parseStructuralWithResolved } from "../src/structural.ts";
import { resolveBaseOptions } from "../src/resolveOptions.ts";
import { DEFAULT_SYNTAX, createSyntax } from "../src/syntax.ts";
import { DEFAULT_TAG_NAME, createTagNameConfig } from "../src/chars.ts";
import { findInlineClose, getTagCloserType, readTagStartInfo, skipTagBoundary } from "../src/scanner.ts";
import { fnvFeedString, fnvFeedStringBounded, fnvInit } from "../src/hash.ts";

// ── Helpers ──

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

const normalizeTokens = (tokens: TextToken[]): unknown[] =>
  tokens.map(({ id, position, ...rest }) => ({
    ...rest,
    value: typeof rest.value === "string" ? rest.value : normalizeTokens(rest.value as TextToken[]),
  }));

const cases: GoldenCase[] = [
  // ═══════════════════════════════════════════════════════════
  // structural.ts — raw form inside inline frame (lines 557-616)
  //
  // Raw/block close tokens (%end$$ / *end$$) must be whole-line tokens.
  // So nested raw/block inside inline frames require multiline input.
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/Structural] nested raw inside inline frame -> structural tree preserves both forms",
    run() {
      // Inside bold's inline frame, $$code(ts)% triggers raw form detection (line 557).
      // %end$$ must be on its own line for findRawClose to match.
      const input = "$$bold($$code(ts)%\nraw content\n%end$$\n)$$";
      const nodes = parseStructural(input);
      const normalized = normalizeStructuralNodes(nodes);
      assert.deepEqual(normalized, [
        {
          type: "inline",
          tag: "bold",
          children: [
            {
              type: "raw",
              tag: "code",
              args: [{ type: "text", value: "ts" }],
              content: "\nraw content\n",
            },
            { type: "text", value: "\n" },
          ],
        },
      ]);
    },
  },
  {
    name: "[Coverage/Structural] nested raw inside inline frame with text siblings -> preserves order",
    run() {
      const input = "$$bold(hello $$code(ts)%\nx = 1\n%end$$\n world)$$";
      const nodes = parseStructural(input);
      assert.equal(nodes.length, 1);
      const inline = nodes[0] as Extract<StructuralNode, { type: "inline" }>;
      assert.equal(inline.tag, "bold");
      // Should contain: text("hello "), raw(code), text("\n world")
      const types = inline.children.map((c) => c.type);
      assert.ok(types.includes("raw"), `children should include raw node, got types: ${types.join(", ")}`);
      const raw = inline.children.find((c) => c.type === "raw") as Extract<StructuralNode, { type: "raw" }>;
      assert.equal(raw.tag, "code");
      assert.equal(raw.content, "\nx = 1\n");
    },
  },

  // ═══════════════════════════════════════════════════════════
  // structural.ts — block form inside inline frame (lines 646-689)
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/Structural] nested block inside inline frame -> structural tree preserves both forms",
    run() {
      // Inside bold's inline frame, $$panel(title)* triggers block form detection (line 646).
      // *end$$ must be on its own line for findBlockClose to match.
      const input = "$$bold($$panel(title)*\ncontent\n*end$$\n)$$";
      const nodes = parseStructural(input);
      const normalized = normalizeStructuralNodes(nodes);
      assert.deepEqual(normalized, [
        {
          type: "inline",
          tag: "bold",
          children: [
            {
              type: "block",
              tag: "panel",
              args: [{ type: "text", value: "title" }],
              children: [{ type: "text", value: "\ncontent\n" }],
            },
            { type: "text", value: "\n" },
          ],
        },
      ]);
    },
  },

  // ═══════════════════════════════════════════════════════════
  // structural.ts — raw gating inside inline frame (lines 586-593)
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/Structural] nested raw gating inside inline frame -> degrades to text when handler has no raw",
    run() {
      // bold supports inline+raw; code supports only inline.
      // Inside bold's inline frame, $$code(ts)% is detected as raw form,
      // but gating rejects it (code has no raw method) → degrades to text.
      const handlers: Record<string, TagHandler> = {
        bold: {
          inline: (tokens) => ({ type: "bold", value: tokens }),
          raw: (_a, c) => ({ type: "bold", value: c }),
        },
        code: {
          inline: (tokens) => ({ type: "code", value: tokens }),
        },
      };
      const input = "$$bold($$code(ts)%\nraw\n%end$$\n)$$";
      const nodes = parseStructural(input, { handlers });
      const normalized = normalizeStructuralNodes(nodes);
      // code's raw form is gated → entire $$code(ts)%\nraw\n%end$$ becomes text inside bold
      assert.equal(normalized.length, 1);
      const inline = normalized[0] as { type: string; children: unknown[] };
      assert.equal(inline.type, "inline");
      const childTexts = (inline.children as { type: string; value?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.value)
        .join("");
      assert.ok(
        childTexts.includes("$$code(ts)%"),
        `gated raw should degrade to text, got: ${childTexts}`,
      );
    },
  },

  // ═══════════════════════════════════════════════════════════
  // structural.ts — block gating inside inline frame (lines 646-651)
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/Structural] nested block gating inside inline frame -> degrades to text when handler has no block",
    run() {
      const handlers: Record<string, TagHandler> = {
        bold: {
          inline: (tokens) => ({ type: "bold", value: tokens }),
          block: (_a, t) => ({ type: "bold", value: t }),
        },
        panel: {
          inline: (tokens) => ({ type: "panel", value: tokens }),
        },
      };
      const input = "$$bold($$panel(title)*\ncontent\n*end$$\n)$$";
      const nodes = parseStructural(input, { handlers });
      const normalized = normalizeStructuralNodes(nodes);
      assert.equal(normalized.length, 1);
      const inline = normalized[0] as { type: string; children: unknown[] };
      assert.equal(inline.type, "inline");
      const childTexts = (inline.children as { type: string; value?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.value)
        .join("");
      assert.ok(
        childTexts.includes("$$panel(title)*"),
        `gated block should degrade to text, got: ${childTexts}`,
      );
    },
  },

  // ═══════════════════════════════════════════════════════════
  // structural.ts — raw unclosed inside inline frame (lines 565-583)
  //
  // parseStructural does not expose onError, so we verify by checking that
  // the unclosed raw/block degrades the entire nested tag to text.
  // The error path in the inline frame appends the failed tag region to
  // the parent buffer as plain text.
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/Structural] nested raw unclosed inside inline frame -> degrades to text",
    run() {
      // raw form detected by )% but no matching %end$$ on its own line →
      // inline-frame error path degrades the whole region to text
      const input = "$$bold($$code(ts)%content without close)$$";
      const nodes = parseStructural(input);
      // The entire bold inline should still close; inner raw is degraded
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      const inline = nodes[0] as Extract<StructuralNode, { type: "inline" }>;
      assert.equal(inline.tag, "bold");
      // Inner content must NOT contain a raw node — it should all be text
      const hasRaw = inline.children.some((c) => c.type === "raw");
      assert.equal(hasRaw, false, "unclosed raw should degrade, not produce raw node");
      const textContent = inline.children
        .filter((c): c is Extract<StructuralNode, { type: "text" }> => c.type === "text")
        .map((c) => c.value)
        .join("");
      assert.ok(
        textContent.includes("$$code(ts)%"),
        `degraded text should contain raw syntax, got: ${textContent}`,
      );
    },
  },
  {
    name: "[Coverage/Structural] nested block unclosed inside inline frame -> degrades to text",
    run() {
      // block form detected by )* but no matching *end$$ on its own line
      const input = "$$bold($$panel(title)*content without close)$$";
      const nodes = parseStructural(input);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");
      const inline = nodes[0] as Extract<StructuralNode, { type: "inline" }>;
      const hasBlock = inline.children.some((c) => c.type === "block");
      assert.equal(hasBlock, false, "unclosed block should degrade, not produce block node");
      const textContent = inline.children
        .filter((c): c is Extract<StructuralNode, { type: "text" }> => c.type === "text")
        .map((c) => c.value)
        .join("");
      assert.ok(
        textContent.includes("$$panel(title)*"),
        `degraded text should contain block syntax, got: ${textContent}`,
      );
    },
  },

  // ═══════════════════════════════════════════════════════════
  // render.ts — degradeToSource (lines 170-176, 228-230, 253-255, 284-286)
  //
  // These are defensive paths: structural parser and render layer share gating
  // in parseRichText, so under normal flow they agree. We test via internal
  // renderNodes with a deliberately mismatched RenderContext.
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/Render] inline node with unsupported handler -> degradeToSource",
    run() {
      const source = "$$code(hello)$$";
      // Parse structurally without gating (all forms accepted)
      const resolved = resolveBaseOptions(source, { trackPositions: true });
      const nodes = parseStructuralWithResolved(source, resolved, null);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "inline");

      // Build render context where code only supports raw (inline not supported)
      let seed = 0;
      const ctx: RenderContext = {
        source,
        handlers: { code: { raw: (_a, c) => ({ type: "code", value: c }) } },
        registeredTags: new Set(["code"]),
        allowInline: true,
        blockTagSet: { has: () => false },
        tracker: resolved.tracker,
        syntax: resolved.syntax,
        createId: () => `t-${seed++}`,
      };
      const tokens = renderNodes(nodes, ctx, "root");
      // Should degrade: inline node rendered as source text
      const text = tokens.map((t) => (typeof t.value === "string" ? t.value : "")).join("");
      assert.equal(text, "$$code(hello)$$");
    },
  },
  {
    name: "[Coverage/Render] raw node without handler.raw -> degradeToSource",
    run() {
      const source = "$$code(ts)%\ncontent\n%end$$";
      const resolved = resolveBaseOptions(source, { trackPositions: true });
      const nodes = parseStructuralWithResolved(source, resolved, null);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "raw");

      let seed = 0;
      const ctx: RenderContext = {
        source,
        handlers: { code: { inline: (tokens) => ({ type: "code", value: tokens }) } },
        registeredTags: new Set(["code"]),
        allowInline: true,
        blockTagSet: { has: () => false },
        tracker: resolved.tracker,
        syntax: resolved.syntax,
        createId: () => `t-${seed++}`,
      };
      const tokens = renderNodes(nodes, ctx, "root");
      const text = tokens.map((t) => (typeof t.value === "string" ? t.value : "")).join("");
      assert.equal(text, source);
    },
  },
  {
    name: "[Coverage/Render] block node without handler.block -> degradeToSource",
    run() {
      const source = "$$panel(title)*\ncontent\n*end$$";
      const resolved = resolveBaseOptions(source, { trackPositions: true });
      const nodes = parseStructuralWithResolved(source, resolved, null);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].type, "block");

      let seed = 0;
      const ctx: RenderContext = {
        source,
        handlers: { panel: { inline: (tokens) => ({ type: "panel", value: tokens }) } },
        registeredTags: new Set(["panel"]),
        allowInline: true,
        blockTagSet: { has: () => false },
        tracker: resolved.tracker,
        syntax: resolved.syntax,
        createId: () => `t-${seed++}`,
      };
      const tokens = renderNodes(nodes, ctx, "root");
      const text = tokens.map((t) => (typeof t.value === "string" ? t.value : "")).join("");
      assert.equal(text, source);
    },
  },

  // ═══════════════════════════════════════════════════════════
  // builders.ts — createTokenGuard (lines 250-251)
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/Builders] createTokenGuard narrows token type at runtime",
    run() {
      type MyMap = {
        link: { url: string };
        code: { lang: string };
      };
      const is = createTokenGuard<MyMap>();

      const linkToken: TextToken = { id: "1", type: "link", url: "https://example.com", value: "click" };
      const textToken: TextToken = { id: "2", type: "text", value: "hello" };

      assert.equal(is(linkToken, "link"), true);
      assert.equal(is(textToken, "link"), false);
      assert.equal(is(textToken, "code"), false);

      // Type narrowing works — accessing url after guard
      if (is(linkToken, "link")) {
        assert.equal((linkToken as unknown as { url: string }).url, "https://example.com");
      }
    },
  },

  // ═══════════════════════════════════════════════════════════
  // blockTagFormatting.ts — branch coverage (lines 5, 9, 28)
  // ═══════════════════════════════════════════════════════════
  {
    name: "[Coverage/BlockTag] block tag with \\r\\n boundaries -> normalizes correctly",
    run() {
      // Exercise \r\n line break paths in blockTagFormatting
      const handlers: Record<string, TagHandler> = {
        panel: {
          block: (_arg, tokens) => ({ type: "panel", value: tokens }),
        },
      };
      const tokens = parseRichText("$$panel()*\r\ncontent\r\n*end$$", {
        handlers,
        blockTags: ["panel"],
      });
      const normalized = normalizeTokens(tokens);
      assert.equal(normalized.length, 1);
      const panel = normalized[0] as { type: string; value: unknown[] };
      assert.equal(panel.type, "panel");
      // Block tag normalization should trim leading/trailing \r\n
      const innerText = (panel.value as { type: string; value: string }[])
        .filter((t) => t.type === "text")
        .map((t) => t.value)
        .join("");
      assert.equal(innerText, "content");
    },
  },
  {
    name: "[Coverage/BlockTag] raw tag with \\r\\n boundary and blockTags -> normalizes correctly",
    run() {
      const handlers: Record<string, TagHandler> = {
        code: {
          raw: (_arg, content) => ({ type: "code", value: content }),
        },
      };
      // Exercise \r\n paths for raw tag with explicit blockTags
      const tokens = parseRichText("$$code()%\r\ncontent\r\n%end$$", {
        handlers,
        blockTags: ["code"],
      });
      const normalized = normalizeTokens(tokens);
      assert.equal(normalized.length, 1);
      assert.equal((normalized[0] as { type: string }).type, "code");
    },
  },
  {
    name: "[Coverage/Scanner] findInlineClose should skip escaped endTag candidate",
    run() {
      const syntax = createSyntax();
      const tagName = createTagNameConfig();
      const input = "$$bold(aa\\)$$bb)$$";
      const info = readTagStartInfo(input, 0, syntax, tagName);
      assert.ok(info);
      const closeStart = findInlineClose(input, info.argStart, syntax, tagName);
      assert.equal(closeStart, input.lastIndexOf(syntax.endTag));
    },
  },
  {
    name: "[Coverage/Scanner] skipTagBoundary raw path should return contentStart on missing close",
    run() {
      const syntax = createSyntax();
      const tagName = createTagNameConfig();
      const input = "$$code(js)%\nraw without close";
      const info = readTagStartInfo(input, 0, syntax, tagName);
      assert.ok(info);

      const closerInfo = getTagCloserType(input, info.tagNameEnd + syntax.tagOpen.length, syntax);
      assert.ok(closerInfo);
      assert.equal(closerInfo.closer, syntax.rawClose);

      const contentStart = closerInfo.argClose + syntax.rawOpen.length;
      const boundary = skipTagBoundary(input, info, syntax, tagName);
      assert.equal(boundary, contentStart);
    },
  },
  {
    name: "[Coverage/Scanner] skipTagBoundary raw path should jump past rawClose when close exists",
    run() {
      const syntax = createSyntax();
      const tagName = createTagNameConfig();
      const input = "$$code(js)%\nx\n%end$$\ntail";
      const info = readTagStartInfo(input, 0, syntax, tagName);
      assert.ok(info);
      const boundary = skipTagBoundary(input, info, syntax, tagName);
      assert.equal(boundary, input.indexOf("%end$$") + syntax.rawClose.length);
    },
  },
  {
    name: "[Coverage/Hash] fnvFeedStringBounded should hash head+tail for long inputs",
    run() {
      const long = "H".repeat(32) + "MIDDLE-IGNORED" + "T".repeat(32);
      assert.ok(long.length > 64);

      const bounded = fnvFeedStringBounded(fnvInit(), long);
      const expected = fnvFeedString(
        fnvFeedString(fnvInit(), long.slice(0, 32)),
        long.slice(long.length - 32),
      );
      assert.equal(bounded, expected >>> 0);
    },
  },
  {
    name: "[Coverage/Hash] fnvFeedStringBounded middle-diff long inputs should collide by design",
    run() {
      const head = "A".repeat(32);
      const tail = "Z".repeat(32);
      const a = `${head}middle-one${tail}`;
      const b = `${head}middle-two${tail}`;
      assert.ok(a.length > 64 && b.length > 64);
      assert.equal(fnvFeedStringBounded(fnvInit(), a), fnvFeedStringBounded(fnvInit(), b));
    },
  },
];

await runGoldenCases("Coverage Supplement", "coverage case", cases);
