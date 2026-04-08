**English** | [中文](./GUIDE.zh-CN.md)

# yume-dsl-rich-text(ユメテキスト)

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

[![npm](https://img.shields.io/npm/v/yume-dsl-rich-text)](https://www.npmjs.com/package/yume-dsl-rich-text)
[![GitHub](https://img.shields.io/badge/GitHub-chiba233%2FyumeDSL-181717?logo=github)](https://github.com/chiba233/yumeDSL)
[![CI](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml/badge.svg)](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Wiki](https://img.shields.io/badge/Wiki-docs-6A57D5?logo=gitbook&logoColor=white)](https://github.com/chiba233/yumeDSL/wiki/)
[![Demo](https://img.shields.io/badge/Demo-live-ff6b6b?logo=vue.js&logoColor=white)](https://demo.qwwq.org/)
[![Contributing](https://img.shields.io/badge/Contributing-guide-blue.svg)](./CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/Security-policy-red.svg)](./SECURITY.md)

Zero-dependency, **Θ(n)** rich-text DSL parser. With enough heap, public structural parse still finishes at 50 million nested layers (`1.1.4` benchmark).
Text in, token tree out — tag semantics, rendering, framework: all yours to define.

- **Not** a Markdown renderer, rich-text editor, or HTML pipeline
- **Is** a syntax-only token machine — you feed it rules, it returns
  structure; [syntax tokens are fully swappable](#custom-syntax)
- No regex backtracking, no recursion — fully iterative deterministic scan, runtime proportional to input length
- **Θ(n) where n = `text.length`** (UTF-16 code units). Since `1.1.2`, inline frames use lazy close
  with a `parenDepth` counter instead of forward-scanning `findInlineClose`, and the render layer's
  `materializeTextTokens` skips already-processed subtrees via `WeakSet` — both former O(n²) paths
  are now linear. Actual wall-clock time depends on tag density, node density, nesting depth, and
  API path (`parseRichText` ≈ structural scan + render materialization).
  [Full complexity analysis](https://github.com/chiba233/yumeDSL/wiki/en-Linear-Time-Complexity)
- Inline / Raw / Block — three tag forms, fully swappable syntax tokens and tag-name rules;
  built-in [escape sequences](#escape-sequences) let any syntax token appear as literal text
- Malformed or unknown tags [degrade to plain text](#error-handling) — never throws, never corrupts surrounding
  content
- Framework-agnostic, DOM-free — runs in browsers, Node, Deno, Bun, game engines, or any JS runtime
- Content-driven [stable IDs](#stable-token-ids), [position tracking](#source-position-tracking),
  handler-level [pipe parameters](#pipe-parameters) — use what you need
- [`parseStructural`](#parsestructural--structural-parse) gives you a lightweight map of the document; paired with [
  `yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)'s `parseSlice`, you jump to any region and
  get fully positioned `TextToken[]` without re-parsing the whole document

### **[▶ Try the live playground — type DSL, see tokens instantly](https://demo.qwwq.org/)**

**Edit tags in real time, toggle handlers on/off, watch the token tree update as you type.**

> **`1.1.7` benchmark — Kunpeng 920 aarch64 / Node v24.14.0**
>
> 200 KB dense inline full parse: `parseRichText` **~30.6 ms**, `parseStructural` **~23.3 ms**.
> Fully iterative, O(n) — no stack overflow at any nesting depth.
>
> Heap after structural parse: 200 KB **~21.60 MB**, 2 MB **~138.51 MB**.
>
> Substring parse: `parseRichText` slice + `baseOffset + tracker` **~20.62 µs**, `parseStructural` equivalent path **~13.47 µs**.
>
> Incremental parse (edit one 36-char tag in a ~200 KB document): `nodeAtOffset` **~456.76 µs** + `parseSlice` **~8.36 µs**;
> full `parseRichText` on the same document takes **~19.45 ms** — the incremental path is roughly **42x faster**.
>
> Stress test: 50 million-layer single-chain inline nesting (~500 MB), `parseStructural` **~224.1 s** (`1.1.4` data; not re-measured for `1.1.6`).
> Large-scale deep-nesting runs use an expanded heap budget; see the performance page for exact conditions.
>
> Pair with [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)'s `parseSlice` — only the touched region gets re-parsed.
> For incremental **structural** caching across edits, see [Incremental Parsing](https://github.com/chiba233/yumeDSL/wiki/en-Incremental-Parsing) (`createIncrementalSession(...)` is the default entry).
> [Full benchmark data](https://github.com/chiba233/yumeDSL/wiki/en-Performance)

**Use cases:**
[game dialogue & visual novels](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Game-Dialogue) (typewriter / shake / color tags you invent)

[chat & comments](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Safe-UGC) (safe UGC with graceful degradation)

[CMS & blogs, documentation pipelines, localization workflows](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Safe-UGC) (translators edit text, not markup)

```tsx
// React — render tokens recursively
const RichText: FC<{ tokens: TextToken[] }> = ({tokens}) => (
    <>{tokens.map(t =>
        t.type === "text" ? <span key={t.id}>{t.value as string}</span>
            : <strong key={t.id}><RichText tokens={t.value as TextToken[]}/></strong>
    )}</>
);
```

```vue
<!-- Vue 3 — same idea, template syntax -->
<template>
  <template v-for="t in tokens" :key="t.id">
    <span v-if="t.type === 'text'">{{ t.value }}</span>
    <strong v-else>
      <RichText :tokens="t.value"/>
    </strong>
  </template>
</template>
```

> Full rendering guides: [Vue 3](https://github.com/chiba233/yumeDSL/wiki/en-Vue-3-Rendering) ·
> [React](https://github.com/chiba233/yumeDSL/wiki/en-React-Rendering)

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

**Start here:**
[Install](#install) · [Quick Start](#quick-start) · [DSL Syntax](#dsl-syntax) · [API](#api)

**Go deeper:**
[Custom Syntax](#custom-syntax) · [Handler Helpers](#handler-helpers) · [ParseOptions](#parseoptions) · [Stable Token IDs](#stable-token-ids) · [Source Position Tracking](#source-position-tracking) · [Error Handling](#error-handling) · [Exports](#exports) · [Incremental Parsing](https://github.com/chiba233/yumeDSL/wiki/en-Incremental-Parsing) · [Deprecated API](#deprecated-api) · [Compatibility](#compatibility-notes)

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

- [Building a Link Tag from Scratch](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Link-Tag) — from zero to a
  working `$$link(url | text)$$`
- [Game Dialogue Tags](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Game-Dialogue) — shake / color / wait tags
  for a visual novel typewriter
- [Safe UGC Chat](https://github.com/chiba233/yumeDSL/wiki/en-Tutorial-Safe-UGC) — whitelist inline tags, block
  dangerous forms, handle errors

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

| Option           | What it does when pre-bound                                                                                                                                |
|------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **`handlers`**   | **Your tag definitions — the main reason to use `createParser`**                                                                                           |
| `syntax`         | Custom syntax tokens (if you override `$$` prefix, etc.)                                                                                                   |
| `tagName`        | Custom tag-name character rules                                                                                                                            |
| `allowForms`     | Restrict accepted tag forms (default: all forms enabled)                                                                                                   |
| `depthLimit`     | Nesting limit — rarely changes per call                                                                                                                    |
| `createId`       | Custom token id generator (can be overridden per call)                                                                                                     |
| `blockTags`      | Block-level line-break normalization — see [`declareMultilineTags`](https://github.com/chiba233/yumeDSL/wiki/en-Handler-Helpers#declaremultilinetagsnames) |
| `onError`        | Default error handler (can still be overridden per call)                                                                                                   |
| `trackPositions` | Attach source positions to all output nodes (can be overridden per call)                                                                                   |

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
    print: (nodes: StructuralNode[], overrides?: PrintOptions) => string;
}
```

**Methods:**

| Method       | Input                           | Output             | Inherits from defaults                                                        |
|--------------|---------------------------------|--------------------|-------------------------------------------------------------------------------|
| `parse`      | DSL text + overrides?           | `TextToken[]`      | All `ParseOptions` — overrides merge one level deep for `syntax`/`tagName`    |
| `strip`      | DSL text + overrides?           | `string`           | Same as `parse`                                                               |
| `structural` | DSL text + overrides?           | `StructuralNode[]` | `handlers`, `allowForms`, `syntax`, `tagName`, `depthLimit`, `trackPositions` |
| `print`      | `StructuralNode[]` + overrides? | `string`           | `syntax` only — overrides merge with defaults. Lossless serializer, no gating |

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

For **structural consumers** — highlighting, linting, editors, source inspection.
Preserves tag form (inline / raw / block) in the output tree. Shares the same language configuration as `parseRichText`.

```ts
const tree = parseStructural("$$bold(hello)$$ and $$code(ts)%\nconst x = 1;\n%end$$");
// [
//   { type: "inline", tag: "bold", children: [{ type: "text", value: "hello" }] },
//   { type: "text", value: " and " },
//   { type: "raw", tag: "code", args: [...], content: "\nconst x = 1;\n" },
// ]
```

**Which one do I use?** Rendering content → `parseRichText`. Analyzing source structure → `parseStructural`.

See
the [API Reference wiki page](https://github.com/chiba233/yumeDSL/wiki/en-API-Reference#parsestructural--structural-parse)
for
`StructuralNode` variants, `StructuralParseOptions`, differences from `parseRichText`, and `printStructural`.

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
            inline: (tokens, ctx) => ({type: "bold", value: tokens}),
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

### `createSimpleInlineHandlers` / `createSimpleBlockHandlers` / `createSimpleRawHandlers`

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
        ...createSimpleInlineHandlers(["bold", "italic", "underline", "strike", "code"]),
        ...createSimpleBlockHandlers(["info", "warning"]),
        ...createSimpleRawHandlers(["math"]),
    },
    blockTags: declareMultilineTags(["info", "warning", "math"]),
});
```

| Helper                       | Token shape                                       |
|------------------------------|---------------------------------------------------|
| `createSimpleInlineHandlers` | `{ type: tagName, value: materializedTokens }`    |
| `createSimpleBlockHandlers`  | `{ type: tagName, arg, value: content }`          |
| `createSimpleRawHandlers`    | `{ type: tagName, arg, value: content }` (string) |

### `createPipeHandlers(definitions)`

The **recommended helper** for tags that need pipe parameters, multiple forms, or any custom logic.
Each handler receives pre-parsed `PipeArgs` — no manual `parsePipeArgs` boilerplate needed.

```ts
import {createParser, createPipeHandlers, createSimpleInlineHandlers} from "yume-dsl-rich-text";

const dsl = createParser({
    handlers: {
        ...createSimpleInlineHandlers(["bold", "italic"]),

        ...createPipeHandlers({
            link: {
                inline: (args, ctx) => ({
                    type: "link",
                    url: args.text(0),
                    value: args.materializedTailTokens(1),
                }),
            },
            code: {
                raw: (args, content, ctx) => ({
                    type: "raw-code",
                    lang: args.text(0, "text"),
                    value: content,
                }),
            },
        }),
    },
});
```

| Scenario                                  | Use                          |
|-------------------------------------------|------------------------------|
| Simple inline (bold, italic, etc.)        | `createSimpleInlineHandlers` |
| Simple block (info, warning, etc.)        | `createSimpleBlockHandlers`  |
| Simple raw (code, math, etc.)             | `createSimpleRawHandlers`    |
| Pipe parameters (`$$link(url \| text)$$`) | `createPipeHandlers`         |
| Multiple forms (inline + block + raw)     | `createPipeHandlers`         |

### `declareMultilineTags(names)` — block-level line-break normalization

Tags with **block-level / container rendering semantics** — dialogue boxes, code blocks, info panels, centered
headings — need their boundary line breaks stripped. Without this, the natural way of writing multiline DSL:

```text
$$speaker(Alice)*
Hello!
*end$$
```

…produces content `"\nHello!\n"` instead of `"Hello!"`, and the rendered output shows **extra blank lines** above
and below — an extremely subtle and hard-to-debug visual bug.

`declareMultilineTags` tells the parser which tags to normalize. It does **not** register tags — use it alongside
the handler helpers above.

**Normalization per form:**

| Form            | What gets stripped                                                       | When to use                                                                                   |
|-----------------|--------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `raw` / `block` | Leading `\n` after `)*` / `)%`, trailing `\n` before `*end$$` / `%end$$` | Multiline block/raw tags                                                                      |
| `inline`        | Trailing `\n` immediately after the inline close `$$`                    | Tags that render as block-level elements despite using inline syntax (e.g. `$$center(...)$$`) |

**Usage:**

```ts
// String — all three forms normalized (raw + block + inline)
blockTags: declareMultilineTags(["info", "warning", "center"])

// Object — restrict to specific forms
blockTags: declareMultilineTags([
    "info",                              // string: all forms
    {tag: "code", forms: ["raw"]},     // only raw form
    {tag: "center", forms: ["inline"]}, // only inline form
])
```

**Auto-derivation:** the parser always auto-derives raw/block normalization from handler methods (`raw` → raw form,
`block` → block form). When you pass `blockTags`, overrides are **per-tag**: tags you list completely replace
auto-derivation for that tag; tags you don't mention keep auto-derived behavior. **Inline normalization is never
auto-derived** — the parser cannot know whether an inline tag renders as block-level. You must declare it explicitly.

**Rule of thumb:** if your tag renders as a block-level element, make sure it appears in `blockTags`. Otherwise
boundary line breaks leak into the content and produce extra blank lines at render time.

See the [Handler Helpers wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Handler-Helpers) for full API
signatures, `PipeHandlerDefinition` interface, and form-specific callback details.

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
- `baseOffset`: shift all offsets by this amount for substring parsing (default `0`).
  See [Source Position Tracking wiki](https://github.com/chiba233/yumeDSL/wiki/en-Source-Position-Tracking#parsing-substrings-baseoffset-and-tracker)
- `tracker`: pre-built `PositionTracker` from the original full document for correct `line`/`column`.
  See [Source Position Tracking wiki](https://github.com/chiba233/yumeDSL/wiki/en-Source-Position-Tracking#parsing-substrings-baseoffset-and-tracker)

### Fields — `ParseOptions` only

- `createId`: override token id generation for this parse
- `blockTags`: tags that receive line-break normalization — plain strings enable all forms (raw + block + inline);
  `{ tag, forms }` objects restrict to specific forms. See [
  `declareMultilineTags`](https://github.com/chiba233/yumeDSL/wiki/en-Handler-Helpers#declaremultilinetagsnames)
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
if (token.type === "link" && typeof token.url === "string") {
    console.log(token.url); // works, no cast needed
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

Use `NarrowToken` + `createTokenGuard` for zero-boilerplate type narrowing:

```ts
import {createTokenGuard, type NarrowDraft, type TextToken} from "yume-dsl-rich-text";

// 1. Define a token map
interface MyTokenMap {
    bold: {};
    link: { url: string };
    code: { lang: string };
}

// 2. Create a guard — one line
const is = createTokenGuard<MyTokenMap>();

// 3. Use in if branches — extra fields are auto-narrowed
if (is(token, "link")) {
    token.url;  // string ✓
    token.type; // "link" ✓
}

// 4. Handler-side: NarrowDraft catches missing fields at compile time
type LinkDraft = NarrowDraft<"link", { url: string }>;
```

See the [Strong Typing wiki section](https://github.com/chiba233/yumeDSL/wiki/en-Token-Structure#strong-typing) for
a full render example, `NarrowTokenUnion`, and the manual discriminated union alternative.

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

`ctx` in handler callbacks is a context object passed by the parser — you don't need to know what it is, just include
it. Always declare it: it costs nothing, keeps your code ready for the upcoming required-ctx major version, and avoids
ambient-state issues in concurrent environments (e.g., SSR).

### Example

```ts
const dsl = createParser({
    handlers: {
        // Most tags — use helpers
        ...createSimpleInlineHandlers(["bold", "italic"]),

        // Manual handler: only when you need custom logic
        code: {
            raw: (arg, content, ctx) => ({
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

| Category              | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Core**              | `parseRichText`, `stripRichText`, `createParser`, `parseStructural`, `printStructural`, `buildZones`, `parseIncremental`, `updateIncremental`, `tryUpdateIncremental`, `createIncrementalSession`                                                                                                                                                                                                                                                                                                                                                                       |
| **Configuration**     | `DEFAULT_SYNTAX`, `createEasySyntax`, `createSyntax`, `DEFAULT_TAG_NAME`, `createTagNameConfig`, `createEasyStableId`                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Handler Helpers**   | `createPipeHandlers`, `createSimpleInlineHandlers`, `createSimpleBlockHandlers`, `createSimpleRawHandlers`, `declareMultilineTags`                                                                                                                                                                                                                                                                                                                                                                                              |
| **Handler Utilities** | `parsePipeArgs`, `parsePipeTextArgs`, `parsePipeTextList`, `extractText`, `createTextToken`, `splitTokensByPipe`, `materializeTextTokens`, `unescapeInline`, `readEscapedSequence`, `createToken`, `createTokenGuard`                                                                                                                                                                                                                                                                                                           |
| **Token Traversal**   | `walkTokens`, `mapTokens`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Position Tracking** | `buildPositionTracker`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Types**             | `TextToken`, `TokenDraft`, `CreateId`, `DslContext`, `TagHandler`, `TagForm`, `ParseOptions`, `ParserBaseOptions`, `StructuralParseOptions`, `Parser`, `SyntaxInput`, `SyntaxConfig`, `TagNameConfig`, `BlockTagInput`, `MultilineForm`, `ErrorCode`, `ParseError`, `StructuralNode`, `SourcePosition`, `SourceSpan`, `PositionTracker`, `PipeArgs`, `PipeHandlerDefinition`, `EasyStableIdOptions`, `PrintOptions`, `TokenVisitContext`, `WalkVisitor`, `MapVisitor`, `Zone`, `IncrementalDocument`, `IncrementalEdit`, `IncrementalParseOptions`, `IncrementalUpdateErrorCode`, `IncrementalUpdateError`, `IncrementalUpdateResult`, `IncrementalSession`, `IncrementalSessionOptions`, `IncrementalSessionApplyMode`, `IncrementalSessionApplyResult`, `IncrementalSessionFallbackReason`, `IncrementalSessionStrategy`, `NarrowToken`, `NarrowDraft`, `NarrowTokenUnion` |

See the [Exports wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Exports) for full signatures and detailed
documentation.

## Source Position Tracking

Pass `trackPositions: true` to attach a `position` (source span) to every output node.

```ts
const tokens = parseRichText("hello $$bold(world)$$", {
    handlers: {bold: {inline: (t, ctx) => ({type: "bold", value: t})}},
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

The following will be removed in a future major version (not before September 2026):

`withSyntax`, `getSyntax`, `withTagNameConfig`, `withCreateId`, `resetTokenIdSeed`,
`createPipeBlockHandlers`, `createPipeRawHandlers`, `createPassthroughTags`, `ParseOptions.mode`

See the [Deprecated API wiki page](https://github.com/chiba233/yumeDSL/wiki/en-Deprecated-API) for
signatures, replacements, and migration guide.

---

## Changelog

- [CHANGELOG](./CHANGELOG.md)

### Compatibility notes

- Dual inline + block/raw tags on the same name: `1.0.7+`
- `createParser` partial-override deep merge: `1.0.11+`
- `declareMultilineTags` inline form support (`MultilineForm: "inline"`): `1.0.14+`

---

## License

MIT
