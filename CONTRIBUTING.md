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

1. Create a branch from `main`:
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
