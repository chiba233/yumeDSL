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
const tildeEscapeSyntax = createEasySyntax({
  tagPrefix: "=",
  tagOpen: "<",
  tagClose: ">",
  tagDivider: "|",
  escapeChar: "~",
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

cases.push({
  name: "[Shorthand/Regression] malformed outer full-form must downgrade whole nested shorthand tail to text",
  run: () => {
    const inputs = [
      "=bold<bold<>>",
      "=bold<bold<>>>",
      "=bold<bold<bold<>>>",
      "=bold<bold<bold<bold<bold<bold<bold<>>>>>>>>",
    ];

    for (const input of inputs) {
      const nodes = parseStructural(input, {
        syntax,
        handlers,
        implicitInlineShorthand: true,
      });

      assert.equal(printStructural(nodes, { syntax }), input, input);
      assert.equal(nodes.length, 1, input);
      assert.equal(nodes[0]?.type, "text", input);
    }
  },
});

cases.push({
  name: "[Shorthand/Regression] malformed outer full-form should still salvage later complete full-form child",
  run: () => {
    for (const input of ["=bold<bold<=bold<111>=>>", "=bold<bold<bold<=bold<>=>>>"]) {
      const nodes = parseStructural(input, {
        syntax,
        handlers,
        implicitInlineShorthand: true,
      });

      assert.equal(printStructural(nodes, { syntax }), input, input);
      assert.equal(nodes.length, 3, input);
      assert.equal(nodes[0]?.type, "text", input);
      assert.equal(nodes[1]?.type, "inline", input);
      assert.equal((nodes[1] as { tag: string }).tag, "bold", input);
      assert.equal(nodes[2]?.type, "text", input);
    }
  },
});

cases.push({
  name: "[Shorthand/Regression] full-form container should ignore shorthand as scope boundary",
  run: () => {
    const input = "=bold<bold<bold<>>=";
    const nodes = parseStructural(input, {
      syntax,
      handlers,
      implicitInlineShorthand: true,
      trackPositions: false,
    });

    assert.deepEqual(nodes, [
      {
        type: "inline",
        tag: "bold",
        children: [
          { type: "text", value: "bold<" },
          { type: "inline", tag: "bold", children: [], implicitInlineShorthand: true },
        ],
      },
    ]);
    assert.equal(
      extractText(
        parseRichText(input, {
          syntax,
          handlers,
          implicitInlineShorthand: true,
        }),
      ),
      "bold<",
    );
  },
});

cases.push({
  name: "[Shorthand/Regression] nearest full-form container should define shorthand scope",
  run: () => {
    const input = "=bold<bold<bold<bold<bold<test2=bold2<bold<bold<bold<test1>>>>=>>>>>=";
    const nestedHandlers = createSimpleInlineHandlers(["bold", "bold2"]);
    const nodes = parseStructural(input, {
      syntax,
      handlers: nestedHandlers,
      implicitInlineShorthand: true,
      trackPositions: false,
    });

    assert.deepEqual(nodes, [
      {
        type: "inline",
        tag: "bold",
        children: [
          {
            type: "inline",
            tag: "bold",
            children: [
              {
                type: "inline",
                tag: "bold",
                children: [
                  {
                    type: "inline",
                    tag: "bold",
                    children: [
                      {
                        type: "inline",
                        tag: "bold",
                        children: [
                          { type: "text", value: "test2" },
                          {
                            type: "inline",
                            tag: "bold2",
                            children: [
                              {
                                type: "inline",
                                tag: "bold",
                                children: [
                                  {
                                    type: "inline",
                                    tag: "bold",
                                    children: [
                                      {
                                        type: "inline",
                                        tag: "bold",
                                        children: [{ type: "text", value: "test1" }],
                                        implicitInlineShorthand: true,
                                      },
                                    ],
                                    implicitInlineShorthand: true,
                                  },
                                ],
                                implicitInlineShorthand: true,
                              },
                            ],
                          },
                        ],
                        implicitInlineShorthand: true,
                      },
                    ],
                    implicitInlineShorthand: true,
                  },
                ],
                implicitInlineShorthand: true,
              },
            ],
            implicitInlineShorthand: true,
          },
        ],
      },
    ]);
    assert.equal(
      extractText(
        parseRichText(input, {
          syntax,
          handlers: nestedHandlers,
          implicitInlineShorthand: true,
        }),
      ),
      "test2test1",
    );
  },
});

cases.push({
  name: "[Shorthand/Regression] malformed shorthand should preserve escaped close tokens",
  run: () => {
    const samples = [
      {
        input: "=bold<~>=",
        expectedNodes: [
          { type: "text", value: "=bold<" },
          { type: "escape", raw: "~>=" },
        ],
        expectedText: "=bold<>=",
      },
      {
        input: "=bold<bold<=bold<~>=>>",
        expectedNodes: [
          { type: "text", value: "=bold<bold<" },
          { type: "text", value: "=bold<" },
          { type: "escape", raw: "~>=" },
          { type: "text", value: ">>" },
        ],
        expectedText: "=bold<bold<=bold<>=>>",
      },
    ] as const;

    for (const sample of samples) {
      const nodes = parseStructural(sample.input, {
        syntax: tildeEscapeSyntax,
        handlers,
        implicitInlineShorthand: true,
        trackPositions: false,
      });

      assert.deepEqual(nodes, sample.expectedNodes, sample.input);
      assert.equal(
        extractText(
          parseRichText(sample.input, {
            syntax: tildeEscapeSyntax,
            handlers,
            implicitInlineShorthand: true,
          }),
        ),
        sample.expectedText,
        sample.input,
      );
    }
  },
});

await runGoldenCases("Shorthand Behavior", "shorthand 行为矩阵 case", cases, { quietPasses: true });
