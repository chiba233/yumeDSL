/**
 * Performance benchmark — covers all scenarios from zh-CN-性能.md / en-Performance.md.
 *
 * Usage: node --import tsx tests/bench.ts
 */

import {
  parseRichText,
  parseStructural,
  printStructural,
  buildZones,
  walkTokens,
  mapTokens,
  createSimpleInlineHandlers,
  type TextToken,
  type StructuralNode,
} from "../src/index.ts";
import { testHandlers } from "./handlers.ts";

// ── Input generators ──

const generateLargeDocument = (targetBytes: number): string => {
  const blocks = [
    "这是一段普通文本，用来填充文档体积。\n",
    "$$bold(加粗文本)$$和$$underline(下划线)$$混合。\n",
    "$$link(https://example.com|链接文本)$$后面跟普通文字。\n",
    "$$info(提示)*\n这是一个 block 标签的内容，包含$$bold(嵌套加粗)$$。\n*end$$\n",
    '$$raw-code(typescript|代码示例)%\nconst x = 1;\nconsole.log(x);\n%end$$\n',
    "$$bold($$thin($$underline(三层嵌套)$$)$$)$$是常见用法。\n",
    "$$collapse()*\n可折叠内容：$$code(const a = 42)$$。\n*end$$\n",
    "普通的一行文本，不包含任何标签。\n",
    "$$strike(删除线)$$、$$center(居中)$$和$$code(行内代码)$$。\n",
    "转义测试：\\$$不是标签\\$$，\\|也不是分隔符。\n",
  ];

  let doc = "";
  let idx = 0;
  while (Buffer.byteLength(doc, "utf8") < targetBytes) {
    doc += blocks[idx % blocks.length];
    idx++;
  }
  return doc;
};

const makeNestedInline = (depth: number): string => {
  let text = "x";
  for (let i = 0; i < depth; i++) text = `$$bold(${text})$$`;
  return text;
};

// ── Benchmark harness ──

const bench = (name: string, fn: () => void, rounds = 3, perRound = 5): number => {
  // warmup
  for (let i = 0; i < 2; i++) fn();

  const times: number[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < perRound; i++) {
      const start = performance.now();
      fn();
      times.push(performance.now() - start);
    }
  }
  times.sort((a, b) => a - b);
  // trim outliers: drop top/bottom 20%
  const trim = Math.floor(times.length * 0.2);
  const trimmed = times.slice(trim, times.length - trim);
  return trimmed.reduce((s, t) => s + t, 0) / trimmed.length;
};

const fmt = (ms: number): string => {
  if (ms < 1) return `~${(ms * 1000).toFixed(0)} µs`;
  return `~${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
};

// ── Generate inputs ──

console.log("Generating inputs...");

const largeDoc = generateLargeDocument(200_000);
const docBytes = Buffer.byteLength(largeDoc, "utf8");
console.log(`  Large document: ${docBytes.toLocaleString()} bytes`);

const deepInput5000 = makeNestedInline(5000);
console.log(`  Deep nesting (5000 layers): ${deepInput5000.length.toLocaleString()} chars`);

// ── Section 1: 日常文档基准 ──

console.log("\n=== 日常文档基准 (~200 KB) ===\n");

const structuralNodes: StructuralNode[] = [];
const richTokens: TextToken[] = [];

const msStructural = bench("parseStructural", () => {
  const r = parseStructural(largeDoc, { handlers: testHandlers });
  if (!structuralNodes.length) structuralNodes.push(...r);
});
console.log(`  parseStructural:           ${fmt(msStructural)}`);

const msRichText = bench("parseRichText", () => {
  const r = parseRichText(largeDoc, { handlers: testHandlers });
  if (!richTokens.length) richTokens.push(...r);
});
console.log(`  parseRichText:             ${fmt(msRichText)}`);

console.log(`  (${structuralNodes.length} structural nodes, ${richTokens.length} tokens)`);

// ── Section 2: 位置追踪开销 ──

console.log("\n=== 位置追踪开销 ===\n");

const msStructuralPos = bench("parseStructural+pos", () => {
  parseStructural(largeDoc, { handlers: testHandlers, trackPositions: true });
});
console.log(`  parseStructural (no pos):  ${fmt(msStructural)}`);
console.log(`  parseStructural (pos):     ${fmt(msStructuralPos)}`);
console.log(`  overhead:                  ~${(((msStructuralPos / msStructural) - 1) * 100).toFixed(0)}%`);

const msRichTextPos = bench("parseRichText+pos", () => {
  parseRichText(largeDoc, { handlers: testHandlers, trackPositions: true });
});
console.log(`  parseRichText (no pos):    ${fmt(msRichText)}`);
console.log(`  parseRichText (pos):       ${fmt(msRichTextPos)}`);
console.log(`  overhead:                  ~${(((msRichTextPos / msRichText) - 1) * 100).toFixed(0)}%`);

// ── Section 3: 轻量工具操作 ──

console.log("\n=== 轻量工具操作 ===\n");

const nodesWithPos = parseStructural(largeDoc, { handlers: testHandlers, trackPositions: true });
const tokensForWalk = parseRichText(largeDoc, { handlers: testHandlers });

const msPrint = bench("printStructural", () => {
  printStructural(nodesWithPos);
});
console.log(`  printStructural:           ${fmt(msPrint)}`);

const msZones = bench("buildZones", () => {
  buildZones(nodesWithPos);
});
const zones = buildZones(nodesWithPos);
console.log(`  buildZones:                ${fmt(msZones)} (${zones.length} zones)`);

let walkCount = 0;
const msWalk = bench("walkTokens", () => {
  walkCount = 0;
  walkTokens(tokensForWalk, () => { walkCount++; });
});
console.log(`  walkTokens:                ${fmt(msWalk)} (${walkCount} visits)`);

const msMapIdentity = bench("mapTokens identity", () => {
  mapTokens(tokensForWalk, (t) => t);
});
console.log(`  mapTokens (identity):      ${fmt(msMapIdentity)}`);

const msMapTransform = bench("mapTokens transform", () => {
  mapTokens(tokensForWalk, (t) => (t.type === "bold" ? { ...t, type: "strong" } : t));
});
console.log(`  mapTokens (bold→strong):   ${fmt(msMapTransform)}`);

// ── Section 4: 病理深嵌套 ──

console.log("\n=== 病理深嵌套 (5000 layers, depthLimit: 6000) ===\n");

const deepHandlers = createSimpleInlineHandlers(["bold"]);
const deepOpts = { handlers: deepHandlers, depthLimit: 6000 } as const;

const msDeepStructural = bench("parseStructural(5000)", () => {
  parseStructural(deepInput5000, deepOpts);
}, 1, 3);
console.log(`  parseStructural(5000):     ${fmt(msDeepStructural)}`);

const msDeepRichText = bench("parseRichText(5000)", () => {
  parseRichText(deepInput5000, deepOpts);
}, 1, 3);
console.log(`  parseRichText(5000):       ${fmt(msDeepRichText)}`);

console.log("\nDone.");
