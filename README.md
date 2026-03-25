# yume-dsl-rich-text

A zero-dependency, recursive rich-text DSL parser with pluggable tag handlers and configurable syntax.

**Parser core only.**  
This package does not ship built-in tags, rendering, or UI integration.  
You define your own semantics and rendering layer.

---

## Table of Contents

- [When to Use](#when-to-use)
- [Features](#features)
- [Graceful Degradation](#graceful-degradation)
- [Install](#install)
- [Quick Start](#quick-start)
- [DSL Syntax](#dsl-syntax)
  - [Inline](#inline)
  - [Raw](#raw)
  - [Block](#block)
  - [Pipe Parameters](#pipe-parameters)
  - [Escape Sequences](#escape-sequences)
- [API](#api)
  - [createParser](#createparser)
- [ParseOptions](#parseoptions)
- [Token Structure](#token-structure)
  - [Strong Typing](#strong-typing)
- [Writing Tag Handlers](#writing-tag-handlers)
- [Utility Exports](#utility-exports)
  - [PipeArgs](#pipeargs)
- [Custom Syntax](#custom-syntax)
  - [createSyntax](#createsyntax)
- [Error Handling](#error-handling)
- [Changelog](#changelog)
- [License](#license)

---

## When to Use

Use this package when you want:

- a custom rich-text mini language instead of Markdown
- high control over parsing semantics and rendering behavior
- graceful fallback when a tag form is unsupported
- a small parser core without opinionated semantics
- predictable parsing without regex-based backtracking

This package only parses DSL input into tokens.  
Rendering is entirely up to you.

---

## Features

- Zero dependencies
- Recursive parsing with depth limits
- Pluggable tag handlers
- Inline / Raw / Block tag forms
- Configurable syntax tokens
- Graceful degradation for unknown tags
- Custom error reporting
- Utility helpers for pipe arguments and token processing
- Single-pass forward scanner (no backtracking)
- No RegExp-based parsing
- Deterministic linear scan

---

## Graceful Degradation

Unknown or unsupported tags do not throw errors.  
They degrade gracefully without breaking the overall parse result.

This allows partial DSL support without crashing the parser.

---

## Install

```bash
npm install yume-dsl-rich-text
pnpm add yume-dsl-rich-text
yarn add yume-dsl-rich-text
```

---

## Quick Start

```ts
import { parseRichText } from "yume-dsl-rich-text";

const tokens = parseRichText("Hello $$bold(world)$$!", {
  handlers: {
    bold: {
      inline: (tokens) => ({ type: "bold", value: tokens }),
    },
  },
});
```

Result:

```ts
[
  { type: "text", value: "Hello ", id: "rt-0" },
  {
    type: "bold",
    value: [{ type: "text", value: "world", id: "rt-1" }],
    id: "rt-2",
  },
  { type: "text", value: "!", id: "rt-3" },
]
```

Unregistered tags degrade gracefully instead of throwing or crashing.

### stripRichText

```ts
import { stripRichText } from "yume-dsl-rich-text";

const plain = stripRichText("Hello $$bold(world)$$!");
// "Hello world!"
```

Useful for extracting searchable plain text, generating previews, or building accessibility labels.

---

## DSL Syntax

By default, the DSL uses `$$` as the tag prefix.

Three forms are supported:

### Inline

```text
$$tagName(content)$$
```

Inline content is parsed recursively, so nesting works naturally.

```text
$$bold(Hello $$italic(world)$$)$$
```

### Raw

```text
$$tagName(arg)%
raw content preserved as-is
%end$$
```

Raw content is not recursively parsed.

The close marker `%end$$` must be on its own line.

### Block

```text
$$tagName(arg)*
block content parsed recursively
*end$$
```

Block content is parsed recursively.

The close marker `*end$$` must be on its own line.

### Pipe Parameters

Inside arguments, `|` separates parameters.

```text
$$link(https://example.com | click here)$$
$$code(js | Title | label)%
const x = 1;
%end$$
```

Use `\|` to escape a literal pipe.

### Escape Sequences

Prefix syntax tokens with `\` to produce them literally.

- `\(` → `(`
- `\)` → `)`
- `\|` → `|`
- `\\` → `\`
- `\%end$$` → `%end$$`
- `\*end$$` → `*end$$`

---

## API

### `parseRichText(text, options?)`

Parses a DSL string into a token tree.

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];
```

### `stripRichText(text, options?)`

Parses a DSL string and flattens the result into plain text.

```ts
function stripRichText(text: string, options?: ParseOptions): string;
```

### `createParser(defaults)`

Creates a reusable parser instance with pre-bound options. Avoids passing the same handlers on every call.

```ts
import { createParser } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    bold: { inline: (tokens) => ({ type: "bold", value: tokens }) },
    // ...
  },
});

// No need to pass handlers again
dsl.parse("Hello $$bold(world)$$!");
dsl.strip("Hello $$bold(world)$$!");

// Still accepts per-call overrides
dsl.parse(text, { onError: (e) => console.warn(e) });
```

```ts
interface Parser {
  parse: (text: string, overrides?: ParseOptions) => TextToken[];
  strip: (text: string, overrides?: ParseOptions) => string;
}
```

When `overrides` is provided, it is shallow-merged onto the defaults (`{ ...defaults, ...overrides }`).

---

## ParseOptions

```ts
interface ParseOptions {
  handlers?: Record<string, TagHandler>;
  blockTags?: string[];
  depthLimit?: number;
  mode?: "render" | "highlight";
  onError?: (error: ParseError) => void;
  syntax?: Partial<SyntaxInput>;
}
```

### Fields

- `handlers`: tag name → handler definition
- `blockTags`: tags treated as block-level for line-break normalization
- `depthLimit`: maximum nesting depth, default `50`
- `mode`:
  - `"render"` normalizes block line breaks
  - `"highlight"` preserves them
- `onError`: callback for parse errors
- `syntax`: override default syntax tokens

---

## Token Structure

```ts
interface TextToken {
  type: string;
  value: string | TextToken[];
  id: string;
}
```

`TextToken` is the parser's output type. The `type` and `value` fields are intentionally loose (`string`) so the parser can represent any tag without knowing your schema.

Handlers return `TokenDraft`, which allows arbitrary extra fields:

```ts
interface TokenDraft {
  type: string;
  value: string | TextToken[];
  [key: string]: unknown;
}
```

Extra fields (e.g. `url`, `lang`, `title`) are preserved on the resulting `TextToken` at runtime, but are not visible to TypeScript without a cast.

### Strong Typing

`parseRichText` returns `TextToken[]` where `type` is `string`. To get full type safety for your own token schema, define a discriminated union and cast once at the call site:

```ts
import { parseRichText } from "yume-dsl-rich-text";

// 1. Define your token types
interface PlainText {
  type: "text";
  value: string;
  id: string;
}

interface BoldToken {
  type: "bold";
  value: MyToken[];
  id: string;
}

interface LinkToken {
  type: "link";
  url: string;
  value: MyToken[];
  id: string;
}

interface CodeBlockToken {
  type: "code-block";
  lang: string;
  value: string;
  id: string;
}

type MyToken = PlainText | BoldToken | LinkToken | CodeBlockToken;

// 2. Cast once at the call site
const tokens = parseRichText(input, options) as MyToken[];

// 3. Narrow with discriminated unions
function render(token: MyToken): string {
  switch (token.type) {
    case "text":
      return token.value; // string
    case "bold":
      return `<b>${token.value.map(render).join("")}</b>`;
    case "link":
      return `<a href="${token.url}">${token.value.map(render).join("")}</a>`;
    case "code-block":
      return `<pre data-lang="${token.lang}">${token.value}</pre>`;
  }
}
```

The cast is safe as long as your handlers return drafts that match the union.
If you add or remove tags, update the union accordingly — TypeScript will flag any unhandled `type` in exhaustive switches.

---

## Writing Tag Handlers

A `TagHandler` can define behavior for any of the three tag forms.

```ts
interface TagHandler {
  inline?: (tokens: TextToken[]) => TokenDraft;
  raw?: (arg: string | undefined, content: string) => TokenDraft;
  block?: (arg: string | undefined, content: TextToken[]) => TokenDraft;
}
```

You only need to implement the forms your tag supports.  
Unsupported forms fall back gracefully instead of breaking the parse.

### Example

```ts
import {
  extractText,
  parsePipeArgs,
  parseRichText,
} from "yume-dsl-rich-text";

const handlers = {
  bold: {
    inline: (tokens) => ({ type: "bold", value: tokens }),
  },

  link: {
    inline: (tokens) => {
      const args = parsePipeArgs(tokens);

      return {
        type: "link",
        url: args.text(0),
        value:
          args.parts.length > 1
            ? args.materializedTailTokens(1)
            : args.materializedTokens(0),
      };
    },
  },

  code: {
    raw: (arg, content) => ({
      type: "code-block",
      lang: arg ?? "text",
      value: content,
    }),
  },

  info: {
    block: (arg, content) => ({
      type: "info",
      title: arg || "Info",
      value: content,
    }),

    inline: (tokens) => {
      const args = parsePipeArgs(tokens);

      return {
        type: "info",
        title: extractText(args.materializedTokens(0)),
        value: args.materializedTailTokens(1),
      };
    },
  },
};

const input = `
Hello $$bold(world)$$!

$$info(Notice)*
This is a $$bold(block)$$ example.
*end$$

$$code(ts)%
const answer = 42;
%end$$
`;

const tokens = parseRichText(input, { handlers });
```

### Recommended: createParser

In practice you'll usually reuse the same handlers everywhere.
Use [`createParser`](#createparser) to bind them once:

```ts
import { createParser } from "yume-dsl-rich-text";

const dsl = createParser({ handlers });

// use everywhere
dsl.parse(text);
dsl.strip(text);

// add onError when needed
dsl.parse(text, { onError: (error) => console.warn(error) });
```

---

## Utility Exports

These helpers are useful when writing handlers.

| Export | Description |
|--------|-------------|
| `parsePipeArgs(tokens)` | Split tokens by `\|` and access parsed parts |
| `parsePipeTextArgs(text)` | Same as above, but from plain text |
| `splitTokensByPipe(tokens)` | Low-level token splitter |
| `extractText(tokens)` | Flatten a token tree into plain text |
| `materializeTextTokens(tokens)` | Unescape text tokens in a tree |
| `unescapeInline(str)` | Unescape a single string |
| `createToken(draft)` | Add an auto-incremented `id` to a token draft |
| `resetTokenIdSeed()` | Reset the token id counter, useful in tests |

### PipeArgs

`parsePipeArgs` and `parsePipeTextArgs` return a `PipeArgs` object:

```ts
interface PipeArgs {
  parts: TextToken[][];
  text: (index: number) => string;
  materializedTokens: (index: number) => TextToken[];
  materializedTailTokens: (startIndex: number) => TextToken[];
}
```

| Field | Description |
|-------|-------------|
| `parts` | Raw token arrays split by `\|` |
| `text(i)` | Plain text of part `i`, unescaped and trimmed |
| `materializedTokens(i)` | Unescaped tokens of part `i` |
| `materializedTailTokens(i)` | All parts from index `i` onward, merged into one token array |

---

## Custom Syntax

You can override syntax tokens through `options.syntax`.

```ts
import { parseRichText } from "yume-dsl-rich-text";

const tokens = parseRichText("@@bold(hello)@@", {
  syntax: {
    tagPrefix: "@@",
    endTag: ")@@",
  },
  handlers: {
    bold: {
      inline: (tokens) => ({ type: "bold", value: tokens }),
    },
  },
});
```

### Default Syntax

```ts
import { DEFAULT_SYNTAX } from "yume-dsl-rich-text";

// {
//   tagPrefix: "$$",
//   tagOpen: "(",
//   tagClose: ")",
//   tagDivider: "|",
//   endTag: ")$$",
//   rawOpen: ")%",
//   blockOpen: ")*",
//   blockClose: "*end$$",
//   rawClose: "%end$$",
//   escapeChar: "\\",
// }
```

> Warning:
> Syntax tokens must remain distinguishable from one another.
> If two tokens are configured to the same string, behavior is undefined.

### createSyntax

`createSyntax` builds a full `SyntaxConfig` from partial overrides. This is useful if you need to inspect or reuse the resolved syntax outside of parsing.

```ts
import { createSyntax } from "yume-dsl-rich-text";

const syntax = createSyntax({ tagPrefix: "@@", endTag: ")@@" });

// SyntaxConfig extends SyntaxInput with a precomputed field:
// syntax.escapableTokens — tokens that can be escaped, sorted by length (descending)
```

```ts
interface SyntaxConfig extends SyntaxInput {
  escapableTokens: string[];
}
```

You do not need `createSyntax` for normal usage — `options.syntax` accepts a `Partial<SyntaxInput>` and the parser resolves it internally.

---

## Error Handling

Use `onError` to collect parse errors.

```ts
import type { ParseError } from "yume-dsl-rich-text";

const errors: ParseError[] = [];

parseRichText("$$bold(unclosed", {
  onError: (error) => errors.push(error),
});

// errors[0]
// {
//   code: "INLINE_NOT_CLOSED",
//   message: "(L1:C1) Inline tag not closed:  >>>$$bold(<<< unclosed",
//   line: 1,
//   column: 1,
//   snippet: " >>>$$bold(<<< unclosed"
// }
```

If `onError` is omitted, malformed markup degrades gracefully and errors are silently discarded.

### Error Codes

`ParseError.code` is typed as `ErrorCode`, a union of all possible error codes:

```ts
type ErrorCode =
  | "DEPTH_LIMIT"
  | "UNEXPECTED_CLOSE"
  | "INLINE_NOT_CLOSED"
  | "BLOCK_NOT_CLOSED"
  | "BLOCK_CLOSE_MALFORMED"
  | "RAW_NOT_CLOSED"
  | "RAW_CLOSE_MALFORMED";
```

| Code | Meaning |
|------|---------|
| `DEPTH_LIMIT` | Nesting exceeded `depthLimit` |
| `UNEXPECTED_CLOSE` | Stray close tag with no matching open |
| `INLINE_NOT_CLOSED` | Inline tag was never closed |
| `BLOCK_NOT_CLOSED` | Block close marker is missing |
| `BLOCK_CLOSE_MALFORMED` | Block close marker exists but is malformed |
| `RAW_NOT_CLOSED` | Raw close marker is missing |
| `RAW_CLOSE_MALFORMED` | Raw close marker exists but is malformed |

---

## Changelog

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

---

## License

MIT