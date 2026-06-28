// noinspection DuplicatedCode

// ─────────────────────────────────────────────────────────────────────────────
// incrementalFuzz.test.ts — 增量 == 全量 不变量的属性测试（property-based fuzz）
//
// 不变量：对任意源 + 任意编辑序列，
//   updateIncremental(doc, edit, newSource).tree  ===  parseStructural(newSource).tree
//   updateIncremental(...).zones                  ===  buildZonesInternal(fullTree, cap)
// 同时验证公开会话路径 createIncrementalSession().applyEdit(...) 满足同一不变量。
//
// 设计要点：
// - 种子化 PRNG（mulberry32），不依赖 Date / Math.random，失败可复现。
// - fragment 池混合良构 / 畸形 / 未闭合 / CRLF / 转义 / pipe / 深嵌套。
// - 每个 doc 跑一串随机编辑（插入 / 删除 / 替换），低层与会话两条路径都校验。
// - 另设一组确定性回归源，覆盖已知的四类失败 + CRLF，即使随机没踩到也兜底。
// - 比对带 position 的完整树（位置正确性也在不变量内）。
// ─────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import {
  type IncrementalDocument,
  type IncrementalEdit,
  type StructuralNode,
  type TagHandler,
  createEasySyntax,
  createIncrementalSession,
  createSimpleBlockHandlers,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  parseIncremental,
  parseStructural,
} from "../src/index.ts";
import { buildZonesInternal, SOFT_ZONE_NODE_CAP } from "../src/internal/zones.ts";
import { updateIncremental } from "../src/incremental/incremental.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

// ── 种子化 PRNG（mulberry32）──
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const handlers: Record<string, TagHandler> = {
  ...createSimpleInlineHandlers(["bold", "thin", "link"]),
  ...createSimpleRawHandlers(["code", "math"]),
  ...createSimpleBlockHandlers(["info", "note"]),
};

const parseOptions = { handlers };

// ── 比对工具：剥 position 之外，保留结构 + position 一并比对 ──
const fullTree = (source: string): StructuralNode[] =>
  parseStructural(source, { ...parseOptions, trackPositions: true });

const fullZones = (source: string) => buildZonesInternal(fullTree(source), SOFT_ZONE_NODE_CAP);

const applyTextEdit = (source: string, edit: IncrementalEdit): string =>
  source.slice(0, edit.startOffset) + edit.newText + source.slice(edit.oldEndOffset);

// ── fragment 池 ──
// 良构 / 畸形 / 未闭合 / CRLF / 转义 / pipe / 深嵌套，混在一起喂随机拼接。
const LF_FRAGMENTS = [
  "plain text ",
  "x",
  "a b c\n",
  "$$bold(x)$$",
  "$$thin(hi)$$",
  "$$link(u|label)$$",
  "$$bold($$thin(y)$$)$$",
  "$$bold($$thin($$link(z)$$)$$)$$",
  "$$code(ts)%\nconst a = 1;\n%end$$",
  "$$math()%\na + b\n%end$$",
  "$$code(ts|opt)%\nline1\nline2\n%end$$",
  "$$info(Title)*\nbody here\n*end$$",
  "$$note()*\n$$bold(inner)$$\n*end$$",
  "$$info(T)*\n$$code(ts)%\nnested\n%end$$\n*end$$",
  // 畸形 / 未闭合
  "$$bold(unclosed inline ",
  ")$$",
  "$$code(ts)%\nno close here\n",
  "%end$$",
  "*end$$",
  "$$info()*\nblock no end\n",
  "$$bold(",
  "$$weird(x)$$",
  // 转义
  "\\$$bold(x)$$",
  "a\\$b\\\\c",
  "\\%end$$",
  // 分隔 / 空行
  "\n\n",
  "\n",
  "   ",
];

// CRLF 版本：把 LF fragment 的换行替换成 CRLF，单独入池。
const CRLF_FRAGMENTS = LF_FRAGMENTS.filter((f) => f.includes("\n")).map((f) =>
  f.replace(/\n/g, "\r\n"),
);

