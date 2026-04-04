import assert from "node:assert/strict";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";
import { parseRichText, materializeTextTokens } from "../src/index.ts";

const cases: GoldenCase[] = [
  {
    name: "[Order/onError] parseRichText 的错误顺序应保持与 1.1.3 基线一致",
    run() {
      const codes: string[] = [];
      parseRichText("$$bold(unclosed $$thin(ok)$$ $$underline(good)$$", {
        trackPositions: true,
        onError: (error) => codes.push(error.code),
      });

      assert.deepEqual(codes, ["INLINE_NOT_CLOSED"]);
    },
  },
  {
    name: "[Order/onError] inline 子帧跑到 EOF 时仍应先报 INLINE_NOT_CLOSED",
    run() {
      const codes: string[] = [];
      parseRichText("$$link(before (x)$$ tail", {
        onError: (error) => codes.push(error.code),
      });

      assert.deepEqual(codes, ["INLINE_NOT_CLOSED", "UNEXPECTED_CLOSE"]);
    },
  },
  {
    name: "[Order/onError] argClose 已找到但缺少 )$$ 时仍应上报 INLINE_NOT_CLOSED",
    run() {
      const codes: string[] = [];
      parseRichText("$$bold(x)", {
        onError: (error) => codes.push(error.code),
      });

      assert.deepEqual(codes, ["INLINE_NOT_CLOSED"]);
    },
  },
  {
    name: "[Order/onError] parseRichText raw 未闭合 -> 应保持 1.1.3 的错误基线",
    run() {
      const codes: string[] = [];
      parseRichText("$$raw-code(js)%\nconst x = 1", {
        onError: (error) => codes.push(error.code),
      });

      assert.deepEqual(codes, ["RAW_NOT_CLOSED"]);
    },
  },
  {
    name: "[Order/onError] inline 子帧转 raw 后未闭合 -> 仍应上报 RAW_NOT_CLOSED",
    run() {
      const codes: string[] = [];
      parseRichText("$$bold(before $$code(js)%\nconst x = 1", {
        onError: (error) => codes.push(error.code),
      });

      assert.deepEqual(codes, ["INLINE_NOT_CLOSED", "RAW_NOT_CLOSED"]);
    },
  },
  {
    name: "[Order/onError] parseRichText block 未闭合 -> 应保持 1.1.3 的错误基线",
    run() {
      const codes: string[] = [];
      parseRichText("$$info(T)*\nhello", {
        onError: (error) => codes.push(error.code),
      });

      assert.deepEqual(codes, ["BLOCK_NOT_CLOSED"]);
    },
  },
  {
    name: "[Order/onError] inline 子帧转 block 后未闭合 -> 仍应上报 BLOCK_NOT_CLOSED",
    run() {
      const codes: string[] = [];
      parseRichText("$$bold(before $$info(T)*\nhello", {
        onError: (error) => codes.push(error.code),
      });

      assert.deepEqual(codes, ["INLINE_NOT_CLOSED", "BLOCK_NOT_CLOSED"]);
    },
  },
  {
    name: "[Order/Handlers] inline 与 raw handler 的调用顺序不应漂移",
    run() {
      const log: string[] = [];

      parseRichText("$$info(Title)*\nA $$bold(B)$$ $$thin(C)$$\n*end$$ $$raw-code(js)%\nconst x = 1\n%end$$", {
        trackPositions: true,
        handlers: {
          bold: {
            inline: (tokens) => {
              const text = materializeTextTokens(tokens)
                .map((token) => (token.type === "text" ? token.value : token.type))
                .join("");
              log.push(`inline:bold:${text}`);
              return { type: "bold", value: materializeTextTokens(tokens) };
            },
          },
          thin: {
            inline: (tokens) => {
              const text = materializeTextTokens(tokens)
                .map((token) => (token.type === "text" ? token.value : token.type))
                .join("");
              log.push(`inline:thin:${text}`);
              return { type: "thin", value: materializeTextTokens(tokens) };
            },
          },
          info: {
            block: (arg, tokens) => ({
              type: "info",
              title: arg || "Info",
              value: tokens,
            }),
          },
          "raw-code": {
            raw: (arg, content) => {
              log.push(`raw:raw-code:${arg ?? ""}:${content.trimEnd()}`);
              return { type: "raw-code", title: arg || "", value: content };
            },
          },
        },
      });

      assert.deepEqual(log, [
        "inline:bold:B",
        "inline:thin:C",
        "raw:raw-code:js:const x = 1",
      ]);
    },
  },
  {
    name: "[Order/CreateId] createId 的消费顺序不应偷偷漂移",
    run() {
      let seed = 0;
      const ids: string[] = [];

      const tokens = parseRichText("$$info(Title)*\nA $$bold(B)$$ $$thin(C)$$\n*end$$ $$raw-code(js)%\nconst x = 1\n%end$$", {
        createId: () => `id-${++seed}`,
        trackPositions: true,
        handlers: {
          bold: { inline: (innerTokens) => ({ type: "bold", value: innerTokens }) },
          thin: { inline: (innerTokens) => ({ type: "thin", value: innerTokens }) },
          info: { block: (arg, innerTokens) => ({ type: "info", title: arg || "Info", value: innerTokens }) },
          "raw-code": { raw: (arg, content) => ({ type: "raw-code", title: arg || "", value: content }) },
        },
      });

      const walk = (nodes: typeof tokens): void => {
        for (const node of nodes) {
          if (node.id) {
            ids.push(`${node.type}:${node.id}`);
          }
          if (Array.isArray(node.value)) {
            walk(node.value);
          }
        }
      };

      walk(tokens);

      assert.deepEqual(ids, [
        "text:id-1",
        "bold:id-3",
        "text:id-2",
        "text:id-4",
        "thin:id-6",
        "text:id-5",
        "text:id-7",
        "raw-code:id-8",
      ]);
    },
  },
];

await runGoldenCases("Order / Timing", " 顺序回归用例", cases);
