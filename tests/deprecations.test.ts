import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGoldenCases } from "./testHarness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const runSnippet = (code: string): { stdout: string; stderr: string } => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", code],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        `Snippet execution failed with status ${result.status ?? "unknown"}.`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const countWarnings = (stderr: string, pattern: string): number =>
  stderr.split(pattern).length - 1;

const cases = [
  {
    name: "[Deprecations] 默认 parseRichText -> 不应向正常用户输出弃用告警",
    run: () => {
      const { stderr } = runSnippet(`
        import {createSimpleInlineHandlers, parseRichText} from "./src/index.ts";
        parseRichText("$$bold(hi)$$", { handlers: createSimpleInlineHandlers(["bold"]) });
      `);

      assert.equal(stderr.includes("[yume-dsl-rich-text] Deprecated:"), false);
    },
  },
  {
    name: "[Deprecations] 默认 parseStructural -> 不应向正常用户输出弃用告警",
    run: () => {
      const { stderr } = runSnippet(`
        import {parseStructural} from "./src/index.ts";
        parseStructural("$$bold(hi)$$");
      `);

      assert.equal(stderr.includes("[yume-dsl-rich-text] Deprecated:"), false);
    },
  },
  {
    name: "[Deprecations] withSyntax + parseStructural -> 应当只对 compat 路径告警且同 key 只报一次",
    run: () => {
      const { stderr } = runSnippet(`
        import {createSyntax, parseStructural, withSyntax} from "./src/index.ts";
        const syntax = createSyntax({
          tagPrefix: "@@",
          tagOpen: "<<",
          tagClose: ">>",
          tagDivider: "||",
          endTag: ">>@@",
          rawOpen: ">>%",
          blockOpen: ">>*",
          rawClose: "%end@@",
          blockClose: "*end@@",
          escapeChar: "~",
        });

        withSyntax(syntax, () => {
          parseStructural("@@tag<<x>>@@");
          parseStructural("@@tag<<y>>@@");
        });
      `);

      assert.equal(
        countWarnings(stderr, "withSyntax() is deprecated. Pass syntax via ParseOptions or DslContext instead."),
        1,
      );
      assert.equal(
        countWarnings(
          stderr,
          "parseStructural() is reading ambient withSyntax(). Pass syntax explicitly via options.syntax instead.",
        ),
        1,
      );
    },
  },
  {
    name: "[Deprecations] resetTokenIdSeed -> 同一进程内重复调用只应告警一次",
    run: () => {
      const { stderr } = runSnippet(`
        import {resetTokenIdSeed} from "./src/index.ts";
        resetTokenIdSeed();
        resetTokenIdSeed();
      `);

      assert.equal(
        countWarnings(stderr, "resetTokenIdSeed() is deprecated. Use DslContext.createId instead."),
        1,
      );
    },
  },
];

await runGoldenCases("Deprecations", " deprecation warning case", cases);
