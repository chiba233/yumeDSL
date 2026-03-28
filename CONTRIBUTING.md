**English** | [中文](./CONTRIBUTING.zh-CN.md)

# Contributing to yumeDSL

Thanks for your interest in contributing! This guide covers how to set up the project, run tests, and submit changes.

## Ecosystem

| Package                                                                            | Description                                      |
|------------------------------------------------------------------------------------|--------------------------------------------------|
| **`yume-dsl-rich-text`**                                                           | Parser core — text to token tree (this repo)     |
| [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)       | Interpreter — token tree to output nodes         |
| [`yume-dsl-shiki-highlight`](https://github.com/chiba233/yume-dsl-shiki-highlight) | Syntax highlighting — tokens or TextMate grammar |

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
