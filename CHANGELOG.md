**English** | [中文](./CHANGELOG.zh-CN.md)

# Changelog

### 1.2.5

- **Deferred `cloneParseOptions` on the incremental path**
  - `nextParseOptionsSnapshot` is now computed only after all early full-rebuild guards pass. Previously, `cloneParseOptions(options)` ran unconditionally at function entry; if any guard triggered a full rebuild, the clone was wasted — and `parseIncrementalInternal` would clone again internally.
- **Tracker reuse on full-rebuild fallback**
  - `parseIncrementalInternal` now accepts an optional `existingTracker` parameter. When the incremental path falls back to full rebuild after `buildPositionTracker` has already been called, the existing tracker is passed through instead of being discarded and rebuilt.
- **Single-pass `findDirtyRange`**
  - The overlap scan and insertion-index search are now fused into a single linear pass. Previously, a no-overlap edit triggered a second traversal to locate the insertion point; the insertion index is now tracked as a side-product of the overlap scan, eliminating the extra pass.
- **`cloneSnapshotValueInternal` avoids per-level `Object.keys` allocation**
  - Plain-object branch switched from `Object.keys(value)` + indexed loop to `for...in` direct iteration. This eliminates a temporary `string[]` allocation at every recursion level during deep clone. Semantics are unchanged — `isPlainObject` guarantees the prototype is `Object.prototype` (built-in props are non-enumerable) or `null` (no inheritance).

### 1.2.4

- **Zone splitting for pure-inline documents (`softZoneNodeCap`)**
  - Internal zone builder now splits long runs of non-breaker nodes (text / escape / separator / inline) into multiple zones when their count exceeds a configurable soft cap (`SOFT_ZONE_NODE_CAP`, default 64).
  - The public `buildZones(...)` API is unchanged — it always returns the same result as before. Zone splitting only takes effect on the internal incremental path (`buildZonesInternal`).
  - Documents without any `raw` / `block` nodes (pure inline) previously produced a single zone, making incremental parsing useless. With zone splitting, a 1 MB pure-inline document now produces ~800 zones, enabling 14.6× speedup over full rebuild.
  - New session option: `softZoneNodeCap?: number` in `IncrementalSessionOptions` — lets callers tune the zone granularity for their workload. Minimum effective value is 2 (clamped internally).
- **Low-zone-count guard**
  - When the previous snapshot has ≤ 1 zone (e.g., a very short document or pure text without handlers), the incremental path skips directly to a full rebuild. This eliminates overhead from attempting incremental updates that can't reuse anything.
  - New fallback reason visible via `INTERNAL_FULL_REBUILD` when the guard triggers.
- **Incremental performance: lazy right-side shifting**
  - Right-side zone reuse changed from eager deep-copy + recursive shift to O(1) lazy delta accumulation (`deferShiftZone`).
  - Node positions are materialized on first consumer access (`materializeZone`) via `Object.defineProperty` lazy getters on `tree` / `zones`.
  - Consecutive head-of-file edits automatically stack deltas without intermediate materialization, drastically reducing right-side subtree cost.
- **Snapshot clone optimization**
  - `cloneParseOptions` now uses a `frozenSnapshots` WeakSet: already-created snapshots skip handler deep-copy on re-entry (benefits the full-rebuild → parseIncremental path).
  - Fast-path fix: frozen snapshot re-entry now returns a shallow-spread new object instead of the same reference, preventing cross-generation alias where old-doc mutation could leak into new documents.
- **Signature hashing reduction**
  - `nodeSignature` content hashing changed from full `hashText` to O(1) bounded sampling (first/last 32 chars via `fnvFeedStringBounded`): retains same-length-different-content detection while avoiding linear scan of long text nodes.
- **Internal refactoring**
  - Extracted `fullRebuild()` local function, consolidating 5 repeated three-line rebuild patterns.
  - Added `feedChildSignatures` helper, eliminating repeated init→feed→shift boilerplate in nodeSignature.
  - Compressed `createShiftedNodeShell` branches to single-line returns.
  - Removed `shouldExpandNestedNode` indirection in `shiftNode`, consolidating frame dispatch.
  - Replaced 8 repetitive `hashText(syntax.xxx)` calls with `syntaxKeys` array loop.
- **Benchmark results (1 MB documents, Kunpeng 920 aarch64, Node 24)**
  - Full `parseIncremental` (initial snapshot): ~130 ms
  - Pure-inline (zone splitting, softCap=64, ~264 zones): incremental ~12 ms → **~10× speedup**
  - Moderate raw/block density (~3700 zones): incremental ~15 ms → **~9× speedup**
  - Dense raw/block (~17000+ zones): incremental ~38 ms → ~3.5× (zone assembly overhead dominates)
  - GC stability: 50 sequential inline edits without manual GC, median ~9 ms, no degradation
- No public API changes (session option `softZoneNodeCap` is additive/optional)

### 1.2.3

- **Incremental API surface cleanup**
  - Removed low-level updater exports from public surface: `updateIncremental(...)` / `tryUpdateIncremental(...)`.
  - Public integration is session-first: `createIncrementalSession(...)` (+ `parseIncremental(...)` for initial snapshot).
  - Trimmed session-only type exports from public surface.
  - `optionsFingerprint` is now internal-only and no longer exposed on `IncrementalDocument`.
- **Session mode correctness**
  - Fixed mode distortion: when guarded incremental path escalates to full rebuild, `applyEdit(...)` now returns:
    - `mode: "full-fallback"`
    - `fallbackReason: "INTERNAL_FULL_REBUILD"`
  - External telemetry/benchmarking now matches actual execution.
- **Options snapshot correctness hardening**
  - `handlers` snapshot now recursively clones plain object/array fields.
  - Added cycle protection for snapshot cloning (self-referential metadata is safe).
  - Even when options fingerprint is equivalent, explicitly passed `applyEdit(..., options)` is still captured and carried forward in session snapshot.
  - Fingerprint calculation no longer uses `JSON.stringify`; switched to numeric hash to reduce per-edit constant overhead.

