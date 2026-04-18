**English** | [中文](./CONTRIBUTING.zh-CN.md)

# Contributing to yumeDSL

Thanks for your interest in contributing! This guide covers how to set up the project, run tests, and submit changes.

## Ecosystem

| Package                                                                            | Description                                      |
|------------------------------------------------------------------------------------|--------------------------------------------------|
| **`yume-dsl-rich-text`**                                                           | Parser core — text to token tree (this repo)     |
| [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)       | Interpreter — token tree to output nodes         |
| [`yume-dsl-shiki-highlight`](https://github.com/chiba233/yume-dsl-shiki-highlight) | Syntax highlighting — tokens or TextMate grammar |
| [`yume-dsl-markdown-it`](https://github.com/chiba233/yume-dsl-markdown-it)         | markdown-it plugin — DSL tags inside Markdown    |

## Prerequisites

- **Node.js** >= 18
- **pnpm** (recommended) — `npm install -g pnpm`

## Getting started

```bash
git clone https://github.com/chiba233/yumeDSL.git
cd yumeDSL
pnpm install

# Build
pnpm build

# Run tests
pnpm test
```

## Development workflow

1. Create a branch from `master`:
   ```bash
   git checkout -b fix/your-description
   ```
2. Make your changes.
3. Run tests:
   ```bash
   pnpm test
   ```
4. Commit with a clear message (see [Commit conventions](#commit-conventions)).
5. Open a pull request.

## Commit conventions

Use a short prefix to describe the type of change:

| Prefix      | Usage                                                   |
|-------------|---------------------------------------------------------|
| `feat:`     | New feature                                             |
| `fix:`      | Bug fix                                                 |
| `docs:`     | Documentation only                                      |
| `test:`     | Adding or updating tests                                |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `chore:`    | Build, CI, tooling changes                              |

Example:

```
fix(rich-text): handle escaped pipe inside raw tags
```

## Code guidelines

- **No `as any`** — fix the type instead of bypassing the checker.
- **Avoid `any`** — use it only at clear boundaries when narrower types are exhausted.
- **Prefer type guards and union narrowing** over type assertions.
- **Zero dependencies** — `yume-dsl-rich-text` is dependency-free by design. Don't add runtime dependencies unless
  discussed first.

## Structural parser maintenance boundary

`src/structural.ts` is no longer a small parser helper. In practice it has grown into a broad parser VM / state machine,
and large behavior-preserving rewrites are difficult to review safely.

- Pull requests touching `src/structural.ts` should be limited to bug fixes, correctness fixes, and narrowly scoped
  regression repairs.
- Do not send feature expansions, cleanup-only refactors, architecture rewrites, or "simplify the parser" PRs for that
  file unless the maintainer explicitly asked for them first.
- If a fix must touch `src/structural.ts`, keep the patch minimal and include a reproducer or regression test.

## Areas that are generally not open to drive-by contributions

The parser is now at the stage where some parts are more like a language runtime than ordinary application code.
Even small "cleanup" changes can silently alter semantics, timing, or hot-path cost.

Unless the maintainer explicitly asked for the work first, please avoid PRs in the following areas:

- **Parser hot-path rewrites** in `src/structural.ts`, `src/parse.ts`, or `src/render.ts`
  - No architecture rewrites, parser simplification passes, VM-to-recursion rewrites, or style-only refactors
  - No "this helper/object/closure can be cleaner" changes unless they are attached to a concrete bug with tests
- **Public contract reshaping** for parser options and output semantics
  - Do not widen `StructuralParseOptions`
  - Do not move render-only fields such as `createId`, `blockTags`, `mode`, or `onError` into structural APIs
  - Do not try to unify `parseRichText.position` with `parseStructural.position`
- **Performance-sensitive abstraction changes**
  - Avoid adding wrapper layers, convenience helpers, object reshaping, or extra passes on the main parse path unless the change is benchmarked and justified
  - "Cleaner JS API" is not, by itself, enough reason to touch the hot path
- **Cleanup-only rewrites of position tracking or error routing**
  - `baseOffset`, `tracker`, `_meta`, and the internal error channel have intentionally different responsibilities
  - If you touch them, the PR must explain the semantic boundary being preserved

These areas are not "never touch"; they are "maintainer-led only" unless there is a concrete bug, regression, or requested task.

## Dangerous paths — things that look harmless but break performance

The parser's constant factor has been tuned across many versions. The following patterns have caused real regressions
and are easy to introduce by accident. **Any PR that touches the main scan loop or per-frame logic must be
benchmarked.**

### No `indexOf` / native scan methods in the parser pipeline

The entire parser maintains explicit control flow — explicit stack, explicit `while` loops, explicit
character-by-character or `charCodeAt` comparisons. This is intentional.

Do **not** introduce `indexOf`, `findIndex`, `Array.prototype.find`, `includes`-as-search, `match`, or similar
native scan methods in parser hot paths (`structural.ts`, `scanner.ts`, `escape.ts`). These methods:
- hide an inner linear scan behind a single call, making the real branch cost invisible
- cannot be short-circuited or interleaved with other checks
- produce unpredictable performance cliffs when V8 deoptimizes or when the input shape changes

If you need to find the next occurrence of something, write an explicit loop with `charCodeAt` / `startsWith`, and
make the scan boundary visible at the call site.

### `findNextBoundaryChar` — the fast text skip loop

`findNextBoundaryChar` in `structural.ts` is the innermost hot loop. It scans forward using pre-computed `charCodeAt`
constants (one per syntax boundary token) and returns the position of the next character that could start a token.

Rules:
- **Do not add per-frame allocations.** An earlier attempt stored boundary lead codes in a per-frame `number[]` with
  a cache key string. This caused a +25.6% `heapUsed` regression on the 20k-nested benchmark. The current design
  pre-computes `tagPrefixLeadCode`, `tagCloseLeadCode`, `tagDividerLeadCode`, `escapeLeadCode` once per parse,
  and reads per-frame state (`insideArgs`, `inlineCloseToken`) via simple boolean/number checks.
- **The `NaN` sentinel is load-bearing.** When `inlineCloseToken` is `null`, `inlineCloseLeadCode` is set to
  `Number.NaN`. Because `NaN !== NaN`, the comparison `currentCode === inlineCloseLeadCode` always fails without
  an extra branch. Do not "simplify" this to `-1` or a conditional — it removes a branch from every character.
- **`isTagStartChar` is the shorthand boundary stop.** When inline shorthand is enabled, the skip loop must stop
  at any character that could start a tag name (e.g. `name(...)`). This is done via `tagName.isTagStartChar` inside
  the loop. An earlier approach disabled fast skip entirely for shorthand frames — this caused a regression on
  incremental inline/deep-inline benchmarks.

### `ParseFrame` allocation sensitivity

Every field on `ParseFrame` is allocated for every frame pushed onto the stack. Adding a field that is only used in
one branch (e.g. shorthand probe state) inflates every frame object.

The current design uses `ShorthandProbeState | null` — a lazily created sub-object that is `null` on most frames.
This replaced four always-present numeric fields and measurably reduced memory on deep-nesting benchmarks.

**Do not add fields to `ParseFrame`** without checking the 20k-nested heapUsed benchmark. If the field is only
relevant to a subset of frames, wrap it in a lazily created sub-object.

### WeakMap caching — keyed by object identity

Several caches use `WeakMap` keyed by `SyntaxConfig` or token-array identity:

- `syntaxEscapableTokenCache` — escapable token sets per syntax (arg / root / blockContent)
- `tokenLeadMatcherCache` — first-character bucketing for escape token matching
- `tagArgCloseCache` — lazily created `Map<number, number>` per parse, only for frames > 256 chars

Rules:
- **`SyntaxConfig` must be treated as immutable once parsing starts.** The WeakMap caches assume object identity
  equals content identity. Mutating a `SyntaxConfig` after parse starts will silently return stale cached data.
- **Token arrays must keep stable references** for the lead-matcher cache to hit. If you rebuild the array on every
  call, the cache is useless and you pay the bucketing cost every time.
- **The 256-char threshold for `getTagCloserTypeWithCache` is empirical.** Below 256 chars, the overhead of cache
  lookup exceeds the savings from cached arg-close positions. Do not change this threshold without benchmarking both
  short-frame and long-frame workloads.

### Escape token bucketing

`readEscapedSequenceWithTokens` in `escape.ts` uses a first-character bucketing strategy: tokens are grouped by their
leading character in a `Map<string, readonly string[]>`. When an escape char is found, only the bucket matching the
next character is tested — not the full token list.

Rules:
- The short-circuit `text[i] !== escapeChar[0]` before `startsWith` is intentional. Do not remove it — it avoids
  the `startsWith` call on the vast majority of characters.
- Bucket lookup is `O(bucket size)`, not `O(total tokens)`. For default syntax (9 tokens), worst-case bucket size
  is ~3. If you add new escapable tokens, check that no single bucket grows unreasonably large.

### `getTagCloserType` / `getTagCloserTypeWithCache` contract

`getTagCloserType` determines whether a tag opens as inline, raw, or block by scanning for the arg-close position.
`getTagCloserTypeWithCache` is the cached variant used for frames longer than 256 characters.

- **`fillTagArgCloseCacheFrom` must stay in sync with `findTagArgClose`.** They implement the same depth-tracking
  and escape-skipping logic. If you change one, you must change the other.
- The cache is a `Map<number, number>` (argOpen position → argClose position), created lazily and shared across
  all tag-head hits within the same frame. Do not change it to a per-tag-head cache — that defeats the purpose
  of amortizing the scan cost.

## Required when touching parser internals

If a contribution touches parser internals or parser-facing public contracts, the PR is expected to include:

- A minimal reproducer for the bug or regression being fixed
- The smallest relevant test coverage
- If timing/order behavior is affected: explicit notes about `onError` order, handler call order, or `createId` consumption order
- If source positions are affected: confirmation of which contract is preserved
  - `parseStructural` owns raw source truth
  - `parseRichText` owns normalized render truth
- If English or Chinese docs describe the touched contract: update both, not just one side

## Testing

- Tests live in the `tests/` directory.
- When fixing a bug, add a test case that reproduces the issue before writing the fix.
- Do not modify existing tests without discussion — if a test seems wrong, open an issue first.

## Reporting bugs

Please use the [Bug Report](https://github.com/chiba233/yumeDSL/issues/new?template=bug_report.yml) template. Include:

1. Which package and version is affected
2. Minimal reproduction code
3. Expected vs actual behavior

## Suggesting features

Use the [Feature Request](https://github.com/chiba233/yumeDSL/issues/new?template=feature_request.yml) template.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
