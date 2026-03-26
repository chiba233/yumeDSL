import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGoldenCases } from "./testHarness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const cases = [
  {
    name: "[Types] helper 返回类型与 ParseOptions/TagForm 约束 -> 应当通过编译检查",
    run: () => {
      assert.doesNotThrow(() => {
        execFileSync("./node_modules/.bin/tsc", ["-p", "./tests/tsconfig.types.json", "--noEmit"], {
          cwd: repoRoot,
          stdio: "pipe",
        });
      });
    },
  },
];

await runGoldenCases("Type Check", " Type check case", cases);
