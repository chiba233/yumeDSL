import assert from "node:assert/strict";
import {
  createEasySyntax,
  createSimpleInlineHandlers,
  extractText,
  parseRichText,
  parseStructural,
  printStructural,
} from "../src/index.ts";
import type { GoldenCase } from "./testHarness.ts";
import { runGoldenCases } from "./testHarness.ts";

const syntax = createEasySyntax({
  tagPrefix: "=",
  tagOpen: "<",
  tagClose: ">",
  tagDivider: "|",
  escapeChar: "\\",
});

const handlers = createSimpleInlineHandlers(["bold", "italic", "link"]);

interface MatrixCase {
  input: string;
  expectedOff: string;
  expectedOn: string;
}

const matrixCases: MatrixCase[] = [
  {
    input: "=bold<bold<>=",
    expectedOff: "bold<",
    expectedOn: "bold<",
  },
  {
    input: "=bold<bold<1>>=",
    expectedOff: "bold<1>",
    expectedOn: "1",
  },
  {
    input: "=bold<bold<=bold<>=>=",
    expectedOff: "bold<",
    expectedOn: "bold<",
  },
  {
    input: "=bold<bold<>=bold<>=>=",
    expectedOff: "bold<bold<>=>=",
    expectedOn: "bold<bold<>=>=",
  },
  {
    input: "=bold<天気がbold<い=italic<い>=>から>=散歩しましょう",
    expectedOff: "天気がbold<いい>から散歩しましょう",
    expectedOn: "天気がいいから散歩しましょう",
  },
  {
    input: "=bold<天気がbold<いlink<baidu.com>=>から>=散歩しましょう",
    expectedOff: "天気がbold<いlink<baidu.com>から>=散歩しましょう",
    expectedOn: "天気がbold<いlink<baidu.com>から>=散歩しましょう",
  },
  {
    input: "=bold<天気がbold<いlink<baidu.com|い>=>から>=散歩しましょう",
    expectedOff: "天気がbold<いlink<baidu.com|い>から>=散歩しましょう",
    expectedOn: "天気がbold<いlink<baidu.com|い>から>=散歩しましょう",
  },
  {
    input: "=bold<bold<=italic<1>=>>=Q",
    expectedOff: "bold<1>Q",
    expectedOn: "1Q",
  },
];

const runModeText = (input: string, shorthand: boolean): string => {
  const tokens = parseRichText(input, {
    syntax,
    handlers,
    implicitInlineShorthand: shorthand,
  });
  return extractText(tokens);
};

const runModePrint = (input: string, shorthand: boolean): string => {
  const nodes = parseStructural(input, {
    syntax,
    handlers,
    implicitInlineShorthand: shorthand,
  });
  return printStructural(nodes, { syntax });
};

const cases: GoldenCase[] = matrixCases.flatMap((item) => [
  {
    name: `[Shorthand/Behavior] shorthand=off text -> ${item.input}`,
    run: () => {
      assert.equal(runModeText(item.input, false), item.expectedOff);
    },
  },
  {
    name: `[Shorthand/Behavior] shorthand=on text -> ${item.input}`,
    run: () => {
      assert.equal(runModeText(item.input, true), item.expectedOn);
    },
  },
  {
    name: `[Shorthand/Behavior] shorthand=off print round-trip -> ${item.input}`,
    run: () => {
      assert.equal(runModePrint(item.input, false), item.input);
    },
  },
  {
    name: `[Shorthand/Behavior] shorthand=on print round-trip -> ${item.input}`,
    run: () => {
      assert.equal(runModePrint(item.input, true), item.input);
    },
  },
]);

await runGoldenCases("Shorthand Behavior", "shorthand 行为矩阵 case", cases, { quietPasses: true });
