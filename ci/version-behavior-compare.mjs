import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CORE_CASES, CUSTOM_SYNTAX_CASES, ERROR_CASES, createCustomSyntax, makeHandlers, stripMeta } from "./shared.mjs";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {[string, unknown][]}
 */
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

  const latestMajorMinors = [...new Set(parsed.filter((entry) => entry.major === latest.major).map((entry) => entry.minor))]
    .sort((a, b) => a - b);

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
  const snapshot = {
    core: {},
    custom: {},
    onError: {},
    parser: {},
    positions: {},
  };

  for (const testCase of CORE_CASES) {
    const options = { handlers, ...testCase.opts };
    snapshot.core[testCase.name] = {
      parseRichText: stripMeta(mod.parseRichText(testCase.input, options)),
      stripRichText: mod.stripRichText(testCase.input, options),
      parseStructural: stripMeta(mod.parseStructural(testCase.input, options)),
    };
  }

  for (const testCase of CUSTOM_SYNTAX_CASES) {
    const options = { handlers, syntax };
    snapshot.custom[testCase.name] = {
      parseRichText: stripMeta(mod.parseRichText(testCase.input, options)),
      parseStructural: stripMeta(mod.parseStructural(testCase.input, options)),
    };
  }

  for (const testCase of ERROR_CASES) {
    const parseRichTextCodes = [];
    const stripRichTextCodes = [];
    const parseStructuralCodes = [];

    mod.parseRichText(testCase.input, {
      handlers,
      ...testCase.opts,
      onError: (error) => parseRichTextCodes.push(error.code),
    });
    mod.stripRichText(testCase.input, {
      handlers,
      ...testCase.opts,
      onError: (error) => stripRichTextCodes.push(error.code),
    });
    mod.parseStructural(testCase.input, {
      handlers,
      ...testCase.opts,
      onError: (error) => parseStructuralCodes.push(error.code),
    });

    snapshot.onError[testCase.name] = {
      parseRichText: parseRichTextCodes,
      stripRichText: stripRichTextCodes,
      parseStructural: parseStructuralCodes,
    };
  }

  for (const testCase of CORE_CASES.slice(0, 10)) {
    const parser = mod.createParser({ handlers });
    const options = testCase.opts ?? {};
    snapshot.parser[testCase.name] = {
      parse: stripMeta(parser.parse(testCase.input, options)),
      strip: parser.strip(testCase.input, options),
      structural: stripMeta(parser.structural(testCase.input, options)),
    };
  }

  for (const testCase of CORE_CASES.slice(0, 8)) {
    const options = { handlers, ...(testCase.opts ?? {}), trackPositions: true };
    snapshot.positions[testCase.name] = {
      parseRichText: stripMeta(mod.parseRichText(testCase.input, options), { keepPosition: true }),
      parseStructural: stripMeta(mod.parseStructural(testCase.input, options), { keepPosition: true }),
    };
  }

  return snapshot;
};

const knownExpectedDifferences = [
  {
    matcher: (entry) =>
      entry.section === "core" &&
      entry.caseName === "unclosed inline" &&
      entry.api === "parseStructural" &&
      entry.actualVersion.startsWith("1.3."),
    reason: "1.4 changed unclosed-inline structural fallback shape",
  },
  {
    matcher: (entry) =>
      entry.section === "core" &&
      entry.caseName === "unclosed inline" &&
      entry.api === "parseStructural" &&
      entry.actualVersion.startsWith("1.2."),
    reason: "1.4 changed unclosed-inline structural fallback shape",
  },
  {
    matcher: (entry) =>
      entry.section === "core" &&
      entry.caseName === "unclosed inline" &&
      entry.api === "parseStructural" &&
      entry.actualVersion.startsWith("1.1."),
    reason: "1.4 changed unclosed-inline structural fallback shape",
  },
];

const isKnownDifference = (entry) => knownExpectedDifferences.some((rule) => rule.matcher(entry));

const compareSnapshots = (baselineVersion, baseline, actualVersion, actual) => {
  const diffs = [];

  const compareObject = (sectionName, baselineObject, actualObject) => {
    for (const [caseName, baselineCase] of entriesOfRecord(baselineObject)) {
      const actualCase = isRecord(actualObject) ? actualObject[caseName] : undefined;
      if (!actualCase) {
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
  compareObject("onError", baseline.onError, actual.onError);
  compareObject("parser", baseline.parser, actual.parser);
  compareObject("positions", baseline.positions, actual.positions);

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
    const modulePath = await packAndExtract(packageName, version, tempRoot);
    const moduleUrl = pathToFileURL(modulePath).href;
    const imported = await import(moduleUrl);
    const snapshot = collectBehaviorSnapshot(imported);
    const diffs = compareSnapshots("workspace-dist", baselineSnapshot, version, snapshot);

    for (const diff of diffs) {
      if (isKnownDifference(diff)) {
        knownDiffs.push(diff);
      } else {
        unknownDiffs.push(diff);
      }
    }

    reports.push({
      version,
      diffCount: diffs.length,
    });
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
