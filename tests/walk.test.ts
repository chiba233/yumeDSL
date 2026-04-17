import assert from "node:assert/strict";
import { walkTokens, mapTokens } from "../src/index.ts";
import type { TextToken } from "../src/types/index.ts";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";

// ── Helpers ──

const leaf = (type: string, value: string): TextToken => ({
  type,
  value,
  id: `${type}-${value}`,
});

const branch = (type: string, children: TextToken[]): TextToken => ({
  type,
  value: children,
  id: `${type}-branch`,
});

// ── Fixtures ──

//  bold("hello " + italic("world"))
const tree: TextToken[] = [
  leaf("text", "before "),
  branch("bold", [
    leaf("text", "hello "),
    branch("italic", [leaf("text", "world")]),
  ]),
  leaf("text", " after"),
];

// ── Cases ──

const cases: GoldenCase[] = [
  {
    name: "walkTokens: generic visitor collects all types",
    run: () => {
      const types: string[] = [];
      walkTokens(tree, (token) => types.push(token.type));
      assert.deepEqual(types, ["text", "bold", "text", "italic", "text", "text"]);
    },
  },
  {
    name: "walkTokens: record visitor dispatches by type",
    run: () => {
      const tags: string[] = [];
      walkTokens(tree, {
        bold: () => tags.push("bold"),
        italic: () => tags.push("italic"),
      });
      assert.deepEqual(tags, ["bold", "italic"]);
    },
  },
  {
    name: "walkTokens: record visitor misses unknown types without crashing",
    run: () => {
      const calls: string[] = [];
      walkTokens(tree, {
        underline: () => calls.push("underline"),
      });
      assert.deepEqual(calls, []);
    },
  },
  {
    name: "walkTokens: context provides parent, depth, index",
    run: () => {
      const log: Array<{ type: string; parent: string | null; depth: number; index: number }> = [];
      walkTokens(tree, (token, ctx) => {
        log.push({
          type: token.type,
          parent: ctx.parent?.type ?? null,
          depth: ctx.depth,
          index: ctx.index,
        });
      });
      assert.deepEqual(log, [
        { type: "text", parent: null, depth: 0, index: 0 },
        { type: "bold", parent: null, depth: 0, index: 1 },
        { type: "text", parent: "bold", depth: 1, index: 0 },
        { type: "italic", parent: "bold", depth: 1, index: 1 },
        { type: "text", parent: "italic", depth: 2, index: 0 },
        { type: "text", parent: null, depth: 0, index: 2 },
      ]);
    },
  },
  {
    name: "walkTokens: empty array is a no-op",
    run: () => {
      let called = false;
      walkTokens([], () => { called = true; });
      assert.equal(called, false);
    },
  },
  {
    name: "mapTokens: identity returns equivalent tree",
    run: () => {
      const result = mapTokens(tree, (token) => token);
      assert.deepEqual(result, tree);
    },
  },
  {
    name: "mapTokens: null removes tokens",
    run: () => {
      const result = mapTokens(tree, (token) =>
        token.type === "text" ? token : null,
      );
      assert.deepEqual(result, [
        leaf("text", "before "),
        leaf("text", " after"),
      ]);
    },
  },
  {
    name: "mapTokens: replace token value",
    run: () => {
      const result = mapTokens(tree, (token) =>
        token.type === "text" && typeof token.value === "string"
          ? { ...token, value: token.value.toUpperCase() }
          : token,
      );
      // Leaf text should be uppercased
      assert.equal((result[0] as TextToken).value, "BEFORE ");
      assert.equal((result[2] as TextToken).value, " AFTER");
      // Nested text inside bold > italic should also be uppercased (post-order)
      const bold = result[1] as TextToken;
      const boldChildren = bold.value as TextToken[];
      assert.equal(boldChildren[0].value, "HELLO ");
      const italic = boldChildren[1] as TextToken;
      const italicChildren = italic.value as TextToken[];
      assert.equal(italicChildren[0].value, "WORLD");
    },
  },
  {
    name: "mapTokens: does not mutate original tree",
    run: () => {
      const original = [branch("wrap", [leaf("text", "keep")])];
      const originalJson = JSON.stringify(original);

      mapTokens(original, (token) =>
        token.type === "text" ? { ...token, value: "changed" } : token,
      );

      assert.equal(JSON.stringify(original), originalJson);
    },
  },
  {
    name: "mapTokens: post-order — visitor sees already-mapped children",
    run: () => {
      const input = [branch("root", [leaf("text", "a")])];
      const seen: string[] = [];

      mapTokens(input, (token) => {
        if (token.type === "root") {
          const children = token.value as TextToken[];
          seen.push(children[0].value as string);
        }
        if (token.type === "text") {
          return { ...token, value: "b" };
        }
        return token;
      });

      // root visitor should see child already mapped to "b"
      assert.deepEqual(seen, ["b"]);
    },
  },
  {
    name: "mapTokens: ctx.parent points to original input token",
    run: () => {
      const input = [branch("root", [branch("wrap", [leaf("text", "a")])])];
      let seenParentChildCount: number | null = null;

      mapTokens(input, (token, ctx) => {
        if (token.type === "wrap") {
          seenParentChildCount = Array.isArray(ctx.parent?.value) ? ctx.parent.value.length : null;
        }

        if (token.type === "wrap") {
          return {
            ...token,
            value: [leaf("text", "mapped")],
          };
        }

        return token.type === "text"
          ? { ...token, value: `${token.value as string}!` }
          : token;
      });

      assert.equal(seenParentChildCount, 1);
    },
  },
  {
    name: "mapTokens: return array expands one token into siblings",
    run: () => {
      const input = [branch("wrapper", [leaf("text", "inner")])];
      // Unwrap: replace wrapper with its children
      const result = mapTokens(input, (token) =>
        token.type === "wrapper" ? (token.value as TextToken[]) : token,
      );
      assert.deepEqual(result, [leaf("text", "inner")]);
    },
  },
  {
    name: "mapTokens: return empty array removes like null",
    run: () => {
      const input = [leaf("text", "a"), leaf("gone", "b"), leaf("text", "c")];
      const result = mapTokens(input, (token) =>
        token.type === "gone" ? [] : token,
      );
      assert.deepEqual(result, [leaf("text", "a"), leaf("text", "c")]);
    },
  },
  {
    name: "mapTokens: expansion works inside nested children",
    run: () => {
      // bold(alias("x")) → bold("before", "x", "after")
      const input = [branch("bold", [leaf("alias", "x")])];
      const result = mapTokens(input, (token) =>
        token.type === "alias"
          ? [leaf("text", "before "), leaf("text", token.value as string), leaf("text", " after")]
          : token,
      );
      const boldChildren = (result[0] as TextToken).value as TextToken[];
      assert.equal(boldChildren.length, 3);
      assert.equal(boldChildren[0].value, "before ");
      assert.equal(boldChildren[1].value, "x");
      assert.equal(boldChildren[2].value, " after");
    },
  },
  {
    name: "mapTokens: empty array returns empty array",
    run: () => {
      const result = mapTokens([], () => null);
      assert.deepEqual(result, []);
    },
  },
];

await runGoldenCases("Walk", "walk/map case", cases);
