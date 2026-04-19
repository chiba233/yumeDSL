import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runGoldenCases } from "./testHarness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const configPath = resolve(repoRoot, "tests", "tsconfig.types.dist.json");

const runTypecheck = () => {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program);
};

await runGoldenCases("Type Check Dist", " Type check dist case", [
  {
    name: "[Types/Dist] dist 导出类型约束 -> 应当通过编译检查",
    run: () => {
      const diagnostics = runTypecheck();
      assert.equal(
        diagnostics.length,
        0,
        "TypeScript dist typecheck failed.\n" +
          ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: (fileName) => fileName,
            getCurrentDirectory: () => repoRoot,
            getNewLine: () => "\n",
          }),
      );
    },
  },
]);