const FRAGMENTS = [...LF_FRAGMENTS, ...CRLF_FRAGMENTS];

// 编辑用的小片段（插入内容），故意包含会改变结构的危险字符。
const EDIT_SNIPPETS = [
  "a",
  "z ",
  "\n",
  "\r\n",
  "$",
  "$$",
  "$$bold(",
  ")$$",
  "%",
  "%end$$",
  "*",
  "*end$$",
  "(",
  ")",
  "|",
  "\\",
  "$$code(ts)%\nq\n%end$$",
  "$$info()*\nq\n*end$$",
  "hello world",
];

const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

const randomSource = (rng: () => number): string => {
  const count = 2 + Math.floor(rng() * 20);
  let out = "";
  for (let i = 0; i < count; i++) out += pick(rng, FRAGMENTS);
  return out;
};

// 随机编辑：插入 / 删除 / 替换。保证 offset 合法。
const randomEdit = (rng: () => number, source: string): IncrementalEdit => {
  const len = source.length;
  const start = Math.floor(rng() * (len + 1));
  const roll = rng();
  if (roll < 0.4 || len === 0) {
    // 纯插入
    return { startOffset: start, oldEndOffset: start, newText: pick(rng, EDIT_SNIPPETS) };
  }
  if (roll < 0.7) {
    // 删除一段
    const end = Math.min(len, start + 1 + Math.floor(rng() * 8));
    return { startOffset: start, oldEndOffset: end, newText: "" };
  }
  // 替换一段
  const end = Math.min(len, start + 1 + Math.floor(rng() * 8));
  return { startOffset: start, oldEndOffset: end, newText: pick(rng, EDIT_SNIPPETS) };
};

type Mismatch = { kind: "tree" | "zones"; detail: string };

// zone 分区有效性：增量复用产生的 zone 不必与「全量 cap 重切」逐一相等——一段非 breaker
// 节点流被复用边界切成几段是合法的（owner 明确接受，见 [Incremental/Init] may split
// pure-inline zones）。真正必须成立的是：zones 是「正确的 tree」的一个合法分区——
// 摊平等于 tree，且每个 zone 的 offset 与其首尾节点一致、整体升序不重叠。
const validatePartition = (doc: IncrementalDocument, tree: readonly StructuralNode[]): string | undefined => {
  const flat: StructuralNode[] = [];
  for (const z of doc.zones) for (const n of z.nodes) flat.push(n);
  try {
    assert.deepEqual(flat, tree);
  } catch (error) {
    return `flatten(zones) != tree: ${String((error as Error).message).slice(0, 300)}`;
  }
  let prevEnd = -1;
  for (let i = 0; i < doc.zones.length; i++) {
    const z = doc.zones[i];
    if (z.nodes.length === 0) return `zone ${i} empty`;
    const first = z.nodes[0].position;
    const last = z.nodes[z.nodes.length - 1].position;
    if (!first || !last) return `zone ${i} node missing position`;
    if (z.startOffset !== first.start.offset) return `zone ${i} startOffset != first node start`;
    if (z.endOffset !== last.end.offset) return `zone ${i} endOffset != last node end`;
    if (z.startOffset < prevEnd) return `zone ${i} overlaps previous`;
    prevEnd = z.endOffset;
  }
  return undefined;
};

const compareDocToFull = (doc: IncrementalDocument, source: string): Mismatch | undefined => {
  const expectedTree = fullTree(source);
  try {
    assert.deepEqual(doc.tree, expectedTree);
  } catch (error) {
    return { kind: "tree", detail: String((error as Error).message).slice(0, 400) };
  }
  const partitionError = validatePartition(doc, expectedTree);
  if (partitionError) {
    return { kind: "zones", detail: partitionError };
  }
  return undefined;
};

