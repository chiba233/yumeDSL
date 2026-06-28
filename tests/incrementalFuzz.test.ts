// noinspection DuplicatedCode

/**
 * Property-based fuzz test for the core incremental invariant:
 *
 *   updateIncremental(doc, edit, newSource).tree  ===  parseStructural(newSource).tree
 *
 * i.e. an incremental update MUST produce exactly the tree a full reparse would,
 * over randomly generated documents and randomly generated edit sequences.
 *
 * Why tree-only (not zones): `parseIncremental` may legitimately split pure-inline
 * runs into finer zones than `buildZones(parseStructural(...))` (see the
 * "[Incremental/Init] ... may split pure-inline zones" case in incremental.test.ts),
 * so zone arrays can validly differ in granularity. The tree (with positions) is the
 * contract consumers actually depend on, so that is the oracle here.
 *
 * Determinism: a seeded PRNG (no Math.random / Date) makes every iteration
 * reproducible. On failure the seed + source + failing edit are printed so the exact
 * case can be replayed.
 */

import assert from "node:assert/strict";
import {
  type TagHandler,
  buildZones,
  createSimpleBlockHandlers,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  parseIncremental,
  parseStructural,
} from "../src/index.ts";
import { updateIncremental } from "../src/incremental/incremental.ts";
import { runGoldenCases, type GoldenCase } from "./testHarness.ts";

const handlers: Record<string, TagHandler> = {
  ...createSimpleInlineHandlers(["bold", "thin", "link"]),
  ...createSimpleRawHandlers(["code", "math"]),
  ...createSimpleBlockHandlers(["info", "note"]),
};

const parseFull = (source: string) => {
  const tree = parseStructural(source, { handlers, trackPositions: true });
  return { tree, zones: buildZones(tree) };
};

const applyEditStr = (source: string, start: number, end: number, text: string): string =>
  source.slice(0, start) + text + source.slice(end);

// mulberry32 — small deterministic PRNG (no Math.random, so runs are reproducible).
const makeRng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

// Mix of well-formed forms (inline / raw / block / nested) and deliberately malformed
// fragments (unclosed heads, stray closers) to stress the error-recovery paths.
const FRAGMENTS: readonly string[] = [
  "plain words ",
  "more text here\n",
  "\n\n",
  "$$bold(x)$$",
  "$$thin(a b c)$$",
  "$$link(http://e.com|click)$$",
  "$$bold($$thin(deep)$$)$$",
  "$$code(ts)%\nconst x = 1;\n%end$$",
  "$$math()%\nE = mc^2\n%end$$",
  "$$info(Title)*\nbody $$bold(y)$$ tail\n*end$$",
  "$$note()*\nnested para\n*end$$",
  // malformed / partial:
  "$$bold(unclosed inline ",
  ")$$ ",
  "$$weird(",
  "%end$$ ",
  "*end$$ ",
  "$$code(ts)%\nno terminator ",
];

const INSERTS: readonly string[] = [
  "",
  "x",
  " word ",
  "\n",
  "$$bold(z)$$",
  "$$thin(q)$$",
  "$$code(t)%\nq\n%end$$",
  ")$$",
  "$$note()*\n",
  "%end$$",
  "$$bold(",
];

const randomDoc = (rng: () => number): string => {
  const count = 4 + Math.floor(rng() * 18);
  let s = "";
  for (let i = 0; i < count; i++) s += pick(rng, FRAGMENTS);
  return s;
};

const randomEdit = (rng: () => number, source: string) => {
  const len = source.length;
  const startOffset = Math.floor(rng() * (len + 1));
  const maxDelete = Math.min(len - startOffset, 14);
  const oldEndOffset = startOffset + Math.floor(rng() * (maxDelete + 1));
  const newText = rng() < 0.6 ? pick(rng, INSERTS) : pick(rng, FRAGMENTS);
  return { startOffset, oldEndOffset, newText };
};

const cases: GoldenCase[] = [
  {
    name: "[Incremental/Fuzz] random edit sequences: updateIncremental tree must equal full reparse",
    run: () => {
      const DOCS = 300;
      const EDITS_PER_DOC = 10;
      let checks = 0;

      for (let d = 0; d < DOCS; d++) {
        // Deterministic per-doc seed derived from the index (no Date/random).
        const seed = (0x9e3779b9 ^ Math.imul(d + 1, 2654435761)) >>> 0;
        const rng = makeRng(seed);

        let source = randomDoc(rng);
        let lastEdit: { startOffset: number; oldEndOffset: number; newText: string } | null = null;

        try {
          let doc = parseIncremental(source, { handlers });
          // initial parse must already equal a full parse
          assert.deepEqual(doc.tree, parseFull(source).tree);
          checks++;

          for (let e = 0; e < EDITS_PER_DOC; e++) {
            const edit = randomEdit(rng, source);
            lastEdit = edit;
            const newSource = applyEditStr(source, edit.startOffset, edit.oldEndOffset, edit.newText);

            const next = updateIncremental(doc, edit, newSource);
            const full = parseFull(newSource);

            assert.equal(next.source, newSource);
            assert.deepEqual(next.tree, full.tree);

            doc = next;
            source = newSource;
            lastEdit = null;
            checks++;
          }
        } catch (err) {
          // Reproducible failure context.
          console.error(
            `\n[FUZZ FAIL] doc#${d} seed=${seed}` +
              `\n  source=${JSON.stringify(source)}` +
              (lastEdit ? `\n  edit=${JSON.stringify(lastEdit)}` : "\n  (failed on initial parse)"),
          );
          throw err;
        }
      }

      assert.ok(checks >= DOCS, `expected at least ${DOCS} checks, ran ${checks}`);
    },
  },
];

await runGoldenCases("Incremental Fuzz", "incremental fuzz case", cases);