### 1.2.2

- **Session fallback accounting fix (auto strategy)**
  - Fixed fallback-rate sampling skew when `updateIncremental(...)` internally rebuilt via `parseIncremental(...)`
  - `createIncrementalSession(...).applyEdit(...)` now records those internal rebuilds as fallback marks for adaptation (`maxFallbackRate` / cooldown decisions)
  - No breaking API changes; this is a telemetry/statistics correctness fix only
- **Incremental correctness hardening (right-side reuse gate)**
  - `updateIncremental(...)` now validates right-side reuse with a seam probe window instead of trusting stitched-zone boundaries alone
  - Reuse is denied (and full rebuild is used) when probe-zone structure/signature mismatches are detected
  - Added probe-window constants and extra-zone margin to reduce false negatives around seam-adjacent closures
- **Incremental option-compatibility fingerprint**
  - Added internal `optionsFingerprint` snapshot on incremental documents
  - Reuse is now guarded by normalized parse-option fingerprint comparison (syntax / allowForms / handlers identity / tagName identity)
  - Added explicit note that keeping `handlers` reference stable improves incremental reuse
- **Hashing internals consolidated**
  - Added shared `src/hash.ts` (FNV helpers)
  - Refactored both incremental seam signatures and stable-id internals to reuse shared hash utilities
  - Removed duplicated local hash routines
- **Incremental observability + regression tests**
  - Added internal debug sink hook for incremental reparse/probe counters (test instrumentation path)
  - Expanded incremental test coverage with seam-accept / seam-reject / fingerprint fallback / handlers identity / extra-margin / long-doc perf-guard cases
- No breaking changes to public `parseRichText` / `parseStructural` APIs

### 1.2.1

- **New API: `createIncrementalSession(...)`**
  - Added a correctness-first session entry for editor workflows
  - `session.applyEdit(...)` now provides a stable high-level contract: use incremental updates when possible, and auto-fallback to full rebuild when needed
  - Added session result metadata (`mode`, `fallbackReason`) for observability and tuning
- **Adaptive strategy controls**
  - Added `sessionOptions.strategy` with `"auto"` (default), `"incremental-only"`, and `"full-only"`
  - Added auto-policy knobs (`maxEditRatioForIncremental`, fallback-rate threshold, performance multiplier, cooldown window, sampling window)
  - Goal: avoid both premature full rebuilds and pathological incremental attempts, while preserving correctness guarantees
- **Experimental surface clarified**
  - Low-level `updateIncremental(...)` / `tryUpdateIncremental(...)` are now explicitly documented as advanced / experimental paths
  - Public guidance now prefers session-level API for production integration
- **Documentation updates**
  - Updated README / GUIDE export tables for new incremental session exports and types
  - Updated Incremental Parsing wiki pages (EN / 中文) with session-first usage, adaptive strategy examples, boundary rules, and fallback reason mapping
- No breaking changes to existing `parseRichText` / `parseStructural` APIs

- **Incremental Update Stack Safety:** Replaced the recursive deep-copy + position-shift path used for right-side zone reuse in `updateIncremental` with explicit stack iteration, so deep nested updates no longer depend on JS call-stack depth
- **Boundary Expansion Guard:** Added a cumulative reparse-byte budget to the right-boundary stabilization loop; when expansion cost grows beyond the threshold, the updater now falls back to full `parseIncremental` rebuild
- **Internal Refactor:** Consolidated duplicated child-shift flow across `inline` / `raw` / `block` branches into shared logic while preserving existing external behavior and error semantics
- No public API changes
- No intended output-format changes for normal `parseRichText` / `parseStructural` consumers

### 1.2.0

- **New Feature: Incremental Structural Parsing**
  - Introduced `parseIncremental`, `updateIncremental`, and `tryUpdateIncremental` APIs for high-performance structural updates in real-time editors
  - Updates a cached `StructuralNode[]` / `Zone[]` snapshot by re-parsing only a conservative "dirty" range, then stitching untouched zones back in
  - **Right-Side Reuse:** Zones strictly to the right of the dirty range are re-used by recursive deep-copy with position shifting (plain objects; no Proxy semantics)
  - **Performance Tradeoff:** Head-of-file edits on very large documents may still pay O(right-side subtree size) copying cost; for those workloads a full rebuild can be faster
  - **Boundary Stabilization:** The re-parse logic automatically expands the "dirty" range until the parse state stabilizes, ensuring correctness even when edits merge or split block-level structures
  - **Result Pattern:** `tryUpdateIncremental` provides a type-safe way to handle edit validation errors (`INVALID_EDIT_RANGE`, etc.) without catching exceptions
