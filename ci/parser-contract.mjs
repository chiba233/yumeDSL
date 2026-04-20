import * as mod from "../dist/index.js";
import { CORE_CASES, CUSTOM_SYNTAX_CASES, createCustomSyntax, makeHandlers, stripMeta } from "./shared.mjs";

const handlers = makeHandlers(mod);
const syntax = createCustomSyntax(mod);
const failures = [];

const recordFailure = (name, detail) => {
  failures.push({ name, detail });
  console.log(`FAIL  ${name}`);
};

const recordPass = (name) => {
  console.log(`PASS  ${name}`);
};

for (const testCase of CORE_CASES) {
  const opts = { handlers, ...testCase.opts };
  try {
    mod.parseRichText(testCase.input, opts);
    mod.stripRichText(testCase.input, opts);
    mod.parseStructural(testCase.input, opts);
    recordPass(`[core smoke] ${testCase.name}`);
  } catch (error) {
    recordFailure(`[core smoke] ${testCase.name}`, String(error?.stack ?? error));
  }
}

for (const testCase of CUSTOM_SYNTAX_CASES) {
  const opts = { handlers, syntax };
  try {
    mod.parseRichText(testCase.input, opts);
    mod.parseStructural(testCase.input, opts);
    recordPass(`[custom syntax smoke] ${testCase.name}`);
  } catch (error) {
    recordFailure(`[custom syntax smoke] ${testCase.name}`, String(error?.stack ?? error));
  }
}

try {
  const parser = mod.createParser({ handlers });
  const parsed = stripMeta(parser.parse("before $$bold(x)$$ after"));
  const stripped = parser.strip("before $$bold(x)$$ after");
  const structural = stripMeta(parser.structural("$$bold(hello"));
  const expectedParsed = [
    { type: "text", value: "before " },
    { type: "bold", value: [{ type: "text", value: "x" }] },
    { type: "text", value: " after" },
  ];
  const expectedStructural = [
    { type: "text", value: "$$bold(hello" },
  ];

  if (JSON.stringify(parsed) !== JSON.stringify(expectedParsed)) {
    recordFailure("[createParser contract] parse", { expected: expectedParsed, actual: parsed });
  } else {
    recordPass("[createParser contract] parse");
  }

  if (stripped !== "before x after") {
    recordFailure("[createParser contract] strip", { expected: "before x after", actual: stripped });
  } else {
    recordPass("[createParser contract] strip");
  }

  if (JSON.stringify(structural) !== JSON.stringify(expectedStructural)) {
    recordFailure("[createParser contract] structural unclosed inline", {
      expected: expectedStructural,
      actual: structural,
    });
  } else {
    recordPass("[createParser contract] structural unclosed inline");
  }
} catch (error) {
  recordFailure("[createParser contract] setup", String(error?.stack ?? error));
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true }, null, 2));
