import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { runGoldenCases } from "./testHarness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distEntryUrl = pathToFileURL(resolve(repoRoot, "dist/index.js")).href;

interface SnippetResult {
  stdout: string;
  stderr: string;
}

const runSnippet = async (body: string): Promise<SnippetResult> => {
  const tempDir = mkdtempSync(resolve(repoRoot, ".tmp-deprecations-"));
  const workerPath = resolve(tempDir, "worker.mjs");
  const workerCode = `
    import { parentPort } from "node:worker_threads";

    const captured = [];
    const stdout = [];

    console.warn = (...args) => {
      captured.push(args.join(" "));
    };

    process.stderr.write = ((chunk) => {
      captured.push(String(chunk));
      return true;
    });

    process.stdout.write = ((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    try {
      const mod = await import(${JSON.stringify(distEntryUrl)});
      ${body}
      parentPort.postMessage({ stdout: stdout.join(""), stderr: captured.join("") });
    } catch (error) {
      parentPort.postMessage({
        stdout: stdout.join(""),
        stderr: captured.join(""),
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "Error", message: String(error), stack: String(error) },
      });
    }
  `;

  writeFileSync(workerPath, workerCode, "utf8");

  try {
    return await new Promise<SnippetResult>((resolveRun, rejectRun) => {
      const worker = new Worker(pathToFileURL(workerPath));

      worker.once("message", (message: unknown) => {
        void worker.terminate();

        const payload = message as SnippetResult & {
          error?: { name: string; message: string; stack?: string };
        };

        if (payload.error) {
          rejectRun(
            new Error(
              [
                `${payload.error.name}: ${payload.error.message}`,
                payload.error.stack,
                payload.stderr,
                payload.stdout,
              ].filter(Boolean).join("\n"),
            ),
          );
          return;
        }

        resolveRun({ stdout: payload.stdout, stderr: payload.stderr });
      });

      worker.once("error", (error) => {
        void worker.terminate();
        rejectRun(error);
      });

      worker.once("exit", (code) => {
        if (code !== 0) {
          rejectRun(new Error(`Worker exited with code ${code}.`));
        }
      });
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const countWarnings = (stderr: string, pattern: string): number =>
  stderr.split(pattern).length - 1;

const captureWarnings = async (run: () => Promise<void> | void): Promise<string> => {
  const captured: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await run();
  } finally {
    process.stderr.write = originalWrite;
  }

  return captured.join("");
};

const cases = [
  {
    name: "[Deprecations] 默认 parseRichText -> 不应向正常用户输出弃用告警",
    run: async () => {
      const { stderr } = await runSnippet(`
        const {createSimpleInlineHandlers, parseRichText} = mod;
        parseRichText("$$bold(hi)$$", { handlers: createSimpleInlineHandlers(["bold"]) });
      `);

      assert.equal(stderr.includes("[yume-dsl-rich-text] Deprecated:"), false);
    },
  },
  {
    name: "[Deprecations] 默认 parseStructural -> 不应向正常用户输出弃用告警",
    run: async () => {
      const { stderr } = await runSnippet(`
        const {parseStructural} = mod;
        parseStructural("$$bold(hi)$$");
      `);

      assert.equal(stderr.includes("[yume-dsl-rich-text] Deprecated:"), false);
    },
  },
  {
    name: "[Deprecations] withSyntax + parseStructural -> 应当只对 syntax compat 路径各告警一次",
    run: async () => {
      const { stderr } = await runSnippet(`
        const {createSyntax, parseStructural, withSyntax} = mod;
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
    name: "[Deprecations] withTagNameConfig + parseStructural -> 应当只对 tagName compat 路径各告警一次",
    run: async () => {
      const { stderr } = await runSnippet(`
        const {createTagNameConfig, parseStructural, withTagNameConfig} = mod;
        const tagName = createTagNameConfig({
          isTagStartChar: (c) => /[a-zA-Z_0-9]/.test(c),
        });

        withTagNameConfig(tagName, () => {
          parseStructural("$$1tag(hi)$$");
          parseStructural("$$1tag(ho)$$");
        });
      `);

      assert.equal(
        countWarnings(stderr, "withTagNameConfig() is deprecated. Pass tagName via ParseOptions instead."),
        1,
      );
      assert.equal(
        countWarnings(
          stderr,
          "parseStructural() is reading ambient withTagNameConfig(). Pass tagName explicitly via options.tagName instead.",
        ),
        1,
      );
    },
  },
  {
    name: "[Deprecations] getSyntax -> 直接调用只应告警一次",
    run: async () => {
      const { stderr } = await runSnippet(`
        const {getSyntax} = mod;
        getSyntax();
        getSyntax();
      `);

      assert.equal(
        countWarnings(stderr, "getSyntax() is deprecated. Use DslContext.syntax instead."),
        1,
      );
    },
  },
  {
    name: "[Deprecations] resetTokenIdSeed -> 同一进程内重复调用只应告警一次",
    run: async () => {
      const { stderr } = await runSnippet(`
        const {resetTokenIdSeed} = mod;
        resetTokenIdSeed();
        resetTokenIdSeed();
      `);

      assert.equal(
        countWarnings(stderr, "resetTokenIdSeed() is deprecated. Use DslContext.createId instead."),
        1,
      );
    },
  },
  {
    name: "[Deprecations] withCreateId -> 直接调用只应告警一次",
    run: async () => {
      const stderr = await captureWarnings(async () => {
        const { createToken, withCreateId } = await import("../src/handlerBuilders/createToken.ts");
        withCreateId(() => "fixed-id", () => {
          createToken({ type: "text", value: "a" });
          createToken({ type: "text", value: "b" });
        });
      });

      assert.equal(
        countWarnings(stderr, "withCreateId() is deprecated. Pass createId via DslContext instead."),
        1,
      );
    },
  },
  {
    name: "[Deprecations] production 环境 -> 应当抑制弃用告警",
    run: async () => {
      const { stderr } = await runSnippet(`
        process.env.NODE_ENV = "production";
        const {getSyntax} = mod;
        getSyntax();
      `);

      assert.equal(stderr.includes("[yume-dsl-rich-text] Deprecated:"), false);
    },
  },
  {
    name: "[Deprecations] stderr.write 缺失 -> 应当回退到 console.warn",
    run: async () => {
      const { stderr } = await runSnippet(`
        process.stderr.write = undefined;
        const {getSyntax} = mod;
        getSyntax();
      `);

      assert.equal(stderr.includes("getSyntax() is deprecated. Use DslContext.syntax instead."), true);
    },
  },
  {
    name: "[Deprecations] stderr.write 抛错 -> 应当回退到 console.warn",
    run: async () => {
      const { stderr } = await runSnippet(`
        process.stderr.write = (() => { throw new Error("stderr boom"); });
        const {getSyntax} = mod;
        getSyntax();
      `);

      assert.equal(stderr.includes("getSyntax() is deprecated. Use DslContext.syntax instead."), true);
    },
  },
  {
    name: "[Deprecations] suppress 选项 -> 应当跳过告警输出",
    run: async () => {
      const stderr = await captureWarnings(async () => {
        const { warnDeprecated } = await import("../src/internal/deprecations.ts");
        warnDeprecated("suppressed-case", "should stay quiet", { suppress: true });
      });

      assert.equal(stderr.includes("should stay quiet"), false);
    },
  },
];

await runGoldenCases("Deprecations", " deprecation warning case", cases);
