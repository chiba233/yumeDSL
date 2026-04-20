// noinspection JSUnresolvedReference

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  COMPAT_CASES,
  CORE_CASES,
  CUSTOM_SYNTAX_CASES,
  ERROR_CASES,
  SHORTHAND_CASES,
  createCustomSyntax,
  makeHandlers,
  normalizeDiff,
  normalizeDoc,
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
  const buildEditedSource = (source, edit) => source.slice(0, edit.startOffset) + edit.newText + source.slice(edit.oldEndOffset);
  const walkSource = "A $$bold(x|y)$$ $$code(z)$$ $$thin($$underline(u)$$)$$";
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
    {
      name: "full-only strategy fallback",
      source: "$$bold(x)$$",
      edit: { startOffset: 7, oldEndOffset: 8, newText: "y" },
      sessionOptions: { strategy: "full-only" },
    },
    {
      name: "auto maxEditRatio fallback",
      source: "abcdef\n$$code(ts)%\nX\n%end$$\n123456",
      edit: { startOffset: 0, oldEndOffset: 6, newText: "ZZZZZZZZZZ" },
      sessionOptions: { strategy: "auto", maxEditRatioForIncremental: 0.05 },
    },
    {
      name: "parse option fingerprint fallback",
      source: "$$bold(x)$$\n$$code(ts)%\nA\n%end$$",
      edit: { startOffset: 7, oldEndOffset: 8, newText: "y" },
      parseOptions: {
        handlers,
        allowForms: ["inline", "raw", "block"],
      },
      overrideOptions: {
        handlers,
        allowForms: ["inline"],
      },
    },
  ];

  const safe = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };
  const parserProbe =
    typeof mod.createParser === "function" ? safe(() => mod.createParser({ handlers })) : { ok: false, error: "unsupported" };
  const supportsParser =
    parserProbe.ok &&
    typeof parserProbe.value.parse === "function" &&
    typeof parserProbe.value.strip === "function" &&
    typeof parserProbe.value.structural === "function";
  const supportsExtractText = typeof mod.extractText === "function";
  const supportsWalkTokens = typeof mod.walkTokens === "function";
  const supportsMapTokens = typeof mod.mapTokens === "function";
  const supportsBuildZones = typeof mod.buildZones === "function";

  const snapshot = {
    core: {},
    compat: {},
    custom: {},
    shorthand: {},
    onError: {},
    parser: {},
    positions: {},
    helpers: {},
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

  for (const testCase of COMPAT_CASES) {
    const options = { handlers, ...(testCase.opts ?? {}) };
    snapshot.compat[testCase.name] = {
      parseRichText: safe(() => stripMeta(mod.parseRichText(testCase.input, options))),
      stripRichText: safe(() => mod.stripRichText(testCase.input, options)),
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

  if (supportsParser) {
    const parser = parserProbe.value;
    for (const testCase of CORE_CASES.slice(0, 10)) {
      const options = testCase.opts ?? {};
      snapshot.parser[testCase.name] = {
        parse: safe(() => stripMeta(parser.parse(testCase.input, options))),
        strip: safe(() => parser.strip(testCase.input, options)),
        structural: safe(() => stripMeta(parser.structural(testCase.input, options))),
      };
    }
  }

  for (const testCase of CORE_CASES.slice(0, 8)) {
    const options = { handlers, ...(testCase.opts ?? {}), trackPositions: true };
    snapshot.positions[testCase.name] = {
      parseRichText: safe(() => stripMeta(mod.parseRichText(testCase.input, options), { keepPosition: true })),
      parseStructural: safe(() => stripMeta(mod.parseStructural(testCase.input, options), { keepPosition: true })),
    };
  }

  if (supportsExtractText) {
    snapshot.helpers.extractText = safe(() => {
      const tokens = mod.parseRichText("before $$bold(x)$$ $$code(y)$$ after", { handlers });
      return mod.extractText(tokens);
    });
  }

  if (supportsWalkTokens) {
    snapshot.helpers.walkTokens = safe(() => {
      const visits = [];
      const tokens = mod.parseRichText(walkSource, { handlers });
      mod.walkTokens(tokens, (token, ctx) => {
        visits.push({
          type: token.type,
          depth: ctx.depth,
          index: ctx.index,
          parent: ctx.parent?.type ?? null,
          value: typeof token.value === "string" ? token.value : `[${token.value.length}]`,
        });
      });
      return visits;
    });
  }

  if (supportsMapTokens) {
    snapshot.helpers.mapTokens = safe(() => {
      const tokens = mod.parseRichText(walkSource, { handlers });
      return stripMeta(
        mod.mapTokens(tokens, (token) => {
          if (token.type === "code") return null;
          if (token.type === "text" && typeof token.value === "string") {
            return { ...token, value: token.value.toUpperCase() };
          }
          return token;
        }),
      );
    });
  }

  if (supportsBuildZones) {
    snapshot.helpers.buildZones = safe(() => {
      const tree = mod.parseStructural("a $$bold(x)$$\n$$raw-code(ts)%\nX\n%end$$\n$$info()*\nB\n*end$$", {
        handlers,
        trackPositions: true,
      });
      return mod.buildZones(tree).map((zone) => ({
        startOffset: zone.startOffset,
        endOffset: zone.endOffset,
        nodeTypes: zone.nodes.map((node) => node.type),
      }));
    });
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
  const supportsFullOnly = safe(() => mod.createIncrementalSession("x", { handlers }, { strategy: "full-only" })).ok;
  const supportsAutoMaxEditRatio = safe(() =>
    mod.createIncrementalSession("abcdef", { handlers }, { strategy: "auto", maxEditRatioForIncremental: 0.05 }),
  ).ok;
  const supportsOverrideOptions = (() => {
    const probe = safe(() => mod.createIncrementalSession("$$bold(x)$$", { handlers }, { strategy: "incremental-only" }));
    if (!probe.ok) return false;
    if (typeof probe.value.applyEdit !== "function") return false;
    if (probe.value.applyEdit.length >= 3) return true;
    return safe(() =>
      probe.value.applyEdit(
        { startOffset: 7, oldEndOffset: 8, newText: "y" },
        "$$bold(y)$$",
        { handlers, allowForms: ["inline"] },
      ),
    ).ok;
  })();

  for (const testCase of incrementalCases) {
    if (testCase.name === "full-only strategy fallback" && !supportsFullOnly) continue;
    if (testCase.name === "auto maxEditRatio fallback" && !supportsAutoMaxEditRatio) continue;
    if (testCase.name === "parse option fingerprint fallback" && !supportsOverrideOptions) continue;

    const parseOptions = testCase.parseOptions ?? { handlers };
    const newSource = buildEditedSource(testCase.source, testCase.edit);

    const parseIncrementalResult = safe(() => normalizeDoc(mod.parseIncremental(testCase.source, parseOptions)));
    const sessionResult = safe(() =>
      mod.createIncrementalSession(
        testCase.source,
        parseOptions,
        testCase.sessionOptions ?? {
          strategy: "incremental-only",
        },
      ),
    );

    if (!sessionResult.ok) {
      snapshot.incremental[testCase.name] = {
        parseIncremental: parseIncrementalResult,
        applyEdit: sessionResult,
      };
      continue;
    }

    const session = sessionResult.value;
    const applyEditResult = safe(() => session.applyEdit(testCase.edit, newSource, testCase.overrideOptions));
    const normalizedApplyEdit = applyEditResult.ok
      ? {
          ok: true,
          value: {
            mode: applyEditResult.value.mode,
            fallbackReason: applyEditResult.value.fallbackReason ?? null,
            doc: normalizeDoc(applyEditResult.value.doc),
          },
        }
      : applyEditResult;

    snapshot.incremental[testCase.name] = {
      parseIncremental: parseIncrementalResult,
      applyEdit: normalizedApplyEdit,
    };

    if (supportsApplyEditWithDiff && typeof session.applyEditWithDiff === "function") {
      const applyEditWithDiffResult = safe(() =>
        session.applyEditWithDiff(testCase.edit, newSource, testCase.overrideOptions),
      );
      snapshot.incremental[testCase.name].applyEditWithDiff = applyEditWithDiffResult.ok
        ? {
            ok: true,
            value: {
              mode: applyEditWithDiffResult.value.mode,
              fallbackReason: applyEditWithDiffResult.value.fallbackReason ?? null,
              doc: normalizeDoc(applyEditWithDiffResult.value.doc),
              diff: normalizeDiff(applyEditWithDiffResult.value.diff),
            },
          }
        : applyEditWithDiffResult;
    }
  }

  return snapshot;
};

const KNOWN_DIFF_RULES = [
  {
    id: "structural-unclosed-inline-shape",
    reason: "workspace-dist changed unclosed-inline structural fallback shape",
    sections: ["core", "parser"],
    caseNames: ["unclosed inline"],
    apis: ["parseStructural", "structural"],
    actualVersionPattern: /^1\.(2|3|4)\./,
  },
  {
    id: "structural-shorthand-degradation-shape",
    reason: "workspace-dist changed shorthand structural degradation shape",
    sections: ["shorthand"],
    caseNames: [
      "simple shorthand",
      "nested shorthand",
      "shorthand with trailing text",
      "unclosed shorthand",
    ],
    apis: ["parseStructural"],
    actualVersionPattern: /^1\.(2|3|4)\./,
  },
];

const matchesKnownDiffRule = (entry, rule) =>
  rule.sections.includes(entry.section) &&
  rule.caseNames.includes(entry.caseName) &&
  rule.apis.includes(entry.api) &&
  rule.actualVersionPattern.test(entry.actualVersion);

const findKnownDiffRule = (entry) => KNOWN_DIFF_RULES.find((rule) => matchesKnownDiffRule(entry, rule)) ?? null;

const formatJsonInline = (value) => JSON.stringify(value);
const formatDiffKey = (entry) => `${entry.actualVersion} | ${entry.section} / ${entry.caseName} / ${entry.api}`;

const printKnownDiffStats = (knownDiffs) => {
  if (knownDiffs.length === 0) {
    console.log("[version-behavior] 已知差异: 0");
    return;
  }

  const counts = {};
  for (const diff of knownDiffs) {
    const rule = findKnownDiffRule(diff);
    const key = rule ? `${rule.id}: ${rule.reason}` : "unknown-rule";
    counts[key] = (counts[key] ?? 0) + 1;
  }

  console.log("[version-behavior] 已知差异统计:");
  for (const [label, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${label} => ${count}`);
  }
};

const printUnknownDiffReport = (summary, unknownDiffs) => {
  console.error(`[version-behavior] 发现未知差异 ${unknownDiffs.length} 条，比较已失败`);
  console.error(
    `[version-behavior] 包 ${summary.package}; 对比版本: ${summary.comparedPublishedVersions.join(", ")}; 最新发布: ${summary.latestPublishedVersion}`,
  );
  console.error(`[version-behavior] ${summary.testedText}`);

  const grouped = {};
  for (const diff of unknownDiffs) {
    const group = `${diff.actualVersion} | ${diff.section}`;
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(diff);
  }

  for (const [group, diffs] of Object.entries(grouped)) {
    console.error(`\n[version-behavior] ${group}: ${diffs.length} 条`);
    for (const [index, diff] of diffs.slice(0, 20).entries()) {
      console.error(`  ${index + 1}. ${formatDiffKey(diff)}`);
      console.error(`     baseline(${diff.baselineVersion}): ${formatJsonInline(diff.baseline)}`);
      console.error(`     actual(${diff.actualVersion}): ${formatJsonInline(diff.actual)}`);
    }
    if (diffs.length > 20) {
      console.error(`     ... 其余 ${diffs.length - 20} 条未展开`);
    }
  }
};

const compareSnapshots = (baselineVersion, baseline, actualVersion, actual) => {
  const diffs = [];

  const compareObject = (sectionName, baselineObject, actualObject) => {
    for (const [caseName, baselineCase] of entriesOfRecord(baselineObject)) {
      const actualCase = isRecord(actualObject) ? actualObject[caseName] : undefined;
      if (!actualCase) {
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
  compareObject("compat", baseline.compat, actual.compat);
  compareObject("custom", baseline.custom, actual.custom);
  compareObject("shorthand", baseline.shorthand, actual.shorthand);
  compareObject("onError", baseline.onError, actual.onError);
  compareObject("parser", baseline.parser, actual.parser);
  compareObject("positions", baseline.positions, actual.positions);
  compareObject("helpers", baseline.helpers, actual.helpers);
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
  const baselineHelperApis = Object.keys(baselineSnapshot.helpers);
  const baselineParserCases = Object.keys(baselineSnapshot.parser).length;
  const baselineIncrementalEntries = Object.entries(baselineSnapshot.incremental).filter(([key]) => key !== "__unsupported__");
  const baselineIncrementalCases = baselineIncrementalEntries.length;
  const supportsIncrementalDiff = baselineIncrementalEntries.some(([, entry]) => isRecord(entry) && "applyEditWithDiff" in entry);
  const testedSections = [
    { section: "core", cases: CORE_CASES.length, apis: ["parseRichText", "stripRichText", "parseStructural"] },
    { section: "compat", cases: COMPAT_CASES.length, apis: ["parseRichText", "stripRichText", "parseStructural"] },
    { section: "custom", cases: CUSTOM_SYNTAX_CASES.length, apis: ["parseRichText", "parseStructural"] },
    {
      section: "shorthand",
      cases: SHORTHAND_CASES.length,
      apis: ["parseRichText", "stripRichText", "parseStructural(implicitInlineShorthand=true)"],
    },
    { section: "onError", cases: ERROR_CASES.length, apis: ["onError(parse/strip/structural)"] },
    ...(baselineParserCases > 0
      ? [{ section: "parser", cases: baselineParserCases, apis: ["createParser.parse/strip/structural"] }]
      : []),
    { section: "positions", cases: Math.min(8, CORE_CASES.length), apis: ["trackPositions(parse/structural)"] },
    ...(baselineHelperApis.length > 0
      ? [{ section: "helpers", cases: baselineHelperApis.length, apis: baselineHelperApis }]
      : []),
    ...(baselineIncrementalCases > 0
      ? [
          {
            section: "incremental",
            cases: baselineIncrementalCases,
            apis: supportsIncrementalDiff
              ? ["parseIncremental", "createIncrementalSession.applyEdit", "applyEditWithDiff"]
              : ["parseIncremental", "createIncrementalSession.applyEdit"],
          },
        ]
      : []),
  ];
  const testedTotalCases = testedSections.reduce((sum, item) => sum + item.cases, 0);
  const testedText = `已测试分区: ${testedSections
    .map((item) => `${item.section}(${item.cases})`)
    .join(", ")}; 总用例 ${testedTotalCases}`;

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
        if (findKnownDiffRule(diff)) knownDiffs.push(diff);
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
    testedText,
    testedSections,
    testedTotalCases,
    reports,
    knownDiffCount: knownDiffs.length,
    unknownDiffCount: unknownDiffs.length,
  };

  console.log(`[version-behavior] ${testedText}`);
  printKnownDiffStats(knownDiffs);

  if (unknownDiffs.length > 0) {
    printUnknownDiffReport(summary, unknownDiffs);
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
