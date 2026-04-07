import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGoldenCases } from "./testHarness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const tscJs = resolve(repoRoot, "node_modules", "typescript", "bin", "tsc");

const cases = [
  {
    name: "[Types] helper 返回类型与 ParseOptions/TagForm 约束 -> 应当通过编译检查",
    run: () => {
      const result = spawnSync(
        process.execPath,
        [tscJs, "-p", "./tests/tsconfig.types.json", "--noEmit"],
        {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf8",
        },
      );

      assert.equal(
        result.status,
        0,
        ["TypeScript typecheck failed.", result.stdout, result.stderr].filter(Boolean).join("\n"),
      );
    },
  },
];

await runGoldenCases("Type Check", " Type check case", cases);
