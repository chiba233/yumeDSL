import assert from "node:assert/strict";
import {
  createParser,
  createSimpleInlineHandlers,
  createSimpleBlockHandlers,
  createSimpleRawHandlers,
  declareMultilineTags,
  parseStructural,
  buildZones,
} from "../src/index.ts";
import type { Zone, StructuralNode } from "../src/index.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

// ── Shared setup ──

const handlers = {
  ...createSimpleInlineHandlers(["bold", "italic"]),
  ...createSimpleRawHandlers(["code"]),
  ...createSimpleBlockHandlers(["note"]),
};

const parse = (source: string) =>
  parseStructural(source, { handlers, trackPositions: true });

// ── Cases ──

const cases: GoldenCase[] = [
  {
    name: "[Zone/Basic] 纯文本 + inline 应合并为一个 zone",
    run: () => {
      const zones = buildZones(parse("hello $$bold(world)$$ end"));
      assert.equal(zones.length, 1);
      assert.equal(zones[0].nodes.length, 3); // text, inline, text
    },
  },
  {
    name: "[Zone/Breaker] raw/block 应独占 zone",
    run: () => {
      const zones = buildZones(parse("text\n$$code(ts)%\nx\n%end$$\nmid\n$$note()*\ny\n*end$$\nend"));
      // zones: [text], [raw:code], [text], [block:note], [text]
      assert.equal(zones.length, 5);
      assert.equal(zones[0].nodes[0].type, "text");
      assert.equal(zones[1].nodes[0].type, "raw");
      assert.equal(zones[2].nodes[0].type, "text");
      assert.equal(zones[3].nodes[0].type, "block");
      assert.equal(zones[4].nodes[0].type, "text");
    },
  },
  {
    name: "[Zone/Boundary] zone 边界应与节点 position 对齐",
    run: () => {
      const zones = buildZones(parse("a\n$$code(ts)%\nx\n%end$$\nb"));
      for (const zone of zones) {
        const firstPos = zone.nodes[0].position!;
        const lastPos = zone.nodes[zone.nodes.length - 1].position!;
        assert.equal(zone.startOffset, firstPos.start.offset);
        assert.equal(zone.endOffset, lastPos.end.offset);
      }
    },
  },
  {
    name: "[Zone/Coverage] zone 应无缝覆盖（无间隙、无重叠）",
    run: () => {
      const zones = buildZones(
        parse("a $$bold(b)$$ c\n$$code(ts)%\nx\n%end$$\nd\n$$note()*\ny\n*end$$\ne"),
      );
      for (let i = 1; i < zones.length; i++) {
        assert.equal(
          zones[i].startOffset,
          zones[i - 1].endOffset,
          `gap between zone ${i - 1} and ${i}`,
        );
      }
    },
  },
  {
    name: "[Zone/Empty] 空输入应返回空数组",
    run: () => {
      assert.equal(buildZones(parse("")).length, 0);
    },
  },
  {
    name: "[Zone/NoPosition] 无 position 的节点应被跳过",
    run: () => {
      // parseStructural without trackPositions → no position
      const tree = parseStructural("$$bold(x)$$", { handlers });
      const zones = buildZones(tree);
      assert.equal(zones.length, 0);
    },
  },
  {
    name: "[Zone/OnlyBreakers] 连续 raw/block 之间的文本归入非 breaker zone",
    run: () => {
      // raw \n block → [raw] [text:\n] [block]
      const zones = buildZones(parse("$$code(a)%\nx\n%end$$\n$$note()*\ny\n*end$$"));
      assert.equal(zones.length, 3);
      assert.equal(zones[0].nodes[0].type, "raw");
      assert.equal(zones[1].nodes[0].type, "text");
      assert.equal(zones[2].nodes[0].type, "block");
    },
  },
  {
    name: "[Zone/Type] Zone 类型应可导入且字段完整",
    run: () => {
      const zones: Zone[] = buildZones(parse("$$code(ts)%\nx\n%end$$"));
      const z = zones[0];
      assert.equal(typeof z.startOffset, "number");
      assert.equal(typeof z.endOffset, "number");
      assert.ok(Array.isArray(z.nodes));
    },
  },
];

await runGoldenCases("Zone", "zone case", cases);