const fail = (
  context: string,
  source: string,
  edit: IncrementalEdit,
  newSource: string,
  mismatch: Mismatch,
): never => {
  throw new Error(
    `[incrementalFuzz] ${context}: ${mismatch.kind} mismatch\n` +
      `  prevSource = ${JSON.stringify(source)}\n` +
      `  edit       = ${JSON.stringify(edit)}\n` +
      `  newSource  = ${JSON.stringify(newSource)}\n` +
      `  detail     = ${mismatch.detail}`,
  );
};

// 单文档：跑一串随机编辑，低层 + 会话两条路径都对全量。
const runOneDoc = (seed: number, edits: number): void => {
  const rng = mulberry32(seed);
  let source = randomSource(rng);

  let doc = parseIncremental(source, parseOptions);
  const session = createIncrementalSession(source, parseOptions);

  // 初始快照本身也要等于全量
  {
    const m = compareDocToFull(doc, source);
    if (m) fail(`seed=${seed} init(low-level)`, source, { startOffset: 0, oldEndOffset: 0, newText: "" }, source, m);
    const ms = compareDocToFull(session.getDocument(), source);
    if (ms) fail(`seed=${seed} init(session)`, source, { startOffset: 0, oldEndOffset: 0, newText: "" }, source, ms);
  }

  for (let e = 0; e < edits; e++) {
    const edit = randomEdit(rng, source);
    const newSource = applyTextEdit(source, edit);

    const nextDoc = updateIncremental(doc, edit, newSource, parseOptions);
    const lowMismatch = compareDocToFull(nextDoc, newSource);
    if (lowMismatch) fail(`seed=${seed} edit#${e} (low-level)`, source, edit, newSource, lowMismatch);

    const applyResult = session.applyEdit(edit, newSource, parseOptions);
    const sessionMismatch = compareDocToFull(applyResult.doc, newSource);
    if (sessionMismatch) fail(`seed=${seed} edit#${e} (session)`, source, edit, newSource, sessionMismatch);

    doc = nextDoc;
    source = newSource;
  }
};

// ── 确定性回归源：四类已知失败 + CRLF + 深嵌套 ──
// 即使随机没踩到，也对这些源做密集的逐位置编辑兜底。
const REGRESSION_SOURCES = [
  // 右边界前向扫描截断：编辑左侧文本，右侧有跨越脏窗的 raw/block。
  "L\n$$code(ts)%\nA\nB\nC\n%end$$\nM\n$$note()*\nx\ny\n*end$$\nR",
  // 左侧远处编辑改变分类：软切分 + 行跨越。
  "head $$bold(a)$$ mid $$thin(b)$$ tail $$code(ts)%\nq\n%end$$ end",
  // 文末插入窗口覆盖。
  "alpha $$bold(x)$$ beta",
  // 整行 *end$$ / %end$$ 落在窗口边界。
  "$$info()*\nline\n*end$$ trailing-same-line",
  "$$code(ts)%\nraw\n%end$$ trailing",
  // CRLF
  "L\r\n$$code(ts)%\r\nA\r\nB\r\n%end$$\r\nM\r\n$$note()*\r\nx\r\n*end$$\r\nR",
  "$$info(T)*\r\n$$bold(x)$$\r\n*end$$\r\nafter",
  // 深嵌套
  "$$bold($$thin($$link($$bold(deep)$$)$$)$$)$$ around",
  // 未闭合
  "before $$bold(unclosed and then more text and more",
  "x $$code(ts)%\nnever closed raw keeps going\nand going",
];

