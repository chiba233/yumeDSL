import * as mod from "../dist/index.js";
import { ERROR_CASES, expectedOnErrorByApi, makeHandlers } from "./shared.mjs";

const apis = [
  { name: "parseRichText", call: (input, opts) => mod.parseRichText(input, opts) },
  { name: "stripRichText", call: (input, opts) => mod.stripRichText(input, opts) },
  { name: "parseStructural", call: (input, opts) => mod.parseStructural(input, opts) },
];

const failures = [];
const summary = {};

for (const api of apis) {
  const rows = [];
  for (const testCase of ERROR_CASES) {
    const codes = [];
    api.call(testCase.input, {
      handlers: makeHandlers(mod),
      ...testCase.opts,
      onError: (error) => codes.push(error.code),
    });

    const expected = expectedOnErrorByApi[api.name][testCase.name] ?? [];
    const ok = JSON.stringify(codes) === JSON.stringify(expected);
    rows.push({ name: testCase.name, codes, expected, ok });
    if (!ok) {
      failures.push({
        api: api.name,
        name: testCase.name,
        expected,
        actual: codes,
      });
    }
  }
  summary[api.name] = rows;
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures, summary }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, summary }, null, 2));
