import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  CORE_CASES,
  CUSTOM_SYNTAX_CASES,
  ERROR_CASES,
  SHORTHAND_CASES,
  createCustomSyntax,
  makeHandlers,
  stripMeta,
} from "./shared.mjs";

/** @param {unknown} value */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const entriesOfRecord = (value) => (isRecord(value) ? Object.entries(value) : []);

const parseSemver = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: value,
  };
};

const npmViewVersions = (packageName) => {
  const raw = execFileSync("npm", ["view", packageName, "versions", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string") return [parsed];
  throw new Error(`unexpected npm view response: ${raw.slice(0, 200)}`);
};

const selectLatestPatchByMinor = (versions, major, minor) => {
  const candidates = versions
    .map(parseSemver)
    .filter((entry) => entry !== null && entry.major === major && entry.minor === minor)
    .sort((left, right) => left.patch - right.patch);

  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1].version;
};

const computeTargetVersions = (allVersions) => {
  const parsed = allVersions.map(parseSemver).filter((entry) => entry !== null);
  if (parsed.length === 0) throw new Error("no strict semver versions found on npm");

  const latest = parsed.reduce((max, cur) => {
    if (cur.major !== max.major) return cur.major > max.major ? cur : max;
    if (cur.minor !== max.minor) return cur.minor > max.minor ? cur : max;
    if (cur.patch !== max.patch) return cur.patch > max.patch ? cur : max;
    return max;
  });

  const latestMajorMinors = [...new Set(parsed.filter((entry) => entry.major === latest.major).map((entry) => entry.minor))].sort(
    (a, b) => a - b,
  );

  const targetMinors = latestMajorMinors.slice(-3);
  if (targetMinors.length < 3) {
    throw new Error(`need at least 3 published minors on npm for major ${latest.major}`);
  }

  const selected = targetMinors.map((minor) => {
    const version = selectLatestPatchByMinor(allVersions, latest.major, minor);
    if (!version) throw new Error(`cannot find published patch for ${latest.major}.${minor}.x on npm`);
    return version;
  });

  return {
    latestPublishedVersion: latest.version,
    selectedVersions: selected,
  };
};

const packAndExtract = async (packageName, version, tempRoot) => {
  const workDir = await fs.mkdtemp(path.join(tempRoot, `pack-${version.replace(/\./g, "_")}-`));
  const packRaw = execFileSync("npm", ["pack", `${packageName}@${version}`, "--json"], {
    cwd: workDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const packJson = JSON.parse(packRaw);
  const tarballName = Array.isArray(packJson) ? packJson[0]?.filename : null;
  if (!tarballName) throw new Error(`cannot resolve tarball filename for ${version}`);

  const tarballPath = path.join(workDir, tarballName);
  const extractDir = path.join(workDir, "extracted");
  await fs.mkdir(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const modulePath = path.join(extractDir, "package", "dist", "index.js");
  await fs.access(modulePath);
  return modulePath;
};

const collectBehaviorSnapshot = (mod) => {
  const handlers = makeHandlers(mod);
  const syntax = createCustomSyntax(mod);
  const normalizeIncrementalDoc = (doc) => ({
    source: doc.source,
    tree: stripMeta(doc.tree),
    zones: doc.zones.map((zone) => ({
      startOffset: zone.startOffset,
      endOffset: zone.endOffset,
      nodes: stripMeta(zone.nodes),
    })),
  });
  const buildEditedSource = (source, edit) => source.slice(0, edit.startOffset) + edit.newText + source.slice(edit.oldEndOffset);
  const incrementalCases = [
    {
      name: "inline replace",
      source: "A $$bold(hello)$$ B",
      edit: { startOffset: 9, oldEndOffset: 14, newText: "world" },
    },
    {
      name: "insert nested inline",
      source: "start $$info(Tip)*\nline\n*end$$ end",
      edit: { startOffset: 6, oldEndOffset: 6, newText: "$$bold(+)$$ " },
    },
  ];

  const safe = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };

  const snapshot = {
    core: {},
    custom: {},
    shorthand: {},
    onError: {},
    parser: {},
    positions: {},
    incremental: {},
  };

  for (const testCase of CORE_CASES) {
    const options = { handlers, ...testCase.opts };
    snapshot.core[testCase.name] = {
      parseRichText: safe(() => stripMeta(mod.parseRichText(testCase.input, options))),
      stripRichText: safe(() => mod.stripRichText(testCase.input, options)),
      parseStructural: safe(() => stripMeta(mod.parseStructural(testCase.input, options))),
    };
  }

  for (const testCase of CUSTOM_SYNTAX_CASES) {
    const options = { handlers, syntax };
    snapshot.custom[testCase.name] = {
      parseRichText: safe(() => stripMeta(mod.parseRichText(testCase.input, options))),
      parseStructural: safe(() => stripMeta(mod.parseStructural(testCase.input, options))),
    };
  }

  for (const testCase of SHORTHAND_CASES) {
    const options = { handlers, ...(testCase.opts ?? {}), implicitInlineShorthand: true };
    snapshot.shorthand[testCase.name] = {
      parseRichText: safe(() => stripMeta(mod.parseRichText(testCase.input, options))),
      stripRichText: safe(() => mod.stripRichText(testCase.input, options)),
      parseStructural: safe(() => stripMeta(mod.parseStructural(testCase.input, options))),
    };
  }

  for (const testCase of ERROR_CASES) {
    const parseRichTextCodes = [];
    const stripRichTextCodes = [];
    const parseStructuralCodes = [];

    safe(() =>
      mod.parseRichText(testCase.input, {
        handlers,
        ...testCase.opts,
        onError: (error) => parseRichTextCodes.push(error.code),
      }),
    );
    safe(() =>
      mod.stripRichText(testCase.input, {
        handlers,
        ...testCase.opts,
        onError: (error) => stripRichTextCodes.push(error.code),
      }),
    );
    safe(() =>
      mod.parseStructural(testCase.input, {
        handlers,
        ...testCase.opts,
        onError: (error) => parseStructuralCodes.push(error.code),
      }),
    );

    snapshot.onError[testCase.name] = {
      parseRichText: { ok: true, value: parseRichTextCodes },
      stripRichText: { ok: true, value: stripRichTextCodes },
      parseStructural: { ok: true, value: parseStructuralCodes },
    };
  }

  for (const testCase of CORE_CASES.slice(0, 10)) {
    const parserResult = safe(() => mod.createParser({ handlers }));
    const options = testCase.opts ?? {};
    if (!parserResult.ok) {
      snapshot.parser[testCase.name] = {
        parse: parserResult,
        strip: parserResult,
        structural: parserResult,
      };
      continue;
    }
    const parser = parserResult.value;
    snapshot.parser[testCase.name] = {
      parse: safe(() => stripMeta(parser.parse(testCase.input, options))),
      strip: safe(() => parser.strip(testCase.input, options)),
      structural: safe(() => stripMeta(parser.structural(testCase.input, options))),
    };
  }

  for (const testCase of CORE_CASES.slice(0, 8)) {
    const options = { handlers, ...(testCase.opts ?? {}), trackPositions: true };
    snapshot.positions[testCase.name] = {
      parseRichText: safe(() => stripMeta(mod.parseRichText(testCase.input, options), { keepPosition: true })),
      parseStructural: safe(() => stripMeta(mod.parseStructural(testCase.input, options), { keepPosition: true })),
    };
  }

  const hasIncrementalApi =
    typeof mod.parseIncremental === "function" && typeof mod.createIncrementalSession === "function";
  if (!hasIncrementalApi) {
    snapshot.incremental.__unsupported__ = { ok: true, value: true };
    return snapshot;
  }

  const supportsApplyEditWithDiff = (() => {
    const probe = safe(() => mod.createIncrementalSession("x", { handlers }, { strategy: "incremental-only" }));
    if (!probe.ok) return false;
    return typeof probe.value.applyEditWithDiff === "function";
  })();

  for (const testCase of incrementalCases) {
    const parseOptions = { handlers };
    const newSource = buildEditedSource(testCase.source, testCase.edit);

    const parseIncrementalResult = safe(() => normalizeIncrementalDoc(mod.parseIncremental(testCase.source, parseOptions)));
    const sessionResult = safe(() =>
      mod.createIncrementalSession(testCase.source, parseOptions, {
        strategy: "incremental-only",
      }),
    );

    if (!sessionResult.ok) {
      snapshot.incremental[testCase.name] = {
        parseIncremental: parseIncrementalResult,
        applyEdit: sessionResult,
      };
      continue;
    }

    const session = sessionResult.value;
    const applyEditResult = safe(() => session.applyEdit(testCase.edit, newSource));
    const normalizedApplyEdit = applyEditResult.ok
      ? {
          ok: true,
          value: {
            mode: applyEditResult.value.mode,
            fallbackReason: applyEditResult.value.fallbackReason ?? null,
            doc: normalizeIncrementalDoc(applyEditResult.value.doc),
          },
        }
      : applyEditResult;

    snapshot.incremental[testCase.name] = {
      parseIncremental: parseIncrementalResult,
      applyEdit: normalizedApplyEdit,
    };

    if (supportsApplyEditWithDiff && typeof session.applyEditWithDiff === "function") {
      const applyEditWithDiffResult = safe(() => session.applyEditWithDiff(testCase.edit, newSource));
      snapshot.incremental[testCase.name].applyEditWithDiff = applyEditWithDiffResult.ok
        ? {
            ok: true,
            value: {
              mode: applyEditWithDiffResult.value.mode,
              fallbackReason: applyEditWithDiffResult.value.fallbackReason ?? null,
              doc: normalizeIncrementalDoc(applyEditWithDiffResult.value.doc),
            },
          }
        : applyEditWithDiffResult;
    }
  }

  return snapshot;
};

const knownExpectedDifferences = [
  {
    matcher: (entry) =>
      (entry.section === "core" || entry.section === "parser") &&
      entry.caseName === "unclosed inline" &&
      (entry.api === "parseStructural" || entry.api === "structural") &&
      entry.actualVersion.startsWith("1.3."),
    reason: "1.4 changed unclosed-inline structural fallback shape",
  },
  {
    matcher: (entry) =>
      (entry.section === "core" || entry.section === "parser") &&
      entry.caseName === "unclosed inline" &&
      (entry.api === "parseStructural" || entry.api === "structural") &&
      entry.actualVersion.startsWith("1.2."),
    reason: "1.4 changed unclosed-inline structural fallback shape",
  },
  {
    matcher: (entry) =>
      (entry.section === "core" || entry.section === "parser") &&
      entry.caseName === "unclosed inline" &&
      (entry.api === "parseStructural" || entry.api === "structural") &&
      entry.actualVersion.startsWith("1.1."),
    reason: "1.4 changed unclosed-inline structural fallback shape",
  },
  {
    matcher: (entry) =>
      entry.section === "shorthand" &&
      entry.api === "parseStructural" &&
      entry.actualVersion.startsWith("1.3."),
    reason: "1.4 changed shorthand structural degradation shape",
  },
  {
    matcher: (entry) =>
      entry.section === "shorthand" &&
      entry.api === "parseStructural" &&
      entry.actualVersion.startsWith("1.2."),
    reason: "1.4 changed shorthand structural degradation shape",
  },
];

const isKnownDifference = (entry) => knownExpectedDifferences.some((rule) => rule.matcher(entry));

const compareSnapshots = (baselineVersion, baseline, actualVersion, actual) => {
  const diffs = [];

  const compareObject = (sectionName, baselineObject, actualObject) => {
    for (const [caseName, baselineCase] of entriesOfRecord(baselineObject)) {
      const actualCase = isRecord(actualObject) ? actualObject[caseName] : undefined;
      if (!actualCase) {
        if (sectionName === "incremental") continue;
        diffs.push({
          section: sectionName,
          caseName,
          api: "__case__",
          baselineVersion,
          actualVersion,
          baseline: baselineCase,
          actual: null,
        });
        continue;
      }

      for (const [api, baselineValue] of entriesOfRecord(baselineCase)) {
        if (sectionName === "incremental" && isRecord(actualCase) && !(api in actualCase)) {
          continue;
        }
        const actualValue = isRecord(actualCase) ? actualCase[api] : undefined;
        if (JSON.stringify(baselineValue) !== JSON.stringify(actualValue)) {
          diffs.push({
            section: sectionName,
            caseName,
            api,
            baselineVersion,
            actualVersion,
            baseline: baselineValue,
            actual: actualValue,
          });
        }
      }
    }
  };

  compareObject("core", baseline.core, actual.core);
  compareObject("custom", baseline.custom, actual.custom);
  compareObject("shorthand", baseline.shorthand, actual.shorthand);
  compareObject("onError", baseline.onError, actual.onError);
  compareObject("parser", baseline.parser, actual.parser);
  compareObject("positions", baseline.positions, actual.positions);
  compareObject("incremental", baseline.incremental, actual.incremental);

  return diffs;
};

const main = async () => {
  const packageName = "yume-dsl-rich-text";
  const allVersions = npmViewVersions(packageName);
  const { latestPublishedVersion, selectedVersions } = computeTargetVersions(allVersions);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yume-dsl-version-ci-"));

  const currentModulePath = new URL("../dist/index.js", import.meta.url);
  const currentModule = await import(currentModulePath);
  const baselineSnapshot = collectBehaviorSnapshot(currentModule);

  const reports = [];
  const unknownDiffs = [];
  const knownDiffs = [];

  for (const version of selectedVersions) {
    try {
      const modulePath = await packAndExtract(packageName, version, tempRoot);
      const moduleUrl = pathToFileURL(modulePath).href;
      const imported = await import(moduleUrl);
      const snapshot = collectBehaviorSnapshot(imported);
      const diffs = compareSnapshots("workspace-dist", baselineSnapshot, version, snapshot);

      for (const diff of diffs) {
        if (isKnownDifference(diff)) knownDiffs.push(diff);
        else unknownDiffs.push(diff);
      }

      reports.push({ version, diffCount: diffs.length });
    } catch (error) {
      unknownDiffs.push({
        section: "__runner__",
        caseName: "import-or-collect",
        api: "version-run",
        baselineVersion: "workspace-dist",
        actualVersion: version,
        baseline: null,
        actual: String(error?.message ?? error),
      });
      reports.push({ version, diffCount: 0, error: String(error?.message ?? error) });
    }
  }

  const summary = {
    package: packageName,
    latestPublishedVersion,
    comparedPublishedVersions: selectedVersions,
    reports,
    knownDiffCount: knownDiffs.length,
    unknownDiffCount: unknownDiffs.length,
  };

  if (unknownDiffs.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          summary,
          unknownDiffs: unknownDiffs.slice(0, 50),
          knownDiffs: knownDiffs.slice(0, 20),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        summary,
        knownDiffs: knownDiffs.slice(0, 20),
      },
      null,
      2,
    ),
  );
};

await main();