- **Documentation:** README / GUIDE and wiki updated with the new [Incremental Parsing](https://github.com/chiba233/yumeDSL/wiki/en-Incremental-Parsing) page (API, boundary rules, and editor integration notes)
- **Internal:** Added `src/incremental.ts` and comprehensive test coverage in `tests/incremental.test.ts`
- No breaking changes to existing `parseRichText` or `parseStructural` APIs

### 1.1.10

- Performance: reduced worst-case block-boundary scan cost on malformed nested tag heads. `findBlockClose` now memoizes both inline-close boundary lookups and tag-arg-close lookups per call, preventing repeated scan-to-EOF rescans when block content contains many malformed nested inline heads
- Internal: added explicit synchronization note for the cached inline-boundary scanner to keep its escape/head/end-tag semantics aligned with `scanInlineBoundary`
- Internal: lazy cache allocation in `findBlockClose` avoids unconditional `Map` creation on simple block paths
- No public API changes
- No intended output-format changes for normal `parseRichText` / `parseStructural` consumers

### 1.1.9

- Stack safety: `printStructural` and `mapTokens` converted from native recursion to explicit stack
  iteration. This completes the stack-safety transition for all core tree-processing and
  transformation APIs, ensuring that even extremely deep trees (tens of thousands of levels) can be
  serialized or transformed without risking call-stack overflow
- Internal: Refactored `printNodes` and `mapTokens` with cleaner dispatchers and state frames for
  improved maintainability
- No public API changes
- No intended output-format changes for normal `printStructural` / `mapTokens` consumers
- Performance: `resolveBaseOptions` now detects `options.tracker` and skips building a redundant local position tracker if one is already provided
- Performance: `materializedTailTokens` removed `slice().flat()` calls. It now uses a fast path for single segments and a manual `for` loop for merging multiple segments, reducing temporary array allocations
- Performance: `renderRawNode` optimized raw-block line processing. Replaced `split`/`join` with a `charCodeAt` first-character check and `startsWith` scanning, achieving zero intermediate array overhead
- Performance: `materializeTextTokens` improved token reuse. When `unescapeInline` returns the original string reference (meaning no escapes were found), the original token object is reused directly instead of being spread into a new object, reducing heap pressure
- Performance: `splitTokensByPipe` introduced a fast path that pushes original tokens directly when no `escapeChar` or `tagDivider` is present. It also reuses original token references in the slow path when no actual split occurs
- Performance: `createEasyStableId` default fingerprint hashing converted from recursive tree traversal to iterative collection with bottom-up hashing, and introduced a per-generator `WeakMap<TextToken[], number>` cache keyed by value-array references (shared between `TokenDraft` and the spread result from `createToken`). In the normal bottom-up `createToken` flow, child arrays are always pre-cached, reducing each `hashDraft` call from O(subtree) to O(type.length). Total hashing cost across a full parse drops from O(N × depth) to O(N). For manually constructed deep `TokenDraft` trees, the iterative collector ensures full stack safety
- No public API changes
- No intended output-format changes for normal `parseRichText` / `parseStructural` consumers
- Stable ID values produced by `createEasyStableId` (default fingerprint) will differ from previous versions due to the hash-caching strategy change. The same-input-same-output and collision properties are preserved

### 1.1.8

- Stack safety: `walkTokens` converted from native recursion to explicit stack iteration, matching
  the same pattern used by `parseStructural` / `parseRichText` / `materializeTextTokens`. Deep
  token trees (tens of thousands of levels) no longer risk call-stack overflow during traversal
- Documentation: new **Linear-Time Complexity** wiki page
  ([EN](https://github.com/chiba233/yumeDSL/wiki/en-Linear-Time-Complexity) /
  [中文](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E7%BA%BF%E6%80%A7%E6%97%B6%E9%97%B4%E5%A4%8D%E6%9D%82%E5%BA%A6))
  covering formal upper bound proof (`T(n) ≤ C·n`), worst-case input models, per-character branch
  budget (_k_ ≈ 3–15), and empirical constants
- Documentation: README / GUIDE updated with brief complexity explanation and link to the new wiki page
- No public API changes
- No intended output-format changes for normal `parseRichText` / `parseStructural` consumers

### 1.1.7

- Performance: render-layer `trimBlockBoundaryTokens` no longer deep-clones the entire children
  array; it now checks whether trimming is needed and returns the original array in the common case,
  cloning only the tokens that are actually modified
- Performance: structural scanner `flushBuffer` uses direct string concatenation for the common
  1–2 segment-pair case, avoiding a temporary parts array allocation
- Fix: `trimBlockBoundaryTokens` crash on empty collapse blocks — when the only text token was
  removed by leading-trim, trailing-trim did not check whether the array was already empty
- Internal: `completeChild` converted from switch to if/else, removing one level of indirection
- No public API changes
- No intended output-format changes for normal `parseRichText` / `parseStructural` consumers

### 1.1.6

- Performance: `parseStructural` hot-path constants reduced again
  - text buffering no longer relies on repeated string concatenation in the structural scanner
  - raw / block child frames now keep source ranges instead of eagerly slicing intermediate strings
- Compatibility note: `onError` behavior in `1.1.x` was audited across published versions
  - `1.1.0` and `1.1.5` match each other
  - `1.1.1` is its own behavior group
  - `1.1.2` / `1.1.3` / `1.1.4` match each other exactly and are now the compatibility baseline for `onError`
- No public API changes
- No intended output-format changes for normal `parseRichText` / `parseStructural` consumers

### 1.1.5

- Improve: `parseStructural()` no longer builds an internal indexed tree and then strips `_meta`
  into a second public tree. The public path now parses directly into `StructuralNode[]`
- Internal: the old `stripMetaForest` conversion stage is gone from the public structural API path
- Internal: structural scanning now has two clean outputs instead of one shared union-typed hot path:
  internal reuse still builds `IndexedStructuralNode[]`, while the public API builds `StructuralNode[]`
  directly
- Cleanup: removed the now-unused `parseStructuralInternal` helper
- Benchmark: structural parse memory dropped measurably versus `1.1.3` on the same machine
  (Kunpeng 920 / Node v24.14.0):
  - 200 KB dense inline document: `heapUsed` after parse `56.72 MB -> 45.52 MB` (~19.8% lower)
  - 2 MB dense inline document: `heapUsed` after parse `241.33 MB -> 142.24 MB` (~41.1% lower)
  - 20k nested inline document: `heapUsed` after parse `68.02 MB -> 62.93 MB` (~7.5% lower)
- No public API changes
- No intended output-format changes for normal `parseStructural` consumers

In short: this patch removes the public structural tree duplication step, lowers memory use on real
documents, and keeps the user-facing contract unchanged.

### 1.1.4

- Performance: `parseRichText` now reuses one shared base-resolution pass instead of resolving
  parser base config twice before entering the structural and render pipelines
- Benchmark: on a 200 KB document (Kunpeng 920 / Node v24.14.0), `parseRichText` improved from
  `1.1.3 ~27.4 ms` to `~22.6 ms`; `parseStructural` improved from `~19.3 ms` to `~17.8 ms`
- Substring parsing stays fast: `baseOffset` and `tracker` scenarios were re-measured against
  `1.1.3`, with no regression in timing or position-tracking behavior
- No public API changes
- No intended output-format changes for normal `parseRichText` / `parseStructural` consumers
- Source-position semantics remain intentionally split:
  - `parseStructural.position` still reflects raw source ranges
  - `parseRichText.position` still reflects normalized render ranges
- Added regression coverage to lock that boundary in, including cases where the two APIs must differ
  and cases where they should still match

In short: this patch keeps the same public contract, makes the hot path cheaper by removing
duplicate base setup, and adds guardrails so future refactors do not collapse the two position
semantics.

### 1.1.3

- Follow-up to 1.1.2's deep-nesting work: the three independent bottlenecks removed in 1.1.2
  remain gone. This release focuses on the remaining public `parseStructural` memory peak on top
  of that O(n) path
- Improve: public `parseStructural` deep-nesting memory profile — `stripMeta` no longer builds a
  `Map<IndexedStructuralNode, StructuralNode>` for the whole tree. It now fills the public forest
  directly via an iterative parent-container walk, reducing peak overhead on user-visible API calls
- Benchmark: public `parseStructural(50000000)` now completes in **~224.1 s** on Kunpeng 920 /
  Node v24.14.0
- Documentation: README / GUIDE / wiki performance pages updated from the old 10 M / internal-limit
  narrative to the new 50 M public-API benchmark and heap-budget notes

### 1.1.2

- Fix: deep nesting stack overflow — `parseNodes`, `renderNodes`, `stripMeta`, `extractText`,
  and `materializeTextTokens` converted from recursion to explicit stack iteration. Nesting
  depth now bounded only by heap memory (1.1.1 hit stack overflow at ~1200–1800 layers)
- Improve: deep nesting O(n) — 5000-layer `parseRichText` drops from 1.1.1 ~17 s to
  **~23 ms** (~740x). Three O(n²) bottlenecks eliminated:
    - `materializeTextTokens` re-traversal: `WeakSet` marks processed subtrees, subsequent
      calls skip them
    - `findInlineClose` forward scan: inline child frames now use lazy close — scan on the
      parent's text and complete when `)$$` is encountered, with `parenDepth` tracking for
      correct `)`-based form detection (`)`+`$$` / `)`+`%` / `)`+`*`)
    - `findTagArgClose` via `getTagCloserType`: nested tags inside inline child frames
      skip `getTagCloserType`, avoiding the O(n) arg-close scan per nesting level
- Internal: `parseNodes` rewritten with explicit `ReturnKind` dispatch (`completeChild`)
  replacing all `resume` closures. Frame completion is a single switch, not scattered
  callbacks
- Tests: new `[Edge/Depth]` case — 2000-layer inline nesting with `depthLimit: 3000` verifies
  both `parseStructural` and `parseRichText` complete without stack overflow

### 1.1.1

- Internal: parser architecture rewritten from single-pass character scanner (`internalParse`) to
  two-phase approach — `parseStructural` produces an indexed node tree, then a render phase walks
  it to produce `TextToken[]`. The old single-pass design was elegant and a joy to read, but
  `findBlockClose` calling `findInlineClose` repeatedly caused O(n²) rescanning on deeply nested
  block tags — a painful but necessary rewrite
- Improve: `parseRichText` performance — **133x faster** on 200 KB documents (Kunpeng 920 / Node
  v24.14.0): ~4400 ms → ~33 ms. Now nearly as fast as `parseStructural` (~29 ms)
- Improve: error reporting — `parseStructural` gained 6 new diagnostic points (`INLINE_NOT_CLOSED`,
  `BLOCK_NOT_CLOSED`) for malformed input; 4 spurious `INLINE_NOT_CLOSED` false positives on
  complex-form tags removed from `parseRichText`
- Internal: dead code removed — `complex.ts` deleted, `consumers.ts` trimmed to `supportsInlineForm`
  then merged into `resolveOptions.ts`, `context.ts` trimmed to `emptyBuffer` then inlined into
  `structural.ts`
- Internal: new `render.ts` — render phase extracted from `parse.ts`
- Fix: `tryConsumeEscape` now uses `startsWith` instead of single-character comparison
  for the escape character. Previously, custom multi-character `escapeChar` in syntax
  config would silently fail to trigger escape handling. Default single-character `\`
  was not affected

### 1.1.0

- New: `NarrowToken<TType, TExtra?>` — utility type that narrows `TextToken` to a specific `type`
  literal with known extra fields, recovering type safety from the index signature
- New: `NarrowDraft<TType, TExtra?>` — same for `TokenDraft`, for handler return type annotations
- New: `NarrowTokenUnion<TMap>` — generate a discriminated union of `NarrowToken` from a token map
- New: `createTokenGuard<TMap>()` — runtime type guard factory that narrows `TextToken` by `type` key
  in `if` branches with full TypeScript inference
- New: `Parser.print()` now accepts optional `PrintOptions` override — syntax is deep-merged with
  defaults, matching the per-call override behavior of `parse()` and `structural()`. Previously `print`
  was always bound to `defaults.syntax`, breaking round-trip when parsing with a syntax override
- Fix: `deriveBlockTags` / `resolveBlockTags` parameter type narrowed from `Record<string, unknown>`
  to `Record<string, TagHandler>`, eliminating an unsafe `as Record<string, unknown>` cast
- Improve: `unescapeInline` performance — batch non-escape runs via `slice()` instead of per-character
  `readEscaped()` calls; returns original string unchanged when no escapes are found (zero allocation)
- Improve: `extractText` performance — collect into `string[]` + `join("")` instead of recursive `+=`
- Improve: `splitTokensByPipe` performance — track run start position instead of per-character `buffer +=`
- Internal: rename `TagStartInfo.inlineContentStart` → `argStart` (internal type, not exported)

### 1.0.15

- New: `buildZones(nodes)` — groups a `StructuralNode[]` (with `trackPositions: true`) into
  contiguous `Zone[]`. Adjacent text / escape / separator / inline nodes merge into one zone;
  each raw or block node gets a dedicated zone. Useful for zone-level caching in editors
- New: `Zone` type exported
- Fix: block and raw tag content no longer includes the structural trailing `\n` before `*end$$` /
  `%end$$`. This newline is required by the syntax (closers must be on their own line) and is not
  content. Previously, `$$note()*\ncontent\n*end$$` produced `"content\n"`; now produces `"content"`.
  Consecutive block tags no longer have a spurious blank line between them
- Improve: `buildZones()` now throws a descriptive error when nodes lack `position` (forgot
  `trackPositions: true`), instead of silently returning an empty array
- Tests: 8 zone test cases (grouping, breaker isolation, boundary alignment, coverage,
  empty input, no-position error, type smoke); dist smoke and type assertions now cover
  `buildZones` / `Zone` exports (ESM + CJS)
- Documentation:
    - README / GUIDE: 200 KB benchmark headline, live demo link, exports table updated
    - Source Position Tracking wiki: updated to 200 KB benchmarks, added `parseSlice` section
      with measured data (EN + ZH)
    - Stable Token IDs wiki: added `createEasyStableId` performance section (EN + ZH)
    - token-walker README: added `parseSlice` performance section with wiki links (EN + ZH)

### 1.0.14

- `declareMultilineTags` now supports `"inline"` form — strips the trailing `\n` immediately after
  inline close `$$` for tags that render as block-level elements despite using inline syntax
  (e.g. `$$center(...)$$`)
- Passing a **string** to `declareMultilineTags` now enables normalization for all three forms
  (raw + block + inline). Object form without `forms` remains `["raw", "block"]` for backward
  compatibility
- `MultilineForm` type extended to `"raw" | "block" | "inline"` (now an alias of `TagForm`)
- Inline normalization is **never auto-derived** — must be explicitly declared via `blockTags`
- Documentation: `declareMultilineTags` section upgraded across README, GUIDE, and wiki pages
  with problem explanation, per-form table, auto-derivation rules, and best practices

### 1.0.13

- Documentation
    - Add inline Vue 3 and React rendering snippets to README / GUIDE intro — first-time users can see
      how rendering works before scrolling
    - Add [Wiki](https://github.com/chiba233/yumeDSL/wiki/) with full API documentation, in-depth
      handler utility reference, and three step-by-step tutorials:
        - [Building a Link Tag from Scratch](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Link-Tag)
        - [Game Dialogue Tags](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Game-Dialogue)
        - [Safe UGC Chat](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Safe-UGC)
    - Add [React Rendering](https://github.com/chiba233/yumeDSL/wiki/en-React-Rendering) wiki page —
      drop-in recursive component, `useMemo` integration, Material UI / Ant Design / syntax-highlighter examples
    - Move Vue 3 rendering demo from README to
      [Wiki](https://github.com/chiba233/yumeDSL/wiki/en-Vue-3-Rendering) — README now links to wiki
    - Remove Table of Contents from README / GUIDE (redundant with wiki navigation)
    - Add Wiki badge to README / GUIDE header
    - Add wiki cross-reference links to Handler Utilities, Exports, Error Handling, and Security sections

### 1.0.12

- New structural print API:
    - `printStructural(nodes, options?)` — lossless serializer, always prints full tag syntax
    - `PrintOptions` accepts `syntax` override for custom syntax round-trip
    - Supports round-trip serialization: `printStructural(parseStructural(input)) === input` for well-formed inputs
      when the same syntax is used
- `createParser` now returns a `print(nodes)` method that inherits `syntax` from the parser's closure

### 1.0.11

- New token traversal utilities:
    - `walkTokens(tokens, visitor)` — depth-first pre-order read-only visitor; accepts a generic callback
      or a `Record<type, fn>` for type-based dispatch
    - `mapTokens(tokens, visitor)` — depth-first post-order immutable transform; return a replacement token,
      an array to expand one token into multiple siblings, or `null` to remove; children are mapped before
      the visitor sees the parent
    - `TokenVisitContext` — `{ parent, depth, index }` provided to every callback
- Fix: `createParser(defaults)` now deep-merges `syntax` and `tagName` when overrides are passed to
  `parse()` / `strip()` / `structural()`. Previously, a partial override like `{ syntax: { escapeChar: "~" } }`
  would clobber the entire default `syntax` object instead of merging into it

### 1.0.10

- Update markdown

### 1.0.9

- New public export: `createEasyStableId(options?)` — parse-session scoped, stateful `CreateId`
  generator that derives deterministic, content-based token IDs instead of sequential counters
    - Default fingerprint: `type` + `value` (recursive); pass a custom `fingerprint` closure for full control
    - Duplicate fingerprints auto-disambiguated with numeric suffixes (`s-abc`, `s-abc-1`, …)
    - Configurable `prefix` (default `"s"`)
- New public type: `EasyStableIdOptions`
- Documentation
    - New **Stable Token IDs** section in README / GUIDE with usage, scope, and disambiguation examples
    - Added **Handler Utilities** demo — one handler covering all 10 utility functions from the export table
    - Updated intro: use cases (game dialogue, chat/UGC, CMS, localization), graceful degradation,
      framework-agnostic runtime, `parseStructural` + `parseSlice` pipeline

### 1.0.8

- Removed `isInternalCaller` / `withInternalCaller` implicit global flag from `deprecations.ts`
- `withSyntax`, `withCreateId`, `withTagNameConfig`, and `getSyntax` now accept an explicit
  `{ suppressDeprecation?: boolean }` option instead of relying on ambient `internalCaller` state
- `parseRichText` passes `{ suppressDeprecation: true }` to its internal `with*` calls directly
- Deprecation output now prefers `process.stderr.write` over `console.warn` where available
- Refactored internals for human readability:
    - Collapsed the three-layer `withSyntax`/`withTagNameConfig`/`withCreateId` nesting in `parseRichText` into a single
      `withLegacyAmbientState` helper
    - Replaced `tryParseComplexTag`'s 14 positional parameters with a `ComplexTagContext` object
    - Replaced boolean flags in `scanInlineBoundary` with a named `InlineBoundaryMode` object
    - Extracted `bufferAndAdvance` helper to deduplicate repeated append-and-advance patterns in
      `tryConsumeDepthLimitedTag`
    - Extracted `pushNode` helper to deduplicate conditional position assignment across `structural.ts`
    - Deduplicated `createPipeBlockHandlers` / `createPipeRawHandlers` via shared `createPipeFormHandlers`

### 1.0.7

- Fixed an inline-close bug for tags that support both inline and block/raw forms:
  inline `$$tag(...)$$` no longer incorrectly consumes the following trailing newline via block normalization rules
- Fixed documentation examples for substring position tracking:
  corrected the character-count ruler example in README / GUIDE

### 1.0.6

- New public export: `buildPositionTracker(text)` — build a reusable `PositionTracker` from any text
- New public type: `PositionTracker` — precomputed line-offset table for resolving offsets to line/column
- `ParserBaseOptions` now accepts two new optional fields for substring parsing:
    - `baseOffset?: number` — shift all `offset` values by this amount (default `0`)
    - `tracker?: PositionTracker` — pre-built tracker from the original full document;
      when provided, `line` and `column` are also resolved against the original document
    - Both require `trackPositions: true` to have any effect
    - Without `tracker`, only `offset` is shifted; `line`/`column` remain local to the substring
    - With `tracker`, all three fields (`offset`, `line`, `column`) are fully correct
- These options apply to both `parseRichText` and `parseStructural`
- No breaking changes — all new fields are optional with backward-compatible defaults

### 1.0.5

- New helper: `createPipeHandlers(definitions)`
    - Unified pipe-aware handler builder for any combination of `inline`, `raw`, and `block`
    - `inline` handlers receive parsed `PipeArgs` from inline tokens
    - `raw` / `block` handlers receive parsed `PipeArgs` from `arg`, while still preserving the original `rawArg`
- New utility: `createTextToken(value, ctx?)`
    - Shorthand for creating `{ type: "text", value }` tokens with parse-local `createId` support
- `PipeArgs` now includes convenience readers for custom handler code
    - `has(index)`
    - `text(index, fallback?)`
    - `materializedTokens(index, fallback?)`
    - `materializedTailTokens(startIndex, fallback?)`
- `createPipeBlockHandlers` and `createPipeRawHandlers` are now thin shorthands over `createPipeHandlers`
- Deprecation warnings for legacy ambient-state APIs (each warning fires once per runtime)
    - `withSyntax()`, `getSyntax()`, `withTagNameConfig()`, `withCreateId()`, `resetTokenIdSeed()` now emit a
      one-time `console.warn` when called by user code
    - Internal calls from `parseRichText` are suppressed via `withInternalCaller` — no warning noise during normal
      parsing
    - `parseStructural()` warns specifically when it detects ambient `withSyntax()` / `withTagNameConfig()` state that
      differs from defaults; normal calls without ambient wrapping do not warn
    - Warnings are suppressed when `NODE_ENV=production`
- Deprecated exports formally documented in a new **Deprecated API** section:
  `createPipeBlockHandlers`, `createPipeRawHandlers`, `createPassthroughTags`, `withSyntax`, `getSyntax`,
  `withTagNameConfig`, `withCreateId`, `resetTokenIdSeed`, `ParseOptions.mode`
- Deprecated APIs will **not** be removed before September 2026
- Documentation refresh
    - Promoted `createPipeHandlers` as the main pipe-aware helper
    - Reorganized handler helper docs into recommended / shorthand / advanced sections
    - Updated utility examples to use `createTextToken(...)` where appropriate
    - Consolidated same-family helpers into shared sections for better information density

### 1.0.4

- **Refactor:** Eliminate all remaining module-level implicit state reads from internal parse code
    - `ParseContext` now carries `syntax`, `tagName`, and `createId` directly — internal functions read these instead of
      calling `getSyntax()` / `getTagNameConfig()` / relying on `activeCreateId`
    - All scanner functions (`findTagArgClose`, `readTagStartInfo`, `findInlineClose`, `findBlockClose`, `findRawClose`,
      `getTagCloserType`, `skipTagBoundary`, `skipDegradedInline`) receive explicit `syntax` / `tagName` parameters
    - `parseStructural` threads `syntax` / `tagName` / `tracker` explicitly through `parseNodes` — no `withSyntax` /
      `withTagNameConfig` wrappers needed internally. Ambient `getSyntax()` / `getTagNameConfig()` are captured once at
      entry when no explicit overrides are provided
    - `parseRichText` still wraps with `withSyntax` / `withTagNameConfig` / `withCreateId` at entry for backward
      compatibility — user handlers calling public utilities (`parsePipeArgs`, `createToken`, `unescapeInline`, etc.)
      continue to work without changes
- New type: `DslContext { syntax, createId? }` — lightweight context for public utility functions
    - Builder utilities (`splitTokensByPipe`, `parsePipeArgs`, `parsePipeTextArgs`, `parsePipeTextList`,
      `materializeTextTokens`) accept `ctx?: DslContext`
    - Escape utilities (`readEscapedSequence`, `readEscaped`, `unescapeInline`) accept `ctx?: DslContext | SyntaxConfig`
      — `DslContext` for user code, bare `SyntaxConfig` for internal scanner calls
    - `createToken(..., ctx?)` accepts `ctx?: DslContext | CreateId` — `DslContext` for user code, bare `CreateId` for
      internal context threading
    - Syntax resolution (`resolveSyntax`) and createId resolution (`resolveCreateId`) are each centralized in one place
    - When `ctx` is omitted, all utilities fall back to module-level defaults (`getSyntax()` / `activeCreateId`) —
      existing code continues to work unchanged
    - A future major version will tighten this toward required `DslContext`
- `TagHandler` callback signatures now receive an optional `ctx?: DslContext` as the last parameter
    - `inline?: (tokens, ctx?) => TokenDraft`
    - `raw?: (arg, content, ctx?) => TokenDraft`
    - `block?: (arg, content, ctx?) => TokenDraft`
    - The parser passes `DslContext` when calling handlers — existing handlers that don't accept `ctx` are unaffected
      (JS safely ignores extra arguments)
    - Handlers that opt in can pass `ctx` through to utility functions, eliminating all implicit global state dependency
- Built-in handler helpers now propagate `ctx` through the full call chain
    - `createSimpleInlineHandlers` → `materializeTextTokens(tokens, ctx)`
    - `createPipeBlockHandlers` → `parsePipeTextList(arg, ctx)`
    - `createPipeRawHandlers` → `parsePipeTextList(arg, ctx)`
- `parseStructural` reuses `emptyBuffer()` from `context.ts` for buffer initialization and reset
- All existing exports and signatures remain backward compatible; `DslContext` and optional `ctx` parameters are
  additive (non-breaking)

### 1.0.3

- **Refactor:** Position tracker moved from module-level implicit state to explicit parameter threading
    - `ParseContext` now carries `tracker: PositionTracker | null` directly
    - `parseStructural` passes tracker explicitly through `parseNodes` — no hidden globals
    - `emitError` / `getErrorContext` receive tracker as a parameter instead of reading module state
    - `complex.ts` receives tracker explicitly; inner-parse offset adjustment uses `offsetTracker` (replaces
      `withBaseOffset` + `withPositionTracker`)
- **Refactor:** Buffer accumulation state consolidated into `BufferState` object
    - `ParseContext.buffer` / `bufferStart` / `bufferSourceEnd` merged into `ParseContext.buf: BufferState`
    - `emptyBuffer()` factory for initialization and reset
- **Refactor:** Block content normalization + offset mapping encapsulated as `prepareBlockContent`
    - Returns `{ content, baseOffset }` — callers no longer manually combine `normalizeBlockTagContent` +
      `leadingTrim` + `contentStart`
- No public API changes; all changes are internal

### 1.0.2

- Add opt-in source position tracking (`trackPositions: true`) for both `parseRichText` and `parseStructural`
    - New types: `SourcePosition`, `SourceSpan`
    - `TextToken.position?` and `StructuralNode.position?` — present only when enabled
    - Pre-computed line-offset table with O(log n) binary search for line/column resolution
    - Negligible overhead when disabled (default) — no table allocation, no position objects produced
    - `parseRichText` block/raw token spans include trailing line-break normalization; `parseStructural` keeps raw
      syntax spans
    - Nested block content positions map back to the original source via base-offset adjustment
    - Error reporting reuses the line-offset table when position tracking is active
- `normalizeBlockTagContent` now returns `{ content, leadingTrim }` instead of a plain string (internal change,
  not part of the public API)

### 1.0.1

- Add `createEasySyntax(overrides)` — convenience function that auto-derives compound tokens (`endTag`, `rawOpen`,
  `blockOpen`, `rawClose`, `blockClose`) from `tagPrefix` and `tagClose`. Explicit overrides still take precedence.
  `createSyntax` is retained as the low-level plain-merge alternative
- Improve documentation readability — reduce info density in the opening sections, add recommended reading order,
  add decision guidance ("which API to use"), add ecosystem combination guide, rewrite Default Syntax section with
  ASCII diagrams and token dependency table

### 1.0.0

- **Breaking (behavior):** Remove `"highlight"` from `ParseOptions.mode` — the value is no longer accepted.
  The three internal highlight-mode branches (skip block content trimming, skip trailing line-break consumption,
  skip raw-content unescaping) have been deleted. Use `parseStructural` for syntax-highlighting use cases
- Reposition `parseStructural` as a first-class structural parse API sharing the same language configuration
  as `parseRichText`, not a highlighting helper
- Elevate Custom Syntax as a core feature — updated intro, design philosophy, features, and when-to-use sections
- Remove `supportsInlineForm` and `filterHandlersByForms` from public exports (internal-only, erroneously listed as
  exported in 0.1.18–0.1.19 changelog but never actually re-exported from `index.ts`)

### 0.1.20

- Fix documentation broken by AI-generated changes

### 0.1.18 - 0.1.19

- Add `parseStructural(text, options?)` — structural parser that preserves tag form
  (inline / raw / block) in the output tree as `StructuralNode[]`
    - Shares `ParserBaseOptions` with `parseRichText` — identical tag recognition and form gating when `handlers` is
      provided
    - Omit `handlers` to accept all tags and forms (highlight mode)
    - Inherits active `withSyntax` / `withTagNameConfig` context when called without explicit overrides
- Extract `ParserBaseOptions` — shared base for `ParseOptions` and `StructuralParseOptions`
  (`handlers`, `allowForms`, `depthLimit`, `syntax`, `tagName`)
- Add `parser.structural()` to `createParser` return type — shares base config with `parse()` / `strip()`
- Export `supportsInlineForm`, `filterHandlersByForms` from internal modules (used by structural parser, single source)
- Export `readEscapedSequence`, `withSyntax`, `getSyntax`, `withTagNameConfig`
- Export `ParserBaseOptions`, `StructuralNode`, `StructuralParseOptions` types
- Add `yume-dsl-shiki-highlight` to ecosystem

### 0.1.15 – 0.1.17

- Add [Live Demo](https://qwwq.org/blog/dsl-fallback-museum) — showcasing Shiki code-highlighting plugin, legitimate
  plugins, malformed markup, and error reporting
- Optimize npm package size by excluding non-essential docs (~30% smaller)
- Add Vue 3 rendering guide with drop-in recursive component example
- Add community docs: `CONTRIBUTING.md`, `SECURITY.md`, issue templates, PR template
- Add Chinese translations for `CONTRIBUTING.zh-CN.md`

### 0.1.14

- Update Markdown and add golden test.

### 0.1.13

- Reorganize `index.ts` exports into clearer groups: Configuration, Handler Helpers, Handler Utilities, and typed
  sub-groups
- Reorganize README "Utility Exports" section into Configuration / Handler Helpers / Handler Utilities sub-tables
- Consolidate all `tagName` documentation into a single "Custom Tag Name Characters" section
- Fix dist smoke test TS7016 in IDEA by switching to self-referencing package import + `paths` mapping

### 0.1.12

- Add `tagName` to `ParseOptions` so users can customize `isTagStartChar` / `isTagChar`
- Add `TagNameConfig`, `DEFAULT_TAG_NAME`, and `createTagNameConfig`
- Update README with `parseRichText` and `createParser` examples for custom tag-name rules
- Add per-form granularity to `declareMultilineTags` — entries can now be `{ tag, forms }` objects to restrict
  line-break normalization to specific multiline forms (`"raw"` / `"block"`)
- Plain string entries remain fully backward compatible (normalize both raw and block forms)
- Add `MultilineForm`, `BlockTagInput`, `BlockTagLookup` exported types
- Internal: replace `Set<string>` block-tag lookup with form-aware `BlockTagLookup`; `deriveBlockTags` now registers
  each handler method under its own form for more precise auto-derivation

### 0.1.11

- Make parser-generated token ids parse-local by default (`rt-0`, `rt-1`, ... per parse)
- Add `createId` option to override token id generation per parse / parser

### 0.1.10

- Add `parsePipeTextList(text)` utility — split a pipe-delimited arg string directly into `string[]` without
  intermediate token allocation
- Refactor `createPipeBlockHandlers()` / `createPipeRawHandlers()` to use `parsePipeTextList` internally
- Add decision-table comment to the inline-form gating function (`supportsInlineForm`) to guard against future
  regressions
- Add JSDoc to `materializeTextTokens` clarifying it only unescapes text-type leaf tokens

### 0.1.9

- Remove source maps to reduce package size
- Fix `allowForms` so disabling `"inline"` also blocks inline syntax for tags that still have `raw` / `block`
  handlers
- Fix `allowForms` so disabling `"inline"` also preserves unregistered `$$unknown(...)$$` tags literally
- Fix `createSimpleBlockHandlers()` / `createSimpleRawHandlers()` so block-only and raw-only helpers no longer accept
  inline syntax implicitly
- Fix custom syntax parsing for multi-character `tagOpen` / `tagClose` / `tagDivider` tokens
- Fix `allowForms: ["inline"]` so registered block/raw-only tags filtered out by form restriction keep their inline
  markup literally instead of being treated as unknown inline tags
- Guard `onError` callbacks so user-thrown exceptions do not abort parsing
- Expand custom syntax escaping so `endTag` / `rawOpen` / `blockOpen` can also be escaped literally
- Add `createPipeBlockHandlers()` and `createPipeRawHandlers()` helpers for structural pipe-arg parsing
- Add regression tests for `allowForms` and the new handler helpers
- Add custom syntax edge tests, compile-time type checks, and stronger fuzz coverage
- Clarify README wording around multiline block/raw helpers and fallback behavior

### 0.1.8

- Add `allowForms` option to `ParseOptions` — restrict which tag forms (`"inline"`, `"raw"`, `"block"`) the parser
  accepts; disallowed forms degrade gracefully
- Add `createSimpleInlineHandlers(names)` helper — register simple inline tags in bulk without writing repetitive
  handler objects
- Add `declareMultilineTags(names)` helper — declare which tags need multiline line-break normalization (`blockTags`)
- Add `createSimpleBlockHandlers(names)` helper — register simple block-form tags in bulk
- Add `createSimpleRawHandlers(names)` helper — register simple raw-form tags in bulk
- Add `createPassthroughTags(names)` helper — register tag names with empty handlers in bulk (advanced use case)
- All helpers preserve literal key types via `const` generics — `createSimpleInlineHandlers(["bold", "italic"])` infers
  `Record<"bold" | "italic", TagHandler>`
- Export `TagForm` type

### 0.1.7

- Add index signature (`[key: string]: unknown`) to `TextToken` — extra fields from handlers are now visible in the type
  system without casting
- Remove unnecessary `as TextToken` assertion in `createToken`
- Enable `allowImportingTsExtensions` in tsconfig — project now passes `tsc --noEmit` cleanly
- Update README: document `TextToken` index signature, recommend `extends TextToken` for strong typing

### 0.1.6

- Just update Markdown.

### 0.1.5

- Add `createParser()` factory for pre-bound options
- Export `Parser` interface

### 0.1.4

- Narrow `ParseError.code` from `string` to `ErrorCode` union type
- Export `ErrorCode` type
- Optimize `extractText` — replace `.map().join("")` with `for...of` loop
- Optimize `getErrorContext` — replace `slice` + `split` with single-pass line counter
- Fix duplicate `trimStart()` call in `findMalformedWholeLineTokenCandidate`

### 0.1.3

- Comprehensive README rewrite with full API documentation
- Add LICENSE file
- Add CI publish workflow for npm and GitHub Packages
- Add pre-publish README verification step

### 0.1.1

- Fix: ensure parse errors are reported correctly
- Add golden test suite (60 cases) and dist smoke tests (36 cases)
- Add CJS + ESM dual-format build

### 0.1.0

- Initial release
- Recursive DSL parser with inline, raw, and block tag forms
- Pluggable tag handlers with graceful degradation
- Configurable syntax tokens
- Utility helpers: `parsePipeArgs`, `extractText`, `materializeTextTokens`, etc.
