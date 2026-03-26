**English** | [中文](./README.zh-CN.md)

# yume-dsl-rich-text(ユメテキスト)

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

A zero-dependency, recursive rich-text DSL parser with pluggable tag handlers and configurable syntax.

**Parser core only.**  
This package does not ship built-in tags, rendering, or UI integration.  
You define your own semantics and rendering layer.

---

## Table of Contents

- [Design Philosophy](#design-philosophy)
- [When to Use](#when-to-use)
- [Boundaries](#boundaries)
- [Features](#features)
- [Install](#install)
- [Quick Start](#quick-start)
- [DSL Syntax](#dsl-syntax)
  - [Inline](#inline)
  - [Raw](#raw)
  - [Block](#block)
  - [Pipe Parameters](#pipe-parameters)
  - [Escape Sequences](#escape-sequences)
- [API](#api)
  - [createParser](#createparserdefaults--recommended-entry-point)
  - [parseRichText / stripRichText](#parserichtext--striprichtext)
- [Handler Helpers](#handler-helpers)
  - [createSimpleInlineHandlers](#createsimpleinlinehandlersnames)
  - [declareMultilineTags](#declaremultilinetagsnames)
  - [createSimpleBlockHandlers](#createsimpleblockhandlersnames)
  - [createSimpleRawHandlers](#createsimplerawhandlersnames)
  - [createPassthroughTags (advanced)](#createpassthroughtagsnames-advanced)
- [ParseOptions](#parseoptions)
- [Token Structure](#token-structure)
  - [Strong Typing](#strong-typing)
- [Writing Tag Handlers](#writing-tag-handlers)
- [Utility Exports](#utility-exports)
  - [PipeArgs](#pipeargs)
- [Custom Syntax](#custom-syntax)
  - [createSyntax](#createsyntax)
- [Error Handling](#error-handling)
- [Graceful Degradation](#graceful-degradation)
- [Changelog](#changelog)
- [License](#license)

---

## Design Philosophy

This parser follows a **"parser core + user-defined semantics"** architecture:

- **The parser knows nothing about your tags.** There are no built-in `bold`, `link`, or `code` tags. Every tag's
  meaning is defined by the handler you register.
- **Handlers are the semantic layer.** A handler receives parsed tokens and returns a `TokenDraft` — you decide the
  output shape, extra fields, and behavior.
- **Rendering is not our job.** The parser produces a token tree; how you render it (React, Vue, plain HTML, terminal)is
  entirely up to you.
- **Graceful degradation by default.** Unknown or unsupported tags never throw — they degrade silently so partial DSL
  support works without crashing.

This separation means you can swap rendering frameworks, add new tags, or change tag semantics without touching the
parser.

---

## When to Use

Use this package when you want:

- a custom rich-text mini language instead of Markdown
- high control over parsing semantics and rendering behavior
- graceful fallback when a tag form is unsupported
- a small parser core without opinionated semantics
- predictable parsing without regex-based backtracking

---

## Boundaries

What this package **does**:

- Parse DSL strings into a token tree (`TextToken[]`)
- Provide tag registration via handlers — tags only exist if you register them
- Handle recursive nesting, escaping, pipe-separated arguments
- Degrade gracefully when tags are unknown or malformed
- Report structured errors via `onError`

What this package **does not do**:

- Ship any built-in tags (no bold, italic, link, etc.)
- Render tokens to HTML, React components, or any output format
- Validate token semantics (that's your handler's job)
- Provide a Markdown-compatible syntax

---

## Features

- Zero dependencies
- Recursive parsing with depth limits
- Pluggable tag handlers
- Inline / Raw / Block tag forms
- Handler helpers for bulk tag registration
- Configurable syntax tokens
- Graceful degradation for unknown tags
- Custom error reporting
- Utility helpers for pipe arguments and token processing
- Single-pass forward scanner (no backtracking)
- No RegExp-based parsing
- Deterministic linear scan

---

## Install

```bash
npm install yume-dsl-rich-text
pnpm add yume-dsl-rich-text
yarn add yume-dsl-rich-text
```

---

## Quick Start

### 1. Create a parser and register your tags

```ts
import {
  createParser,
  createSimpleInlineHandlers,
  createSimpleBlockHandlers,
  createSimpleRawHandlers,
  declareMultilineTags,
} from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold", "italic", "underline", "strike"]),
    ...createSimpleBlockHandlers(["info", "warning"]),
    ...createSimpleRawHandlers(["code"]),
  },
  blockTags: declareMultilineTags(["info", "warning", "code"]),
});
```

### 2. Parse

```ts
const tokens = dsl.parse("Hello $$bold(world)$$!");
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

### 3. Strip to plain text

```ts
const plain = dsl.strip("Hello $$bold(world)$$!");
// "Hello world!"
```

Useful for extracting searchable plain text, generating previews, or building accessibility labels.

Unregistered tags degrade gracefully instead of throwing or crashing.

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

### `createParser(defaults)` — recommended entry point

`createParser` binds your `ParseOptions` (handlers, syntax, mode, depthLimit, onError) into a reusable instance.
This is the **recommended way** to use the parser — define your tag handlers once, then call `dsl.parse()` /
`dsl.strip()` everywhere without repeating config.

```ts
import {
  createParser,
  createSimpleInlineHandlers,
  parsePipeArgs,
} from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold", "italic", "underline"]),

    link: {
      inline: (tokens) => {
        const args = parsePipeArgs(tokens);
        return {
          type: "link",
          url: args.text(0),
          value: args.materializedTailTokens(1),
        };
      },
    },
  },
});

// Use everywhere — handlers are already bound
dsl.parse("Hello $$bold(world)$$!");
dsl.strip("Hello $$bold(world)$$!");

// Per-call overrides are shallow-merged onto defaults
dsl.parse(text, { onError: (e) => console.warn(e) });
```

**What `createParser` binds:**

| Option       | What it does when pre-bound                               |
|--------------|-----------------------------------------------------------|
| `handlers`   | Your tag definitions — no need to pass them on every call |
| `syntax`     | Custom syntax tokens (if you override `$$` prefix, etc.)  |
| `mode`       | `"render"` or `"highlight"` — set once for your use case  |
| `depthLimit` | Nesting limit — rarely changes per call                   |
| `onError`    | Default error handler (can still be overridden per call)  |

**Without `createParser`** you must pass the full options object on every call:

```ts
// Repetitive — must pass handlers everywhere
parseRichText(text1, { handlers });
parseRichText(text2, { handlers });
stripRichText(text3, { handlers });

// With createParser — bind once, use everywhere
const dsl = createParser({ handlers });
dsl.parse(text1);
dsl.parse(text2);
dsl.strip(text3);
```

```ts
interface Parser {
  parse: (text: string, overrides?: ParseOptions) => TextToken[];
  strip: (text: string, overrides?: ParseOptions) => string;
}
```

### `parseRichText` / `stripRichText`

Low-level stateless functions. Useful for one-off calls or when you need full control per invocation.

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];

function stripRichText(text: string, options?: ParseOptions): string;
```

For most applications, prefer [`createParser`](#createparser--recommended-entry-point) instead.

---

## Handler Helpers

Most tags in a typical project are simple wrappers — bold, italic, underline, etc. — that don't need custom logic.
Writing a full `{ inline: (tokens) => ({ type: "bold", value: ... }) }` for each one is tedious. Handler helpers let you
register them in bulk.

### `createSimpleInlineHandlers(names)`

Creates inline-only tag handlers for a list of tag names.
Each handler materializes child tokens and wraps them in `{ type: tagName, value: materializedTokens }`.

This is the **recommended way** to register simple tags.

```ts
import { createParser, createSimpleInlineHandlers } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    // Register 5 tags in one line instead of 5 handler objects
    ...createSimpleInlineHandlers(["bold", "italic", "underline", "strike", "code"]),

    // Mix with custom handlers that need more logic
    link: {
      inline: (tokens) => { /* ... */
      }
    },
  },
});
```

**What it replaces:**

```ts
// Before — repetitive
bold:      {
  inline: (tokens) => ({ type: "bold", value: materializeTextTokens(tokens) })
}
,
italic:    {
  inline: (tokens) => ({ type: "italic", value: materializeTextTokens(tokens) })
}
,
underline: {
  inline: (tokens) => ({ type: "underline", value: materializeTextTokens(tokens) })
}
,

// After — one call
...
createSimpleInlineHandlers(["bold", "italic", "underline"])
```

```ts
function createSimpleInlineHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `declareMultilineTags(names)`

Declares which already-registered tags are multiline types. Returns a `string[]` to pass as `ParseOptions.blockTags`.

This does **not** register tags or create handlers — it only tells the parser which tags need line-break normalization (
stripping the leading `\n` after `)*` / `)%` openers and the trailing `\n` before `*end$$` / `%end$$` closers).

```ts
import { createParser, createSimpleInlineHandlers, declareMultilineTags } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold", "italic"]),
    info: { /* custom handler registered separately */ },
    warning: { /* custom handler registered separately */ },
  },
  blockTags: declareMultilineTags(["info", "warning"]),
});
```

> **Note:** If you omit `blockTags`, the parser auto-derives it from handlers that have `raw` or `block` methods.
> Use `declareMultilineTags` when you need explicit control over which tags receive line-break normalization.

```ts
function declareMultilineTags(names: readonly string[]): string[];
```

### `createSimpleBlockHandlers(names)`

Creates block-only tag handlers for the DSL's multiline block form: `$$tag(arg)* ... *end$$`.
The closing marker `*end$$` must stay on its own line, so this form is best treated as a standalone block rather than
inline text.
Each handler passes through the `arg` and recursively-parsed content:
`{ type: tagName, arg, value: content }`.

```ts
import { createParser, createSimpleInlineHandlers, createSimpleBlockHandlers } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold", "italic"]),
    ...createSimpleBlockHandlers(["info", "warning"]),
  },
});

dsl.parse("$$info(Notice)*\nThis is a $$bold(block)$$ example.\n*end$$");
// → [{ type: "info", arg: "Notice", value: [... parsed tokens ...], id: "..." }]
```

```ts
function createSimpleBlockHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `createSimpleRawHandlers(names)`

Creates raw-only tag handlers for the DSL's multiline raw form. Each handler passes through the `arg` and raw string
content:
`{ type: tagName, arg, value: content }`.

Use this for raw tags that preserve content as-is — `$$tagName(arg)%...%end$$`.
As with block tags, `%end$$` must be on its own line, so this form should be written as a multiline block.

```ts
import { createParser, createSimpleRawHandlers } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createSimpleRawHandlers(["code", "math"]),
  },
});

dsl.parse(`$$code(ts)%
const x = 1;
%end$$`);
// → [{ type: "code", arg: "ts", value: "const x = 1;", id: "..." }]
```

```ts
function createSimpleRawHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `createPassthroughTags(names)` (advanced)

> For most use cases, prefer `createSimpleInlineHandlers` above.

Creates empty tag handlers (`{}`) that register tag names with the parser but contain no logic.
The parser produces `{ type: tagName, value: materializedTokens }` for recognized tags without an `inline` method — the
same output shape as `createSimpleInlineHandlers`.

The difference is **explicit vs implicit**: `createSimpleInlineHandlers` explicitly declares each tag's inline behavior;
`createPassthroughTags` relies on you knowing that the parser's default for recognized tags already produces typed
tokens. This also means `handler.inline` is `undefined`, which matters if external code inspects handlers directly.

```ts
import { createParser, createPassthroughTags } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createPassthroughTags(["bold", "italic"]),
  },
});
```

```ts
function createPassthroughTags(names: readonly string[]): Record<string, TagHandler>;
```

---

## ParseOptions

```ts
interface ParseOptions {
  handlers?: Record<string, TagHandler>;
  allowForms?: readonly ("inline" | "raw" | "block")[];
  blockTags?: string[];
  depthLimit?: number;
  mode?: "render" | "highlight";
  onError?: (error: ParseError) => void;
  syntax?: Partial<SyntaxInput>;
}
```

### Fields

- `handlers`: tag name → handler definition
- `allowForms`: restrict which tag forms are parsed (default: all forms enabled)
- `blockTags`: tags treated as block-level for line-break normalization
- `depthLimit`: maximum nesting depth, default `50`
- `mode`:
  - `"render"` normalizes block line breaks
  - `"highlight"` preserves them
- `onError`: callback for parse errors
- `syntax`: override default syntax tokens

### allowForms

Controls which tag forms the parser will accept. Forms not listed are treated as if the handler does not support them —
the parser degrades gracefully.

In practice, disabled forms are left as plain text. This applies globally, including unregistered tags. If `"inline"`
is disabled, `$$unknown(...)$$` is preserved literally instead of being unwrapped.

```ts
// Only allow inline tags — block and raw syntax is ignored
const dsl = createParser({
  handlers,
  allowForms: ["inline"],
});

// Allow inline and block, but not raw
const dsl2 = createParser({
  handlers,
  allowForms: ["inline", "block"],
});
```

This is useful for user-generated content (comments, chat messages) where you want to allow simple inline formatting but
prevent multi-line block or raw tags.

When omitted, all forms are enabled.

---

## Token Structure

```ts
interface TextToken {
  type: string;
  value: string | TextToken[];
  id: string;

  [key: string]: unknown;
}
```

`TextToken` is the parser's output type. The `type` and `value` fields are intentionally loose (`string`) so the parser
can represent any tag without knowing your schema.

Extra fields returned by handlers (e.g. `url`, `lang`, `title`) are preserved on the resulting `TextToken` and
accessible as `unknown`. You can read them directly without a cast — just narrow the type before use:

```ts
const token = tokens[0];
if (token.type === "link" && typeof token.href === "string") {
  console.log(token.href); // works, no cast needed
}
```

Handlers return `TokenDraft`, which shares the same open structure:

```ts
interface TokenDraft {
  type: string;
  value: string | TextToken[];

  [key: string]: unknown;
}
```

### Strong Typing

For simple use cases, you can access extra fields directly via `typeof` narrowing — no cast needed.

For full type safety across your entire token schema, define typed interfaces that extend `TextToken` and cast once at
the call site:

```ts
import { parseRichText, type TextToken } from "yume-dsl-rich-text";

// 1. Define your token types — extend TextToken for compatibility
interface PlainText extends TextToken {
  type: "text";
  value: string;
}

interface BoldToken extends TextToken {
  type: "bold";
  value: MyToken[];
}

interface LinkToken extends TextToken {
  type: "link";
  url: string;
  value: MyToken[];
}

interface CodeBlockToken extends TextToken {
  type: "code-block";
  lang: string;
  value: string;
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
If you add or remove tags, update the union accordingly — TypeScript will flag any unhandled `type` in exhaustive
switches.

---

## Writing Tag Handlers

For tags that need custom logic — extracting parameters, attaching extra fields, supporting multiple forms — you write a
`TagHandler` manually.

Use [handler helpers](#handler-helpers) for simple wrapper tags. Write custom handlers when you need:

- **Pipe parameters** — e.g., `$$link(url | display text)$$`
- **Extra fields** on the output token — e.g., `url`, `lang`, `title`
- **Multiple forms** — the same tag supporting inline, raw, and block syntax
- **Transformation logic** — e.g., language alias mapping for code blocks

### TagHandler interface

```ts
interface TagHandler {
  inline?: (tokens: TextToken[]) => TokenDraft;
  raw?: (arg: string | undefined, content: string) => TokenDraft;
  block?: (arg: string | undefined, content: TextToken[]) => TokenDraft;
}
```

You only need to implement the forms your tag supports.
Unsupported forms fall back gracefully instead of breaking the parse.

### Example: full handler set

```ts
import {
  createParser,
  createSimpleInlineHandlers,
  extractText,
  parsePipeArgs,
} from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    // Simple tags — use helpers
    ...createSimpleInlineHandlers(["bold", "italic", "underline"]),

    // Custom: pipe parameters → extra fields
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

    // Custom: raw form → preserves content as-is
    code: {
      raw: (arg, content) => ({
        type: "code-block",
        lang: arg ?? "text",
        value: content,
      }),
    },

    // Custom: supports both inline and block forms
    info: {
      inline: (tokens) => {
        const args = parsePipeArgs(tokens);
        return {
          type: "info",
          title: extractText(args.materializedTokens(0)),
          value: args.materializedTailTokens(1),
        };
      },
      block: (arg, content) => ({
        type: "info",
        title: arg || "Info",
        value: content,
      }),
    },
  },
});
```

Input:

```text
Hello $$bold(world)$$!

$$info(Notice)*
This is a $$bold(block)$$ example.
*end$$

$$code(ts)%
const answer = 42;
%end$$
```

```ts
const tokens = dsl.parse(input);
```

---

## Utility Exports

These helpers serve **handler authors** — they solve common problems when writing custom `TagHandler` implementations.

You will not need these if you only use `createSimpleInlineHandlers` / `createPassthroughTags`.

| Export                              | Who uses it                                | Description                                                |
|-------------------------------------|--------------------------------------------|------------------------------------------------------------|
| `parsePipeArgs(tokens)`             | Custom handlers with `\|`-separated params | Split tokens by pipe and access parsed parts               |
| `parsePipeTextArgs(text)`           | Custom handlers parsing raw args           | Same as above, but from a plain text string                |
| `splitTokensByPipe(tokens)`         | Low-level handler code                     | Raw token splitter without helper methods                  |
| `extractText(tokens)`               | Handlers that need plain-text values       | Flatten a token tree into a single string                  |
| `materializeTextTokens(tokens)`     | Handlers returning processed child tokens  | Recursively unescape text tokens in a tree                 |
| `unescapeInline(str)`               | Handlers processing raw strings            | Unescape DSL escape sequences in a single string           |
| `createToken(draft)`                | Handlers building tokens manually          | Add an auto-incremented `id` to a `TokenDraft`             |
| `resetTokenIdSeed()`                | Test code                                  | Reset the token id counter for deterministic test output   |
| `createSimpleInlineHandlers(names)` | Setup code                                 | Create inline handlers for simple tags in bulk             |
| `declareMultilineTags(names)`       | Setup code                                 | Declare which tags need multiline line-break normalization |
| `createSimpleBlockHandlers(names)`  | Setup code                                 | Create block-form handlers for simple tags in bulk         |
| `createSimpleRawHandlers(names)`    | Setup code                                 | Create raw handlers for simple tags in bulk                |
| `createPassthroughTags(names)`      | Setup code                                 | Register tag names with empty handlers in bulk             |

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

| Field                       | Description                                                  |
|-----------------------------|--------------------------------------------------------------|
| `parts`                     | Raw token arrays split by `\|`                               |
| `text(i)`                   | Plain text of part `i`, unescaped and trimmed                |
| `materializedTokens(i)`     | Unescaped tokens of part `i`                                 |
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

`createSyntax` builds a full `SyntaxConfig` from partial overrides. This is useful if you need to inspect or reuse the
resolved syntax outside of parsing.

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

You do not need `createSyntax` for normal usage — `options.syntax` accepts a `Partial<SyntaxInput>` and the parser
resolves it internally.

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

| Code                    | Meaning                                    |
|-------------------------|--------------------------------------------|
| `DEPTH_LIMIT`           | Nesting exceeded `depthLimit`              |
| `UNEXPECTED_CLOSE`      | Stray close tag with no matching open      |
| `INLINE_NOT_CLOSED`     | Inline tag was never closed                |
| `BLOCK_NOT_CLOSED`      | Block close marker is missing              |
| `BLOCK_CLOSE_MALFORMED` | Block close marker exists but is malformed |
| `RAW_NOT_CLOSED`        | Raw close marker is missing                |
| `RAW_CLOSE_MALFORMED`   | Raw close marker exists but is malformed   |

---

## Graceful Degradation

The parser never throws on malformed or unrecognized input. Instead, it degrades content to plain text and optionally
reports errors via `onError`. Below are the concrete degradation scenarios.

### Unregistered tags → plain text

Tags not present in `handlers` are not recognized. Their content is unwrapped as plain text.

```ts
const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold"]),
    // "italic" is NOT registered
  },
});

dsl.parse("Hello $$bold(world)$$ and $$italic(goodbye)$$");
```

```ts
[
  { type: "text", value: "Hello ", id: "rt-0" },
  { type: "bold", value: [{ type: "text", value: "world", id: "rt-1" }], id: "rt-2" },
  { type: "text", value: " and goodbye", id: "rt-3" },
  //                      ↑ "italic" is unregistered — content becomes plain text
]
```

### Unsupported form on a registered tag → fallback text

A handler only needs to implement the forms it supports. If a tag is used in a form the handler doesn't cover, the
entire markup degrades to plain text.

```ts
const dsl = createParser({
  handlers: {
    // "note" only supports inline, not raw
    note: { inline: (tokens) => ({ type: "note", value: tokens }) },
  },
});

dsl.parse("$$note(ok)%\nraw content\n%end$$");
```

```ts
// The raw form is not supported → entire tag degrades to fallback text
[
  { type: "text", value: "$$note(ok)%\nraw content\n%end$$", id: "rt-0" },
]
```

### `allowForms` restriction → form stripped

When `allowForms` excludes a form, the parser acts as if handlers don't support it — even if they do.

```ts
const dsl = createParser({
  handlers: {
    bold: { inline: (tokens) => ({ type: "bold", value: tokens }) },
    code: { raw: (arg, content) => ({ type: "code", lang: arg ?? "text", value: content }) },
  },
  allowForms: ["inline"],   // ← raw and block disabled
});

dsl.parse("$$bold(hello)$$");
// → [{ type: "bold", ... }]   ✓ inline works

dsl.parse("$$code(ts)%\nconst x = 1;\n%end$$");
// → [{ type: "text", value: "$$code(ts)%\nconst x = 1;\n%end$$", ... }]
//   ↑ raw form is disabled — entire tag degrades to plain text
```

### Unclosed tags → partial text recovery

When a tag is opened but never closed, the parser reports an error and recovers the opening markup as plain text.

```ts
const errors: ParseError[] = [];

dsl.parse("Hello $$bold(world", { onError: (e) => errors.push(e) });
// → [{ type: "text", value: "Hello $$bold(world", id: "rt-0" }]
//
// errors[0].code === "INLINE_NOT_CLOSED"
```

Without `onError`, the same recovery happens silently — no error is thrown.

---

## Changelog

### 0.1.9

- Remove source maps to reduce package size
- Fix `allowForms` so disabling `"inline"` also blocks inline syntax for tags that still have `raw` / `block`
  handlers
- Fix `allowForms` so disabling `"inline"` also preserves unregistered `$$unknown(...)$$` tags literally
- Fix `createSimpleBlockHandlers()` / `createSimpleRawHandlers()` so block-only and raw-only helpers no longer accept
  inline syntax implicitly
- Fix custom syntax parsing for multi-character `tagOpen` / `tagClose` / `tagDivider` tokens
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

---

## License

MIT
