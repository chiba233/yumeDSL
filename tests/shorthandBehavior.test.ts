import assert from "node:assert/strict";
import {
  DEFAULT_SYNTAX,
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

cases.push({
  name: "[Shorthand/Behavior] nested shorthand should not steal ancestor full-form close",
  run: () => {
    const input = "=bold<bold<bold<bold<bold<bold<bold<bold<>>>>>>=";
    const nodes = parseStructural(input, {
      syntax,
      handlers,
      implicitInlineShorthand: true,
    });

    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.type, "inline");
    assert.equal((nodes[0] as { tag: string }).tag, "bold");
    assert.equal(printStructural(nodes, { syntax }), input);
  },
});

cases.push({
  name: "[Shorthand/Smoke] shorthand must never steal complete close",
  run: () => {
    const smokeInputs = [
      { label: "default", syntax: DEFAULT_SYNTAX },
      { label: "easy", syntax },
    ] as const;

    const makeInput = (
      currentSyntax: { tagPrefix: string; tagOpen: string; tagClose: string; endTag: string },
      depth: number,
      missingShorthandCloses: number,
    ): string =>
      `${currentSyntax.tagPrefix}bold${currentSyntax.tagOpen}${`bold${currentSyntax.tagOpen}`.repeat(depth - 1)}${currentSyntax.tagClose.repeat(depth - missingShorthandCloses - 1)}${currentSyntax.endTag}`;

    for (const item of smokeInputs) {
      for (let depth = 2; depth <= 24; depth++) {
        const maxMissing = Math.min(depth - 1, 6);
        for (let missing = 1; missing <= maxMissing; missing++) {
          const input = makeInput(item.syntax, depth, missing);
          const nodes = parseStructural(input, {
            syntax: item.syntax,
            handlers,
            implicitInlineShorthand: true,
          });
          const tokens = parseRichText(input, {
            syntax: item.syntax,
            handlers,
            implicitInlineShorthand: true,
          });

          assert.equal(nodes.length, 1, `${item.label} depth=${depth} missing=${missing}`);
          assert.equal(nodes[0]?.type, "inline", `${item.label} depth=${depth} missing=${missing}`);
          assert.equal((nodes[0] as { tag: string }).tag, "bold", `${item.label} depth=${depth} missing=${missing}`);
          assert.equal(tokens[0]?.type, "bold", `${item.label} depth=${depth} missing=${missing}`);
          assert.equal(printStructural(nodes, { syntax: item.syntax }), input, `${item.label} depth=${depth} missing=${missing}`);
        }
      }
    }
  },
});

await runGoldenCases("Shorthand Behavior", "shorthand 行为矩阵 case", cases, { quietPasses: true });
