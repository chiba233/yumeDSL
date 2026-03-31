**English** | [中文](./GUIDE.zh-CN.md)

# yume-dsl-rich-text(ユメテキスト)

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

[![npm](https://img.shields.io/npm/v/yume-dsl-rich-text)](https://www.npmjs.com/package/yume-dsl-rich-text)
[![GitHub](https://img.shields.io/badge/GitHub-chiba233%2FyumeDSL-181717?logo=github)](https://github.com/chiba233/yumeDSL)
[![CI](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml/badge.svg)](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Wiki](https://img.shields.io/badge/Wiki-docs-6A57D5?logo=gitbook&logoColor=white)](https://github.com/chiba233/yumeDSL/wiki/)
[![Contributing](https://img.shields.io/badge/Contributing-guide-blue.svg)](./CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/Security-policy-red.svg)](./SECURITY.md)

Zero-dependency, single-pass rich-text DSL parser.
Text goes in, token tree comes out — what tags mean, how they render, which framework they live in is entirely up to
you.

- **Not** a Markdown renderer, rich-text editor, or HTML pipeline
- **Is** a syntax-only token machine — you feed it rules, it returns
  structure; [syntax tokens are fully swappable](#custom-syntax)
- No regex backtracking — deterministic linear scan, runtime proportional to input length
- Inline / Raw / Block — three tag forms, fully swappable syntax tokens and tag-name rules;
  built-in [escape sequences](#escape-sequences) let any syntax token appear as literal text
- Malformed or unknown tags [degrade to plain text](#graceful-degradation) — never throws, never corrupts surrounding
  content
- Framework-agnostic, DOM-free — runs in browsers, Node, Deno, Bun, game engines, or any JS runtime
- Content-driven [stable IDs](#stable-token-ids), single-pass [position tracking](#source-position-tracking),
  handler-level [pipe parameters](#pipe-parameters) — use what you need
- [`parseStructural`](#parsestructural--structural-parse) gives you a lightweight map of the document; paired with [
  `yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)'s `parseSlice`, you jump to any region and
  get fully positioned `TextToken[]` without re-parsing the whole document

**Use cases:**
game dialogue & visual novels (typewriter / shake / color tags you invent),
chat & comments (safe UGC with graceful degradation),
CMS & blogs, documentation pipelines, localization workflows (translators edit text, not markup)

```tsx
// React — render tokens recursively
const RichText: FC<{tokens: TextToken[]}> = ({tokens}) => (
    <>{tokens.map(t =>
        t.type === "text" ? <span key={t.id}>{t.value as string}</span>
        : <strong key={t.id}><RichText tokens={t.value as TextToken[]} /></strong>
    )}</>
);
```

```vue
<!-- Vue 3 — same idea, template syntax -->
<template>
  <template v-for="t in tokens" :key="t.id">
    <span v-if="t.type === 'text'">{{ t.value }}</span>
    <strong v-else><RichText :tokens="t.value" /></strong>
  </template>
</template>
```

> Full rendering guides: [Vue 3](https://github.com/chiba233/yumeDSL/wiki/en-Vue-3-Rendering) ·
> [React](https://github.com/chiba233/yumeDSL/wiki/en-React-Rendering)

### [▶ Live Demo — DSL Fallback Museum](https://qwwq.org/blog/dsl-fallback-museum)

Shiki code highlighting · valid tags · intentionally malformed markup · error reporting

> **Version note:** if a tag supports both inline and block/raw forms, use `1.0.7+`.
> `createParser` partial-override fix require `1.0.11+`.

## Ecosystem

| Package                                                                            | Role                                             |
|------------------------------------------------------------------------------------|--------------------------------------------------|
| **`yume-dsl-rich-text`**                                                           | Parser core — text to token tree (this package)  |
| [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)       | Interpreter — token tree to output nodes         |
| [`yume-dsl-shiki-highlight`](https://github.com/chiba233/yume-dsl-shiki-highlight) | Syntax highlighting — tokens or TextMate grammar |
| [`yume-dsl-markdown-it`](https://github.com/chiba233/yume-dsl-markdown-it)         | markdown-it plugin — DSL tags inside Markdown    |

**Recommended combinations:**

- **Parse DSL into tokens only** → `yume-dsl-rich-text`
- **Interpret token trees into arbitrary output nodes** → add `yume-dsl-token-walker`
- **Source-level highlighting or TextMate grammar** → add `yume-dsl-shiki-highlight`
- **Render DSL inside Markdown (markdown-it)** → add `yume-dsl-markdown-it`

---

## Design Philosophy

- **No built-in tags.** Every tag's meaning is defined by the handler you register.
- **Handlers are the semantic layer.** A handler receives parsed tokens and returns a `TokenDraft` — output shape,
  extra fields, and behavior are all yours.
- **Rendering is not our job.** The parser produces a token tree; how you render it (React, Vue, plain HTML, terminal)
  is entirely up to you.
- **Graceful degradation.** Unknown or unsupported tags never throw — they degrade silently.
- **Everything is configurable.** Syntax tokens, tag-name rules, nesting depth — override what you need, keep defaults
  for the rest.

---

## Quick Navigation

[Install](#install) · [Quick Start](#quick-start) · [DSL Syntax](#dsl-syntax) · [API](#api) · [Custom Syntax](#custom-syntax) · [Handler Helpers](#handler-helpers) · [ParseOptions](#parseoptions) · [Token Structure](#token-structure) · [Stable Token IDs](#stable-token-ids) · [Writing Tag Handlers](#writing-tag-handlers-advanced) · [Exports](#exports) · [Source Position Tracking](#source-position-tracking) · [Error Handling](#error-handling) · [Deprecated API](#deprecated-api) · [Changelog](#changelog)

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
    {type: "text", value: "Hello ", id: "rt-0"},
    {
        type: "bold",
        value: [{type: "text", value: "world", id: "rt-1"}],
        id: "rt-2",
    },
    {type: "text", value: "!", id: "rt-3"},
]
```

### 3. Strip to plain text

```ts
const plain = dsl.strip("Hello $$bold(world)$$!");
// "Hello world!"
```

Useful for extracting searchable plain text, generating previews, or building accessibility labels.

Unregistered tags degrade gracefully instead of throwing or crashing.

### Recommended reading order

First-time users:

1. **Quick Start** (you are here)
2. [DSL Syntax](#dsl-syntax) — the three tag forms
3. [createParser](#createparserdefaults--recommended-entry-point) — the main entry point
4. [Handler Helpers](#handler-helpers) — bulk-register tags without boilerplate
5. [Writing Tag Handlers (advanced)](#writing-tag-handlers-advanced) — custom handler logic
6. [parseStructural](#parsestructural--structural-parse) — for structural consumers (highlighting, linting, editors,
   source inspection)

**Hands-on tutorials** — step-by-step guides on the [Wiki](https://github.com/chiba233/yumeDSL/wiki#tutorials):

- [Building a Link Tag from Scratch](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Link-Tag) — from zero to a working `$$link(url | text)$$`
- [Game Dialogue Tags](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Game-Dialogue) — shake / color / wait tags for a visual novel typewriter
- [Safe UGC Chat](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Safe-UGC) — whitelist inline tags, block dangerous forms, handle errors

---

## DSL Syntax

By default, the DSL uses `$$` as the tag prefix. All syntax tokens (prefix, delimiters, escape character, block/raw
markers) are fully configurable — see [Custom Syntax](#custom-syntax) to adapt the DSL to your host markup.
Tag names allow `a-z`, `A-Z`, `0-9`, `_`, `-` (first character must not be a digit or `-`).
See [Custom Tag Name Characters](#custom-tag-name-characters) to override these rules.

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

`createParser` binds your `ParseOptions` (handlers, syntax, tagName, depthLimit, onError, trackPositions) into a
reusable instance.
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
            inline: (tokens, ctx) => {
                const args = parsePipeArgs(tokens, ctx);
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

// Per-call overrides are merged onto defaults.
// `syntax` and `tagName` also merge one level deep so partial overrides keep the rest.
dsl.parse(text, {onError: (e) => console.warn(e)});
```

**What `createParser` binds:**

Most of the time you only need to bind `handlers`. The rest just tags along for convenience.

| Option           | What it does when pre-bound                                              |
|------------------|--------------------------------------------------------------------------|
| **`handlers`**   | **Your tag definitions — the main reason to use `createParser`**         |
| `syntax`         | Custom syntax tokens (if you override `$$` prefix, etc.)                 |
| `tagName`        | Custom tag-name character rules                                          |
| `allowForms`     | Restrict accepted tag forms (default: all forms enabled)                 |
| `depthLimit`     | Nesting limit — rarely changes per call                                  |
| `createId`       | Custom token id generator (can be overridden per call)                   |
| `blockTags`      | Tags that receive block-level line-break normalization                   |
| `onError`        | Default error handler (can still be overridden per call)                 |
| `trackPositions` | Attach source positions to all output nodes (can be overridden per call) |

**Without `createParser`** you must pass the full options object on every call:

```ts
// Repetitive — must pass handlers everywhere
parseRichText(text1, {handlers});
parseRichText(text2, {handlers});
stripRichText(text3, {handlers});
parseStructural(text4, {handlers});

// With createParser — bind once, use everywhere
const dsl = createParser({handlers});
dsl.parse(text1);
dsl.parse(text2);
dsl.strip(text3);
dsl.structural(text4);
dsl.print(tree);
```

```ts
interface Parser {
    parse: (text: string, overrides?: ParseOptions) => TextToken[];
    strip: (text: string, overrides?: ParseOptions) => string;
    structural: (text: string, overrides?: StructuralParseOptions) => StructuralNode[];
    print: (nodes: StructuralNode[]) => string;
}
```

**Methods:**

| Method       | Input                  | Output              | Inherits from defaults                                                    |
|--------------|------------------------|---------------------|---------------------------------------------------------------------------|
| `parse`      | DSL text + overrides?  | `TextToken[]`       | All `ParseOptions` — overrides merge one level deep for `syntax`/`tagName`|
| `strip`      | DSL text + overrides?  | `string`            | Same as `parse`                                                           |
| `structural` | DSL text + overrides?  | `StructuralNode[]`  | `handlers`, `allowForms`, `syntax`, `tagName`, `depthLimit`, `trackPositions` |
| `print`      | `StructuralNode[]`     | `string`            | `syntax` only — lossless serializer, no gating                            |

### `parseRichText` / `stripRichText`

Low-level stateless functions. Useful for one-off calls or when you need full control per invocation.

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];

function stripRichText(text: string, options?: ParseOptions): string;
```

`ParseOptions` includes `handlers`, `allowForms`, `syntax`, `tagName`, `depthLimit`, `createId`, `blockTags`,
`onError`, and `trackPositions`. See [ParseOptions](#parseoptions) for full details.

Application code should generally use `createParser`; reach for the bare functions only in one-off utility scripts
or when you need full per-call control.

### `parseStructural` — structural parse

`parseStructural` is for **structural consumers** — highlighting, linting, editors, source inspection, or any
scenario where you need to know *which tag form* was used, not just the semantic result. It preserves the tag form
(inline / raw / block) explicitly in the output tree.

It shares the same language configuration (`handlers`, `allowForms`, `syntax`, `tagName`, `depthLimit`,
`trackPositions`) as `parseRichText`, so you don't maintain two separate sets of DSL rules.

```ts
import {parseStructural} from "yume-dsl-rich-text";

const tree = parseStructural("$$bold(hello)$$ and $$code(ts)%\nconst x = 1;\n%end$$");
// [
//   { type: "inline", tag: "bold", children: [{ type: "text", value: "hello" }] },
//   { type: "text", value: " and " },
//   { type: "raw", tag: "code",
//     args: [{ type: "text", value: "ts" }],
//     content: "\nconst x = 1;\n" },
// ]
```

```ts
function parseStructural(text: string, options?: StructuralParseOptions): StructuralNode[]
```

`StructuralParseOptions` extends `ParserBaseOptions` — the same base shared by `ParseOptions`:

```ts
interface ParserBaseOptions {
    handlers?: Record<string, TagHandler>;
    allowForms?: readonly TagForm[];
    depthLimit?: number;
    syntax?: Partial<SyntaxInput>;
    tagName?: Partial<TagNameConfig>;
    baseOffset?: number;
    tracker?: PositionTracker;
}

interface ParseOptions extends ParserBaseOptions {
    createId?,
    blockTags?,
    mode?,             // deprecated
    onError?,          // semantic-only
    trackPositions?    // shared with StructuralParseOptions
}

interface StructuralParseOptions extends ParserBaseOptions {
    trackPositions?: boolean;
}
```

| Param                    | Type                         | Description                                                                                                                               |
|--------------------------|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `text`                   | `string`                     | DSL source                                                                                                                                |
| `options.handlers`       | `Record<string, TagHandler>` | Tag recognition & form gating (same rules as `parseRichText`). Omit to accept all syntactically valid tags/forms without semantic gating. |
| `options.allowForms`     | `readonly TagForm[]`         | Restrict accepted forms (requires `handlers`)                                                                                             |
| `options.depthLimit`     | `number`                     | Max nesting depth (default `50`)                                                                                                          |
| `options.syntax`         | `Partial<SyntaxInput>`       | Override syntax tokens                                                                                                                    |
| `options.tagName`        | `Partial<TagNameConfig>`     | Override tag-name character rules                                                                                                         |
| `options.trackPositions` | `boolean`                    | Attach `position` to every node (default `false`)                                                                                         |

When `handlers` is provided, tag recognition and form gating are **identical** to `parseRichText` — the same
`supportsInlineForm` decision table and `filterHandlersByForms` logic are used (shared code, not mirrored).
Handler functions themselves are never called; only the presence of `inline` / `raw` / `block` methods matters.

When `handlers` is omitted, all syntactically valid tags in all forms are accepted.

> **Deprecated:** when called inside a `withSyntax` / `withTagNameConfig` wrapper, `parseStructural` still reads the
> ambient state, but this path is deprecated and emits a `console.warn`. Pass `options.syntax` / `options.tagName`
> explicitly instead.

**`StructuralNode` variants:**

| Type        | Fields                           | Description                   |
|-------------|----------------------------------|-------------------------------|
| `text`      | `value: string`                  | Plain text                    |
| `escape`    | `raw: string`                    | Escape sequence (e.g. `\)`)   |
| `separator` | —                                | Pipe `\|` divider (args only) |
| `inline`    | `tag`, `children`                | `$$tag(…)$$`                  |
| `raw`       | `tag`, `args`, `content: string` | `$$tag(…)% … %end$$`          |
| `block`     | `tag`, `args`, `children`        | `$$tag(…)* … *end$$`          |

All variants carry an optional `position?: SourceSpan` when `trackPositions` is enabled.

Differences from `parseRichText` (features, not bugs):

|                          | `parseRichText`                                             | `parseStructural`                                                |
|--------------------------|-------------------------------------------------------------|------------------------------------------------------------------|
| Tag recognition          | Same (shared `ParserBaseOptions`)                           | Same (shared `ParserBaseOptions`)                                |
| Form gating              | Same                                                        | Same                                                             |
| Line-break normalization | Always strips (render mode)                                 | Always preserves                                                 |
| Pipe `\|`                | Part of text                                                | `separator` node in args; text elsewhere                         |
| Error reporting          | `onError` callback                                          | Silent degradation                                               |
| Escape handling          | Unescaped at root level                                     | Structural `escape` nodes                                        |
| Position tracking        | `trackPositions` on `TextToken.position` (normalized spans) | `trackPositions` on `StructuralNode.position` (raw syntax spans) |
| Output type              | `TextToken[]`                                               | `StructuralNode[]`                                               |

**Which one do I use?** If your goal is *rendering content*, use `parseRichText`.
If your goal is *analyzing source structure*, use `parseStructural`.

### `printStructural` — structural print

`printStructural` is the inverse of `parseStructural` — it serializes a `StructuralNode[]` tree back to DSL source text.

```ts
import {parseStructural, printStructural} from "yume-dsl-rich-text";

const input = "Hello $$bold(world)$$!";
const tree = parseStructural(input);
printStructural(tree); // "Hello $$bold(world)$$!"
```

```ts
function printStructural(nodes: StructuralNode[], options?: PrintOptions): string
```

| Param            | Type                   | Description                                                               |
|------------------|------------------------|---------------------------------------------------------------------------|
| `nodes`          | `StructuralNode[]`     | The structural tree to serialize                                          |
| `options.syntax` | `Partial<SyntaxInput>` | Override syntax tokens — must match the syntax used during `parseStructural` |

Always prints full tag syntax — no gating or validation is applied.
If the tree contains nodes whose form is not supported by the runtime parser, they will be
printed with full syntax and naturally degrade to plain text when re-parsed. This is intentional:
the printer is a lossless serializer, not a validator.

You can also build trees programmatically:

```ts
import type {StructuralNode} from "yume-dsl-rich-text";
import {printStructural} from "yume-dsl-rich-text";

const tree: StructuralNode[] = [
    {type: "text", value: "Hello "},
    {type: "inline", tag: "bold", children: [{type: "text", value: "world"}]},
];

printStructural(tree); // "Hello $$bold(world)$$"
```

**`createParser` integration:** `parser.print(nodes)` inherits `syntax` from the parser's closure:

```ts
import {createParser, createSimpleInlineHandlers} from "yume-dsl-rich-text";

const dsl = createParser({
    syntax: {tagPrefix: "@@", tagOpen: "[", tagClose: "]", endTag: "]@@"},
    handlers: createSimpleInlineHandlers(["bold"]),
});

const tree = dsl.structural("@@bold[hello]@@");
dsl.print(tree); // "@@bold[hello]@@" — syntax inherited
```

When the structural tree preserves the original syntax-relevant information and the same syntax
is used, round-trip serialization of well-formed inputs is supported.

> For searching, locating, and querying structural trees (`findFirst`, `findAll`, `nodeAtOffset`,
> `enclosingNode`), see
> [`yume-dsl-token-walker` — Structural Query](https://github.com/chiba233/yume-dsl-token-walker?tab=readme-ov-file#structural-query).

---

## Custom Syntax

Every syntax token — prefix, open/close delimiters, pipe divider, escape character, and block/raw markers — can be
overridden through `options.syntax`. This lets you adapt the DSL to any host markup without conflicts.

```ts
import {createEasySyntax, parseRichText} from "yume-dsl-rich-text";

const syntax = createEasySyntax({tagPrefix: "@@"});
// endTag, rawClose, blockClose are derived automatically: ")@@", "%end@@", "*end@@"

const tokens = parseRichText("@@bold(hello)@@", {
    syntax,
    handlers: {
        bold: {
            inline: (tokens, _ctx) => ({type: "bold", value: tokens}),
        },
    },
});
```

See the [Custom Syntax wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Custom-Syntax) for default token
reference, token dependency table, `createEasySyntax` derivation rules, and `createSyntax` low-level API.

## Custom Tag Name Characters

By default, tag names allow `a-z`, `A-Z`, `0-9`, `_`, `-` (first character must not be a digit or `-`).

See the [Custom Tag Name Characters wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Custom-Tag-Name-Characters)
for `createTagNameConfig`, `DEFAULT_TAG_NAME`, and examples for colons, digits, and other characters.

## Handler Helpers

Handler helpers let you register tags in bulk without writing repetitive handler objects.

| Helper | Use case |
|---|---|
| `createSimpleInlineHandlers` | Simple inline (bold, italic, etc.) |
| `createSimpleBlockHandlers` | Simple block (info, warning, etc.) |
| `createSimpleRawHandlers` | Simple raw (code, math, etc.) |
| `createPipeHandlers` | Pipe parameters, multiple forms, custom logic |
| `declareMultilineTags` | Declare block-level line-break normalization |

See the [Handler Helpers wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Handler-Helpers) for full API
signatures, `PipeHandlerDefinition` interface, form-specific callback details, and examples.

## ParseOptions

Both `ParseOptions` and `StructuralParseOptions` extend `ParserBaseOptions`:

```ts
interface ParserBaseOptions {
    handlers?: Record<string, TagHandler>;
    allowForms?: readonly ("inline" | "raw" | "block")[];
    depthLimit?: number;
    syntax?: Partial<SyntaxInput>;
    tagName?: Partial<TagNameConfig>;
    baseOffset?: number;
    tracker?: PositionTracker;
}

interface ParseOptions extends ParserBaseOptions {
    createId?: (token: TokenDraft) => string;
    blockTags?: readonly BlockTagInput[];
    mode?: "render";    // deprecated
    onError?: (error: ParseError) => void;
    trackPositions?: boolean;
}

interface StructuralParseOptions extends ParserBaseOptions {
    trackPositions?: boolean;
}
```

### Fields — shared (`ParserBaseOptions`)

- `handlers`: tag name → handler definition
- `allowForms`: restrict which tag forms are parsed (default: all forms enabled)
- `depthLimit`: maximum nesting depth, default `50`
- `syntax`: override default syntax tokens
- `tagName`: override tag-name character rules
- `baseOffset`: base offset for position tracking when parsing substrings (default `0`).
  See [Parsing substrings with baseOffset and tracker](#parsing-substrings-with-baseoffset-and-tracker)
- `tracker`: pre-built `PositionTracker` from the original full document for correct `line`/`column`.
  See [Parsing substrings with baseOffset and tracker](#parsing-substrings-with-baseoffset-and-tracker)

### Fields — `ParseOptions` only

- `createId`: override token id generation for this parse
- `blockTags`: tags treated as block-level for line-break normalization — accepts plain strings or `{ tag, forms }`
  objects for per-form control
- `mode`: deprecated — see [Deprecated API](#deprecated-api)
- `onError`: callback for parse errors
- `trackPositions`: attach source position info (`position`) to every `TextToken` (default `false`).
  See [Source Position Tracking](#source-position-tracking)

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
    position?: SourceSpan;

    [key: string]: unknown;
}
```

`TextToken` is the parser's output type. The `type` and `value` fields are intentionally loose (`string`) so the parser
can represent any tag without knowing your schema.

The optional `position` field is present when [`trackPositions`](#source-position-tracking) is enabled. It records the
source span (offset, line, column) of the original text that produced this token.

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
import {parseRichText, type TextToken} from "yume-dsl-rich-text";

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

## Stable Token IDs

By default, each `parseRichText` call assigns sequential IDs (`rt-0`, `rt-1`, …).
`createEasyStableId()` returns a content-based `CreateId` generator — IDs are derived from token content
instead of stream position, so edits elsewhere in the document don't shift unrelated IDs.

```ts
const tokens = parseRichText("Hello $$bold(world)$$", {
    handlers,
    createId: createEasyStableId(), // → "s-a1b2c3" (content-based)
});
```

See the [Stable Token IDs wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Stable-Token-IDs) for
stability guarantees, custom fingerprints, disambiguation, scope control, and `EasyStableIdOptions`.

## Writing Tag Handlers (advanced)

Most tags can be created with [`createPipeHandlers`](#createpipehandlersdefinitions) or the
[`createSimple*` helpers](#handler-helpers). You only need a manual `TagHandler` when you want
logic that helpers can't express — e.g., conditional field mapping, content transformation, or
dynamic type selection.

### TagHandler interface

```ts
interface TagHandler {
    inline?: (tokens: TextToken[], ctx?: DslContext) => TokenDraft;
    raw?: (arg: string | undefined, content: string, ctx?: DslContext) => TokenDraft;
    block?: (arg: string | undefined, content: TextToken[], ctx?: DslContext) => TokenDraft;
}
```

Implement only the forms your tag supports — unsupported forms degrade gracefully.
Pass `ctx` through to any utility call (`parsePipeArgs`, `materializeTextTokens`, etc.).

### Example

```ts
const dsl = createParser({
    handlers: {
        // Most tags — use helpers
        ...createSimpleInlineHandlers(["bold", "italic"]),

        // Manual handler: only when you need custom logic
        code: {
            raw: (arg, content, _ctx) => ({
                type: "code-block",
                lang: arg ?? "text",
                value: content,
            }),
        },
    },
});
```

```ts
const tokens = dsl.parse(input);
```

---

## Exports

| Category | Exports |
|---|---|
| **Core** | `parseRichText`, `stripRichText`, `createParser`, `parseStructural`, `printStructural` |
| **Configuration** | `DEFAULT_SYNTAX`, `createEasySyntax`, `createSyntax`, `DEFAULT_TAG_NAME`, `createTagNameConfig`, `createEasyStableId` |
| **Handler Helpers** | `createPipeHandlers`, `createSimpleInlineHandlers`, `createSimpleBlockHandlers`, `createSimpleRawHandlers`, `declareMultilineTags` |
| **Handler Utilities** | `parsePipeArgs`, `parsePipeTextArgs`, `parsePipeTextList`, `extractText`, `createTextToken`, `splitTokensByPipe`, `materializeTextTokens`, `unescapeInline`, `readEscapedSequence`, `createToken` |
| **Token Traversal** | `walkTokens`, `mapTokens` |
| **Position Tracking** | `buildPositionTracker` |
| **Types** | `TextToken`, `TokenDraft`, `CreateId`, `DslContext`, `TagHandler`, `TagForm`, `ParseOptions`, `ParserBaseOptions`, `StructuralParseOptions`, `Parser`, `SyntaxInput`, `SyntaxConfig`, `TagNameConfig`, `BlockTagInput`, `MultilineForm`, `ErrorCode`, `ParseError`, `StructuralNode`, `SourcePosition`, `SourceSpan`, `PositionTracker`, `PipeArgs`, `PipeHandlerDefinition`, `EasyStableIdOptions`, `PrintOptions`, `TokenVisitContext`, `WalkVisitor`, `MapVisitor` |

See the [Exports wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Exports) for full signatures and detailed documentation.

## Source Position Tracking

Pass `trackPositions: true` to attach a `position` (source span) to every output node.

```ts
const tokens = parseRichText("hello $$bold(world)$$", {
    handlers: {bold: {inline: (t, _ctx) => ({type: "bold", value: t})}},
    trackPositions: true,
});
// tokens[0].position → { start: {offset:0, line:1, column:1}, end: {offset:6, line:1, column:7} }
```

For substring parsing, pass `baseOffset` and a pre-built `tracker` from `buildPositionTracker(fullText)` to map
positions back to the original document.

See the [Source Position Tracking wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Source-Position-Tracking)
for types, substring parsing guide, `parseRichText` vs `parseStructural` differences, and performance benchmarks.

## Error Handling

Use `onError` to collect parse errors. If omitted, errors are silently discarded — the parser never throws.

```ts
const errors: ParseError[] = [];
parseRichText("$$bold(unclosed", {
    onError: (e) => errors.push(e),
});
// errors[0].code === "INLINE_NOT_CLOSED"
```

Error codes: `DEPTH_LIMIT`, `UNEXPECTED_CLOSE`, `INLINE_NOT_CLOSED`, `BLOCK_NOT_CLOSED`,
`BLOCK_CLOSE_MALFORMED`, `RAW_NOT_CLOSED`, `RAW_CLOSE_MALFORMED`.

**Graceful degradation:** unregistered tags → plain text, unsupported forms → fallback text,
`allowForms` restriction → form stripped, unclosed tags → partial text recovery.

See the [Error Handling wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Error-Handling) for
all error codes with triggers, and detailed degradation scenarios with examples.

## Deprecated API

**Core parsing API is stable.** Some utility and ambient-state APIs are transitional.
Breaking changes, if any, will land in major versions with explicit migration notes.

The following exports will be removed in a future major version. They remain functional for backward compatibility.

Ambient-state APIs (`withSyntax`, `getSyntax`, `withTagNameConfig`, `withCreateId`, `resetTokenIdSeed`) emit a
one-time `console.warn` when called by user code. Internal calls from `parseRichText` are suppressed automatically.
`parseStructural` warns only when it detects that ambient state has been changed via `withSyntax` /
`withTagNameConfig`; normal calls without ambient wrapping do not warn.

Warnings are suppressed when `NODE_ENV=production`.

These APIs will **not** be removed before September 2026.

| Export                    | Signature                                                  | Use instead                       | Warns | Reason                                                    |
|---------------------------|------------------------------------------------------------|-----------------------------------|-------|-----------------------------------------------------------|
| `withSyntax`              | `<T>(syntax: SyntaxConfig, fn: () => T) => T`              | `DslContext`                      | Yes   | Module-level implicit state; pass `DslContext` explicitly |
| `getSyntax`               | `() => SyntaxConfig`                                       | `DslContext`                      | Yes   | Same as above                                             |
| `withTagNameConfig`       | `<T>(config: TagNameConfig, fn: () => T) => T`             | Pass `tagName` via `ParseOptions` | Yes   | Same as above                                             |
| `withCreateId`            | `<T>(createId: CreateId, fn: () => T) => T`                | `DslContext`                      | Yes   | Same as above                                             |
| `resetTokenIdSeed`        | `() => void`                                               | `DslContext.createId`             | Yes   | Only needed when relying on module-level id counter       |
| `createPipeBlockHandlers` | `(names: readonly string[]) => Record<string, TagHandler>` | `createPipeHandlers`              | No    | Redundant helper; `createPipeHandlers` covers all cases   |
| `createPipeRawHandlers`   | `(names: readonly string[]) => Record<string, TagHandler>` | `createPipeHandlers`              | No    | Same as above                                             |
| `createPassthroughTags`   | `(names: readonly string[]) => Record<string, TagHandler>` | `createSimpleInlineHandlers`      | No    | Implicit behavior; explicit handlers are clearer          |
| `mode` in `ParseOptions`  | `"render"`                                                 | *(remove)*                        | No    | Only one value (`"render"`); no longer meaningful         |

---

## Changelog

Release history now lives in a standalone file:

- [CHANGELOG](./CHANGELOG.md)

---

## License

MIT
