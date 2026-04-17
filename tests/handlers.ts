/**
 * Test-only tag handlers that mirror the original project's handlers.
 * These exist solely so golden test fixtures can assert concrete token shapes.
 */

import type { TagHandler, TokenDraft } from "../src/types/index.ts";
import { parsePipeArgs, parsePipeTextArgs, createToken, materializeTextTokens } from "../src/index.ts";

const LANG_MAP: Record<string, string> = {
  js: "typescript",
  javascript: "typescript",
  ts: "typescript",
  typescript: "typescript",
};

const simpleInline = (type: string): TagHandler => ({
  inline: (tokens): TokenDraft => ({ type, value: materializeTextTokens(tokens) }),
});

const titledHandler = (type: string, defaultTitle: string): TagHandler => ({
  inline: (tokens): TokenDraft => {
    const args = parsePipeArgs(tokens);
    if (args.parts.length <= 1) {
      return { type, title: defaultTitle, value: args.materializedTokens(0) };
    }
    return { type, title: args.text(0), value: args.materializedTailTokens(1) };
  },
  block: (arg, tokens): TokenDraft => ({
    type,
    title: arg || defaultTitle,
    value: tokens,
  }),
  raw: (arg, content): TokenDraft => ({
    type,
    title: arg || defaultTitle,
    value: [createToken({ type: "text", value: content })],
  }),
});

const collapseBase = titledHandler("collapse", "Click to expand content");

export const testHandlers: Record<string, TagHandler> = {
  bold: simpleInline("bold"),
  thin: simpleInline("thin"),
  underline: simpleInline("underline"),
  strike: simpleInline("strike"),
  code: simpleInline("code"),
  center: simpleInline("center"),

  link: {
    inline: (tokens): TokenDraft => {
      const args = parsePipeArgs(tokens);
      const url = args.text(0);
      const displayTokens =
        args.parts.length > 1
          ? args.materializedTailTokens(1)
          : args.materializedTokens(0);
      return { type: "link", url, value: displayTokens };
    },
  },

  info: titledHandler("info", "Info"),
  warning: titledHandler("warning", "Warning"),

  collapse: {
    block: collapseBase.block,
    raw: collapseBase.raw,
  },

  "raw-code": {
    raw: (arg, content): TokenDraft => {
      const args = parsePipeTextArgs(arg ?? "");
      const langInput = args.text(0);
      const codeLang = LANG_MAP[langInput] ?? langInput;
      const title = args.text(1) || "Code:";
      const label = args.text(2) ?? "";
      return { type: "raw-code", codeLang, title, label, value: content };
    },
  },

  date: {
    inline: (tokens): TokenDraft => {
      const args = parsePipeArgs(tokens);
      const date = args.text(0);
      const format = args.text(1) || undefined;
      const timeLang = args.text(2) || undefined;
      return { type: "date", date, format, timeLang, value: "" };
    },
  },

  fromNow: {
    inline: (tokens): TokenDraft => {
      const args = parsePipeArgs(tokens);
      const date = args.text(0);
      const timeLang = args.text(1) || undefined;
      return { type: "fromNow", date, timeLang, value: "" };
    },
  },
};