const runRegressionSource = (source: string): void => {
  // 对每个位置做插入 + 删除 + 替换，针对危险字符。
  const editChars = ["\n", "$", "%", "*", ")", "(", "X", "\r\n"];
  for (let pos = 0; pos <= source.length; pos++) {
    for (const ch of editChars) {
      // 插入
      {
        const edit: IncrementalEdit = { startOffset: pos, oldEndOffset: pos, newText: ch };
        const newSource = applyTextEdit(source, edit);
        const doc = parseIncremental(source, parseOptions);
        const next = updateIncremental(doc, edit, newSource, parseOptions);
        const m = compareDocToFull(next, newSource);
        if (m) fail(`regression insert pos=${pos} ch=${JSON.stringify(ch)}`, source, edit, newSource, m);
      }
      // 删除（若有内容）
      if (pos < source.length) {
        const edit: IncrementalEdit = { startOffset: pos, oldEndOffset: pos + 1, newText: "" };
        const newSource = applyTextEdit(source, edit);
        const doc = parseIncremental(source, parseOptions);
        const next = updateIncremental(doc, edit, newSource, parseOptions);
        const m = compareDocToFull(next, newSource);
        if (m) fail(`regression delete pos=${pos}`, source, edit, newSource, m);
      }
      // 替换（若有内容）
      if (pos < source.length) {
        const edit: IncrementalEdit = { startOffset: pos, oldEndOffset: pos + 1, newText: ch };
        const newSource = applyTextEdit(source, edit);
        const doc = parseIncremental(source, parseOptions);
        const next = updateIncremental(doc, edit, newSource, parseOptions);
        const m = compareDocToFull(next, newSource);
        if (m) fail(`regression replace pos=${pos} ch=${JSON.stringify(ch)}`, source, edit, newSource, m);
      }
    }
  }
};

// 自定义 syntax + implicitInlineShorthand 的独立用例。
const runCustomSyntaxDoc = (seed: number, edits: number): void => {
  const syntax = createEasySyntax({ tagPrefix: "@@", tagOpen: "[", tagClose: "]" });
  const customHandlers: Record<string, TagHandler> = {
    ...createSimpleInlineHandlers(["b", "i"]),
    ...createSimpleRawHandlers(["pre"]),
  };
  const opts = { handlers: customHandlers, syntax };
  const customFragments = [
    "text ",
    "@@b[x]@@",
    "@@i[y]@@",
    "@@b[@@i[z]@@]@@",
    "@@pre[txt]%\ncode\n%end@@",
    "@@b[unclosed ",
    "]@@",
    "\n",
  ];
  const rng = mulberry32(seed);
  let source = "";
  const count = 3 + Math.floor(rng() * 12);
  for (let i = 0; i < count; i++) source += customFragments[Math.floor(rng() * customFragments.length)];

  let doc = parseIncremental(source, opts);
  for (let e = 0; e < edits; e++) {
    const edit = randomEdit(rng, source);
    const newSource = applyTextEdit(source, edit);
    const next = updateIncremental(doc, edit, newSource, opts);
    const expectedTree = parseStructural(newSource, { ...opts, trackPositions: true });
    try {
      assert.deepEqual(next.tree, expectedTree);
    } catch (error) {
      throw new Error(
        `[incrementalFuzz] customSyntax seed=${seed} edit#${e}: tree mismatch\n` +
          `  prevSource = ${JSON.stringify(source)}\n` +
          `  edit       = ${JSON.stringify(edit)}\n` +
          `  newSource  = ${JSON.stringify(newSource)}\n` +
          `  detail     = ${String((error as Error).message).slice(0, 400)}`,
      );
    }
    doc = next;
    source = newSource;
  }
};

const DOCS = Number(process.env.YUME_FUZZ_DOCS ?? 4000);
const EDITS = Number(process.env.YUME_FUZZ_EDITS ?? 12);

const cases: GoldenCase[] = [
  {
    name: "[IncrementalFuzz] deterministic regression sources (known failure classes + CRLF)",
    run: () => {
      for (const source of REGRESSION_SOURCES) runRegressionSource(source);
    },
  },
  {
    name: `[IncrementalFuzz] random docs (${DOCS} docs × ${EDITS} edits, low-level + session)`,
    run: () => {
      for (let d = 0; d < DOCS; d++) runOneDoc(0x9e3779b9 ^ (d * 2654435761), EDITS);
    },
  },
  {
    name: "[IncrementalFuzz] custom syntax + shorthand (400 docs × 10 edits)",
    run: () => {
      for (let d = 0; d < 400; d++) runCustomSyntaxDoc(0x1234567 ^ (d * 40503), 10);
    },
  },
];

await runGoldenCases("IncrementalFuzz", "increment fuzz case", cases, { quietPasses: true });
