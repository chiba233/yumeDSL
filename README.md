**English** | [中文](./GUIDE.zh-CN.md)

# yume-dsl-rich-text(ユメテキスト)

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

[![npm](https://img.shields.io/npm/v/yume-dsl-rich-text)](https://www.npmjs.com/package/yume-dsl-rich-text)
[![GitHub](https://img.shields.io/badge/GitHub-chiba233%2FyumeDSL-181717?logo=github)](https://github.com/chiba233/yumeDSL)
[![CI](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml/badge.svg)](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Contributing](https://img.shields.io/badge/Contributing-guide-blue.svg)](./CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/Security-policy-red.svg)](./SECURITY.md)

Zero-dependency, single-pass rich-text DSL parser.
Text goes in, token tree comes out — what tags mean, how they render, which framework they live in is entirely up to you.

- **Not** a Markdown renderer, rich-text editor, or HTML pipeline
- **Is** a syntax-only token machine — you feed it rules, it returns structure; [syntax tokens are fully swappable](#custom-syntax)
- No regex backtracking — deterministic linear scan, runtime proportional to input length
- Inline / Raw / Block — three tag forms, fully swappable syntax tokens and tag-name rules; built-in [escape sequences](#escape-sequences) let any syntax token appear as literal text
- Malformed or unknown tags [degrade to plain text](#graceful-degradation) — never throws, never corrupts surrounding content
- Framework-agnostic, DOM-free — runs in browsers, Node, Deno, Bun, game engines, or any JS runtime
- Content-driven [stable IDs](#stable-token-ids), single-pass [position tracking](#source-position-tracking), handler-level [pipe parameters](#pipe-parameters) — use what you need
- [`parseStructural`](#parsestructural--structural-parse) gives you a lightweight map of the document; paired with [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)'s `parseSlice`, you jump to any region and get fully positioned `TextToken[]` without re-parsing the whole document

**Use cases:**
game dialogue & visual novels (typewriter / shake / color tags you invent),
chat & comments (safe UGC with graceful degradation),
CMS & blogs, documentation pipelines, localization workflows (translators edit text, not markup)

### [▶ Live Demo — DSL Fallback Museum](https://qwwq.org/blog/dsl-fallback-museum)

Shiki code highlighting · valid tags · intentionally malformed markup · error reporting

> **Version note:** if a tag supports both inline and block/raw forms, use `1.0.7+`.

## Ecosystem

| Package                                                                            | Role                                             |
|------------------------------------------------------------------------------------|--------------------------------------------------|
| **`yume-dsl-rich-text`**                                                           | Parser core — text to token tree (this package)  |
| [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)       | Interpreter — token tree to output nodes         |
| [`yume-dsl-shiki-highlight`](https://github.com/chiba233/yume-dsl-shiki-highlight) | Syntax highlighting — tokens or TextMate grammar |

**Recommended combinations:**

- **Parse DSL into tokens only** → `yume-dsl-rich-text`
- **Interpret token trees into arbitrary output nodes** → add `yume-dsl-token-walker`
- **Source-level highlighting or TextMate grammar** → add `yume-dsl-shiki-highlight`

---

## Table of Contents

- [Design Philosophy](#design-philosophy)
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
    - [parseStructural](#parsestructural--structural-parse)
- [Custom Syntax](#custom-syntax)
    - [Default Syntax](#default-syntax)
    - [createEasySyntax](#createeasysyntax-recommended)
    - [createSyntax](#createsyntax-low-level)
- [Custom Tag Name Characters](#custom-tag-name-characters)
- [Handler Helpers](#handler-helpers)
    - [createPipeHandlers](#createpipehandlersdefinitions)
    - [createSimpleInlineHandlers / createSimpleBlockHandlers / createSimpleRawHandlers](#createsimpleinlinehandlersnames--createsimpleblockhandlersnames--createsimplerawhandlersnames)
    - [declareMultilineTags](#declaremultilinetagsnames)
- [ParseOptions](#parseoptions)
- [Token Structure](#token-structure)
    - [Strong Typing](#strong-typing)
- [Stable Token IDs](#stable-token-ids)
- [Writing Tag Handlers (advanced)](#writing-tag-handlers-advanced)
- [Exports](#exports)
    - [DslContext](#dslcontext)
    - [PipeArgs / parsePipeTextList](#pipeargs--parsepipetextlist)
- [Source Position Tracking](#source-position-tracking)
- [Error Handling](#error-handling)
- [Graceful Degradation](#graceful-degradation)
- [Vue 3 Rendering](#vue-3-rendering)
- [Deprecated API](#deprecated-api)
- [Changelog](#Changelog)
- [License](#license)

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

// Per-call overrides are shallow-merged onto defaults
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
```

```ts
interface Parser {
    parse: (text: string, overrides?: ParseOptions) => TextToken[];
    strip: (text: string, overrides?: ParseOptions) => string;
    structural: (text: string, overrides?: StructuralParseOptions) => StructuralNode[];
}
```

`structural` shares `handlers`, `allowForms`, `syntax`, `tagName`, `depthLimit`, and `trackPositions`
from `defaults` — semantic-only options (`blockTags`, `onError`, `createId`) are
naturally excluded because `StructuralParseOptions` does not extend them.

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

**Ambient capture:** when called without `syntax` / `tagName` overrides, `parseStructural` captures the
current `getSyntax()` / `getTagNameConfig()` values once at entry and threads them explicitly through the
parse. This makes it composable inside `withSyntax` / `withTagNameConfig` wrappers:

```ts
withSyntax(customSyntax, () => {
    parseStructural(text);  // captures customSyntax at entry
    parseStructural(text2); // also captures customSyntax at entry
});
```

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

### Default Syntax

The default tokens and where they appear:

```text
Inline:   $$tag(content)$$
               ↑       ↑
          tagOpen(  endTag)$$

Nested:   $$tag(fn(x) text)$$
                  ↑ ↑
          tagOpen(  tagClose)   ← depth tracking keeps inner parens balanced

With arg: $$tag(arg | content)$$
                    ↑
               tagDivider |

Raw:      $$tag(arg)%
                   ↑  raw content (no parsing)
              rawOpen)%
          %end$$
          ↑
          rawClose

Block:    $$tag(arg)*
                   ↑  block content (recursive parsing)
             blockOpen)*
          *end$$
          ↑
          blockClose

Escape:   \)  \\  \|
          ↑
          escapeChar \
```

```ts
import {DEFAULT_SYNTAX} from "yume-dsl-rich-text";
// DEFAULT_SYNTAX.tagPrefix   === "$$"        // tag start marker
// DEFAULT_SYNTAX.tagOpen     === "("         // opens the tag argument/content
// DEFAULT_SYNTAX.tagClose    === ")"         // paired with tagOpen for nested-paren depth matching in args
// DEFAULT_SYNTAX.tagDivider  === "|"         // separates params inside (…)
// DEFAULT_SYNTAX.endTag      === ")$$"       // closes an inline tag
// DEFAULT_SYNTAX.rawOpen     === ")%"        // switches from args to raw content
// DEFAULT_SYNTAX.blockOpen   === ")*"        // switches from args to block content
// DEFAULT_SYNTAX.rawClose    === "%end$$"    // closes a raw tag (must be on its own line)
// DEFAULT_SYNTAX.blockClose  === "*end$$"    // closes a block tag (must be on its own line)
// DEFAULT_SYNTAX.escapeChar  === "\\"        // escapes the next syntax token literally
```

> Warning:
> Syntax tokens must remain distinguishable from one another.
> If two tokens are configured to the same string, behavior is undefined.

**Token dependency** — `createSyntax` does a plain shallow merge; no auto-derivation.
The parser has hard couplings between certain tokens — break them and tags stop working:

| Token        | Constraint                                              | Why                                                                                                                           |
|--------------|---------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `tagClose`   | **`endTag`, `rawOpen`, `blockOpen` must start with it** | `getTagCloserType` matches these three from the position where `findTagArgClose` stopped — that position points to `tagClose` |
| `tagOpen`    | Must pair with `tagClose`                               | `findTagArgClose` counts `tagOpen`/`tagClose` for nested depth matching                                                       |
| `endTag`     | Must start with `tagClose`                              | See `tagClose` above                                                                                                          |
| `rawOpen`    | Must start with `tagClose`                              | See `tagClose` above                                                                                                          |
| `blockOpen`  | Must start with `tagClose`                              | See `tagClose` above                                                                                                          |
| `tagPrefix`  | —                                                       | Independent                                                                                                                   |
| `rawClose`   | —                                                       | Independent (whole-line match)                                                                                                |
| `blockClose` | —                                                       | Independent (whole-line match)                                                                                                |
| `tagDivider` | —                                                       | Independent                                                                                                                   |
| `escapeChar` | —                                                       | Independent                                                                                                                   |

### createEasySyntax (recommended)

```ts
function createEasySyntax(overrides?: Partial<SyntaxInput>): SyntaxConfig
```

Change the base tokens, compound tokens stay in sync automatically.
Accepts any subset of `SyntaxInput` — base tokens drive derivation, explicit compound overrides take precedence.

| Base tokens (you set)                                          | Compound tokens (auto-derived)                             |
|----------------------------------------------------------------|------------------------------------------------------------|
| `tagPrefix`, `tagOpen`, `tagClose`, `tagDivider`, `escapeChar` | `endTag`, `rawOpen`, `blockOpen`, `rawClose`, `blockClose` |

Derivation rules:

```text
endTag     = tagClose + tagPrefix       ")" + "$$"     → ")$$"
rawOpen    = tagClose + "%"             ")" + "%"      → ")%"
blockOpen  = tagClose + "*"             ")" + "*"      → ")*"
rawClose   = "%" + "end" + tagPrefix    "%end" + "$$"  → "%end$$"
blockClose = "*" + "end" + tagPrefix    "*end" + "$$"  → "*end$$"
```

```ts
import {createEasySyntax} from "yume-dsl-rich-text";

// Change prefix — compounds follow
createEasySyntax({tagPrefix: "@@"});
// endTag → ")@@"   rawClose → "%end@@"   blockClose → "*end@@"

// Change prefix + closer — compounds adapt to both
createEasySyntax({tagPrefix: "@@", tagClose: "]"});
// endTag → "]@@"   rawOpen → "]%"   blockOpen → "]*"
```

When your opening/closing protocol is irregular (e.g. `rawOpen: "<raw>"` or raw/block use different close keywords),
derivation can't help — use [`createSyntax`](#createsyntax-low-level) instead.

### createSyntax (low-level)

`createSyntax` is not an advanced version of `createEasySyntax` — it is a raw builder with no validation or derivation.
Use it only when you need full manual control over every token.

```ts
import {createSyntax} from "yume-dsl-rich-text";

const syntax = createSyntax({tagPrefix: "@@", endTag: ")@@"});
// You must update endTag, rawClose, blockClose yourself — no auto-derivation
```

```ts
interface SyntaxConfig extends SyntaxInput {
    escapableTokens: string[];  // precomputed, sorted by length (descending)
}
```

> Note:
> Internally, parser state is passed explicitly through the parse pipeline. `parseRichText` preserves module-local
> ambient wrapping (`withSyntax` / `withCreateId`) for backward compatibility in handler utility calls.
> This is safe for normal synchronous calls, but if you share one module instance across concurrent async request flows,
> isolate parser work carefully — or pass `DslContext` explicitly to eliminate ambient dependency.

---

## Custom Tag Name Characters

```ts
function createTagNameConfig(overrides?: Partial<TagNameConfig>): TagNameConfig
```

Controls which characters the parser accepts in tag names. Provide only the functions you want to change — the rest
falls back to `DEFAULT_TAG_NAME`.

| Function         | Default                       | Role                 | Example match         |
|------------------|-------------------------------|----------------------|-----------------------|
| `isTagStartChar` | `a-z`, `A-Z`, `_`             | First character      | `$$bold(` — `b`       |
| `isTagChar`      | `a-z`, `A-Z`, `0-9`, `_`, `-` | Remaining characters | `$$my-tag(` — `y-tag` |

By default, `$$ui:button(...)$$` would fail because `:` is not in `isTagChar`. To allow it:

```ts
import {createParser, createTagNameConfig} from "yume-dsl-rich-text";

const dsl = createParser({
    handlers: {
        "ui:button": {inline: (value, _ctx) => ({type: "ui:button", value})},
    },
    // Only override isTagChar — isTagStartChar keeps the default.
    // Keep the normal tag characters, and additionally allow ":" after the first character.
    tagName: createTagNameConfig({
        isTagChar: (char) => /[A-Za-z0-9_-]/.test(char) || char === ":",
    }),
});

dsl.parse("$$ui:button(hello)$$");  // works
```

You can also pass a plain partial object directly to `tagName` — `createTagNameConfig` is optional:

```ts
parseRichText("$$1tag(hello)$$", {
    handlers: {"1tag": {inline: (v, _ctx) => ({type: "1tag", value: v})}},
    tagName: {
        isTagStartChar: (char) => /[A-Za-z0-9_]/.test(char),  // allow digit start
        isTagChar: (char) => /[A-Za-z0-9_-]/.test(char) || char === ":",  // keep normal chars, also allow ":"
    },
});
```

---

## Handler Helpers

Handler helpers let you register tags in bulk without writing repetitive handler objects.

### `createPipeHandlers(definitions)`

The **recommended handler helper** for tags that need pipe parameters, multiple forms, or any custom logic beyond simple
wrapping. Supports any combination of `inline`, `raw`, and `block` per tag in a single definition object.

Each handler receives pre-parsed `PipeArgs` — no manual `parsePipeArgs` / `parsePipeTextArgs` boilerplate needed.
`raw` and `block` handlers also receive the original `rawArg` string for cases where you need the unparsed value.

```ts
import {createParser, createPipeHandlers, createSimpleInlineHandlers} from "yume-dsl-rich-text";

const dsl = createParser({
    handlers: {
        // Simple tags — use createSimpleInlineHandlers
        ...createSimpleInlineHandlers(["bold", "italic", "underline"]),

        // Tags with pipe parameters or multiple forms — use createPipeHandlers
        ...createPipeHandlers({
            link: {
                inline: (args) => ({
                    type: "link",
                    url: args.text(0),
                    value: args.materializedTailTokens(1),
                }),
            },
            info: {
                inline: (args) => ({
                    type: "info",
                    title: args.text(0, "Info"),
                    value: args.materializedTailTokens(1),
                }),
                block: (args, content, _ctx, rawArg) => ({
                    type: "info",
                    title: rawArg || "Info",
                    value: content,
                }),
            },
            code: {
                raw: (args, content) => ({
                    type: "raw-code",
                    lang: args.text(0, "text"),
                    title: args.text(1, "Code:"),
                    value: content,
                }),
            },
        }),
    },
});
```

**When to use which helper:**

| Scenario                                  | Use                          |
|-------------------------------------------|------------------------------|
| Simple inline (bold, italic, etc.)        | `createSimpleInlineHandlers` |
| Simple block (info, warning, etc.)        | `createSimpleBlockHandlers`  |
| Simple raw (code, math, etc.)             | `createSimpleRawHandlers`    |
| Pipe parameters (`$$link(url \| text)$$`) | `createPipeHandlers`         |
| Multiple forms (inline + block + raw)     | `createPipeHandlers`         |
| Raw/block tags with structured args       | `createPipeHandlers`         |

### `createSimpleInlineHandlers(names)` / `createSimpleBlockHandlers(names)` / `createSimpleRawHandlers(names)`

Bulk-register tags that don't need pipe parameters or custom logic. Each form produces a minimal token:

| Helper                       | Token shape                                       |
|------------------------------|---------------------------------------------------|
| `createSimpleInlineHandlers` | `{ type: tagName, value: materializedTokens }`    |
| `createSimpleBlockHandlers`  | `{ type: tagName, arg, value: content }`          |
| `createSimpleRawHandlers`    | `{ type: tagName, arg, value: content }` (string) |

```ts
import {
    createParser,
    createSimpleInlineHandlers,
    createSimpleBlockHandlers,
    createSimpleRawHandlers,
} from "yume-dsl-rich-text";

const dsl = createParser({
    handlers: {
        ...createSimpleInlineHandlers(["bold", "italic", "underline", "strike", "code"]),
        ...createSimpleBlockHandlers(["info", "warning"]),
        ...createSimpleRawHandlers(["math"]),
    },
});
```

```ts
function createSimpleInlineHandlers(names: readonly string[]): Record<string, TagHandler>;

function createSimpleBlockHandlers(names: readonly string[]): Record<string, TagHandler>;

function createSimpleRawHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `createPipeBlockHandlers(names)` / `createPipeRawHandlers(names)`

> **Deprecated.** See [Deprecated API](#deprecated-api).

### `declareMultilineTags(names)`

Declares which already-registered tags are multiline types. Returns a `BlockTagInput[]` to pass as
`ParseOptions.blockTags`.

This does **not** register tags or create handlers — it only tells the parser which tags need line-break normalization (
stripping the leading `\n` after `)*` / `)%` openers and the trailing `\n` before `*end$$` / `%end$$` closers).

Each entry is either a plain tag name (normalization for **both** raw and block forms — backward compatible) or an
object with a `forms` array to restrict normalization to specific multiline forms.

```ts
import {createParser, createSimpleInlineHandlers, declareMultilineTags} from "yume-dsl-rich-text";

// Basic usage — all multiline forms normalized (backward compatible)
const dsl = createParser({
    handlers: {
        ...createSimpleInlineHandlers(["bold", "italic"]),
        info: { /* custom handler registered separately */},
        warning: { /* custom handler registered separately */},
    },
    blockTags: declareMultilineTags(["info", "warning"]),
});

// Granular — restrict normalization to specific forms
const dsl2 = createParser({
    handlers: { /* ... */},
    blockTags: declareMultilineTags([
        "info",                              // both raw & block normalized
        {tag: "code", forms: ["raw"]},     // only raw form normalized
        {tag: "note", forms: ["block"]},   // only block form normalized
    ]),
});
```

> **Note:** If you omit `blockTags`, the parser auto-derives it from handlers that have `raw` or `block` methods.
> Use `declareMultilineTags` when you need explicit control over which tags receive line-break normalization.

```ts
type MultilineForm = "raw" | "block";
type BlockTagInput = string | { tag: string; forms?: readonly MultilineForm[] };

function declareMultilineTags(names: readonly BlockTagInput[]): BlockTagInput[];
```

### `createPassthroughTags(names)`

> **Deprecated.** See [Deprecated API](#deprecated-api).

---

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
These reset per call, so the same input always gets the same IDs — but inserting or removing
content earlier in the document shifts every ID after it.

`createEasyStableId()` returns a **parse-session scoped, stateful** `CreateId` generator.
Each call creates a fresh closure with its own disambiguation counter — IDs are derived from
token content instead of stream position.

### Stability guarantees

- Edits that produce a **different fingerprint**: stable — no effect on other IDs.
- **Duplicate fingerprints** are disambiguated by occurrence order (`s-abc`, `s-abc-1`, …).
  Inserting a new duplicate *before* an existing one will shift the suffix of later duplicates.
- The hash is FNV-1a 32-bit. Different fingerprints can theoretically collide to the same
  base key — the counter still produces unique IDs, but unrelated tokens may share a prefix.
  Fine for UI keying; don't use as database primary keys.

### Basic usage

```ts
import { parseRichText, createEasyStableId } from "yume-dsl-rich-text";

const tokens = parseRichText("Hello $$bold(world)$$", {
  handlers,
  createId: createEasyStableId(), // → "s-a1b2c3" (content-based)
});
```

### Custom fingerprint

The default fingerprint uses `type` + `value`. Pass a `fingerprint` function to control
exactly what participates in the hash.

`TokenDraft` has an index signature (`[key: string]: unknown`), so handler-attached fields
are accessible but typed as `unknown` — narrow before use:

```ts
// Include a handler-attached field (narrow from unknown)
createEasyStableId({
  fingerprint: (t) => {
    const lang = typeof t.lang === "string" ? t.lang : "";
    return `${t.type}:${lang}:${typeof t.value === "string" ? t.value : ""}`;
  },
})
```

### Options

```ts
interface EasyStableIdOptions {
  /** Prefix for generated IDs. Default: "s". */
  prefix?: string;
  /** Custom fingerprint — controls what goes into the hash. */
  fingerprint?: (token: TokenDraft) => string;
}
```

### Disambiguation

Tokens with identical fingerprints get a numeric suffix:

```ts
const stableId = createEasyStableId();
const tokens = parseRichText("$$bold(hi)$$ and $$bold(hi)$$", {
  handlers,
  createId: stableId,
});
// tokens[0].id → "s-x1y2z3"
// tokens[2].id → "s-x1y2z3-1"   ← same content, auto-suffixed
```

### Scope

The generator is stateful — its disambiguation counter lives in the closure.
How you wire it determines the scope of uniqueness:

```ts
// ① Per-parse scope (recommended) — each parse gets independent IDs
const dsl = createParser({ handlers });
dsl.parse(text, { createId: createEasyStableId() });

// ② Shared scope — counter carries across parses
const stableId = createEasyStableId({ prefix: "doc" });
const dsl2 = createParser({ handlers, createId: stableId });
dsl2.parse(text1); // counter starts at 0
dsl2.parse(text2); // counter continues
```

---

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

### Core

| Export            | Signature                                                              | Description                                      |
|-------------------|------------------------------------------------------------------------|--------------------------------------------------|
| `parseRichText`   | `(text: string, options?: ParseOptions) => TextToken[]`                | Parse DSL text into a token tree                 |
| `stripRichText`   | `(text: string, options?: ParseOptions) => string`                     | Parse and flatten to plain text                  |
| `createParser`    | `(defaults: ParseOptions) => Parser`                                   | Create a reusable parser with pre-filled options |
| `parseStructural` | `(text: string, options?: StructuralParseOptions) => StructuralNode[]` | Parse into a form-preserving structural tree     |

### Configuration

See [Custom Syntax](#custom-syntax) and [Custom Tag Name Characters](#custom-tag-name-characters) for full
documentation.

| Export                | Signature                                               | Description                                             |
|-----------------------|---------------------------------------------------------|---------------------------------------------------------|
| `DEFAULT_SYNTAX`      | `SyntaxInput`                                           | The built-in syntax tokens (`$$`, `(`, `)$$`, etc.)     |
| `createEasySyntax`    | `(overrides?: Partial<SyntaxInput>) => SyntaxConfig`    | Build `SyntaxConfig` with auto-derivation (recommended) |
| `createSyntax`        | `(overrides?: Partial<SyntaxInput>) => SyntaxConfig`    | Build `SyntaxConfig` with plain merge (low-level)       |
| `DEFAULT_TAG_NAME`    | `TagNameConfig`                                         | The built-in tag-name character rules                   |
| `createTagNameConfig` | `(overrides?: Partial<TagNameConfig>) => TagNameConfig` | Build a full `TagNameConfig` from partial overrides     |
| `createEasyStableId`  | `(options?: EasyStableIdOptions) => CreateId`           | Content-based [stable IDs](#stable-token-ids) with optional custom fingerprint |

### Handler Helpers

Convenience functions for creating handlers in bulk — most projects only need these.

| Export                       | Signature                                                                            | Description                                                        |
|------------------------------|--------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| `createPipeHandlers`         | `(definitions: Record<string, PipeHandlerDefinition>) => Record<string, TagHandler>` | Pipe-aware handler builder for any combination of inline/raw/block |
| `createSimpleInlineHandlers` | `(names: readonly string[]) => Record<string, TagHandler>`                           | Create inline handlers for simple tags in bulk                     |
| `createSimpleBlockHandlers`  | `(names: readonly string[]) => Record<string, TagHandler>`                           | Create block-form handlers for simple tags in bulk                 |
| `createSimpleRawHandlers`    | `(names: readonly string[]) => Record<string, TagHandler>`                           | Create raw handlers for simple tags in bulk                        |
| `declareMultilineTags`       | `(names: readonly BlockTagInput[]) => BlockTagInput[]`                               | Declare which tags need multiline normalization                    |

See also [Deprecated API](#deprecated-api) for `createPipeBlockHandlers`, `createPipeRawHandlers`,
`createPassthroughTags`.

### Handler Utilities

Lower-level tools for writing custom `TagHandler` implementations.
You will not need these if you only use the handler helpers above.

The `ctx?` parameter exists for backward compatibility. New code should treat it as required in practice —
pass the `DslContext` received from the handler callback or construct one explicitly.
See [DslContext](#dslcontext) below.

| Export                  | Signature                                                                                 | Description                                                |
|-------------------------|-------------------------------------------------------------------------------------------|------------------------------------------------------------|
| `parsePipeArgs`         | `(tokens: TextToken[], ctx?: DslContext) => PipeArgs`                                     | Split tokens by pipe and access parsed parts               |
| `parsePipeTextArgs`     | `(text: string, ctx?: DslContext) => PipeArgs`                                            | Same as above, but from a plain text string                |
| `parsePipeTextList`     | `(text: string, ctx?: DslContext) => string[]`                                            | Split a pipe-delimited string into trimmed `string[]`      |
| `splitTokensByPipe`     | `(tokens: TextToken[], ctx?: DslContext) => TextToken[][]`                                | Raw token splitter without helper methods                  |
| `extractText`           | `(tokens?: TextToken[]) => string`                                                        | Flatten a token tree into a single string                  |
| `materializeTextTokens` | `(tokens: TextToken[], ctx?: DslContext) => TextToken[]`                                  | Recursively unescape text tokens in a tree                 |
| `unescapeInline`        | `(str: string, ctx?: DslContext \| SyntaxConfig) => string`                               | Unescape DSL escape sequences in a single string \*        |
| `readEscapedSequence`   | `(text: string, i: number, ctx?: DslContext \| SyntaxConfig) => [string \| null, number]` | Read one escape sequence at position `i` \*                |
| `createTextToken`       | `(value: string, ctx?: DslContext) => TextToken`                                          | Create a `{ type: "text", value }` token with `id`         |
| `createToken`           | `(draft: TokenDraft, position?: SourceSpan, ctx?: DslContext \| CreateId) => TextToken`   | Add an `id` (and optional `position`) to a `TokenDraft` \* |

> \* `unescapeInline` and `readEscapedSequence` also accept a bare `SyntaxConfig` for convenience;
> `createToken` also accepts a bare `CreateId`. These narrower overloads exist for internal and
> legacy use. **New code should pass `DslContext`** — the wider types will be narrowed to
> `DslContext`-only in a future major version.

**Demo** — manual handler using every utility from this table:

```ts
import {
  createParser,
  parsePipeArgs,          // split inline tokens by pipe → PipeArgs
  parsePipeTextArgs,      // split plain string by pipe → PipeArgs
  parsePipeTextList,      // plain string → trimmed string[]
  splitTokensByPipe,      // raw token splitter (no helper methods)
  extractText,            // flatten token tree → single string
  materializeTextTokens,  // recursively unescape text leaves
  unescapeInline,         // unescape a single string
  readEscapedSequence,    // read one escape at position i
  createTextToken,        // shortcut: { type: "text", value } + id
  createToken,            // attach id (+ optional position) to any TokenDraft
} from "yume-dsl-rich-text";

const handlers = {
  // A single handler that demonstrates every utility
  demo: {
    // ── inline: $$demo(title | body with $$bold(nested)$$)$$ ──
    inline: (tokens, ctx) => {
      const args = parsePipeArgs(tokens, ctx);         // ← split by pipe, get PipeArgs
      const title = args.text(0, "Untitled");          //    .text() → unescape + trim
      const bodyTokens = args.materializedTailTokens(1); // .materializedTailTokens() → materializeTextTokens

      const plain = extractText(bodyTokens);           // ← flatten to string (no unescape)

      return { type: "demo", title, plain, value: bodyTokens };
    },

    // ── raw: $$demo(lang | label)% raw content %end$$ ──
    raw: (arg, content, ctx) => {
      const args = parsePipeTextArgs(arg ?? "", ctx);  // ← split arg string by pipe
      const labels = parsePipeTextList(arg ?? "", ctx);// ← even simpler: string[]

      const unescaped = unescapeInline(content, ctx);  // ← manually unescape raw content

      return {
        type: "demo",
        lang: args.text(0, "text"),
        labels,
        value: unescaped,
      };
    },

    // ── block: $$demo(heading)* children *end$$ ──
    block: (arg, content, ctx) => {
      const parts = splitTokensByPipe(content, ctx);   // ← raw split, no helper methods
      const materialized = materializeTextTokens(content, ctx); // ← unescape all leaves

      // readEscapedSequence — check if a position is an escape
      const sample = arg ?? "";
      const [escaped, next] = readEscapedSequence(sample, 0, ctx); // → [char | null, nextIndex]

      // createTextToken / createToken — build tokens manually
      const extra = createTextToken("(appended)", ctx);            // { type:"text", value, id }
      const custom = createToken(                                  // any TokenDraft → TextToken
        { type: "demo-meta", value: escaped ?? sample },
        undefined, ctx,
      );

      return {
        type: "demo",
        sectionCount: parts.length,
        value: [...materialized, extra, custom],
      };
    },
  },
};
```

### Position Tracking

Single-pass position tracking with zero extra cost when disabled.
Pass `trackPositions: true` to attach `position` (source span with `offset` / `line` / `column`) to every output node.
For substring parsing, `baseOffset` + `tracker` map positions back to the original document.
See [Source Position Tracking](#source-position-tracking) for full documentation, types, and examples.

| Export                 | Signature                           | Description                                                             |
|------------------------|-------------------------------------|-------------------------------------------------------------------------|
| `buildPositionTracker` | `(text: string) => PositionTracker` | Build a reusable line-offset table for resolving offsets to line/column |

Related `ParseOptions` / `StructuralParseOptions` fields:

| Option           | Type              | Description                                                        |
|------------------|-------------------|--------------------------------------------------------------------|
| `trackPositions` | `boolean`         | Enable position tracking (default `false`)                         |
| `baseOffset`     | `number`          | Shift all offsets by this amount for substring parsing             |
| `tracker`        | `PositionTracker` | Pre-built tracker from full document for correct `line` / `column` |

> **Note:** The full list of exports includes deprecated APIs not shown above.
> See [Deprecated API](#deprecated-api) for `withSyntax`, `getSyntax`, `withTagNameConfig`,
> `resetTokenIdSeed`, `createPipeBlockHandlers`, `createPipeRawHandlers`, and `createPassthroughTags`.

### DslContext

`DslContext` carries the active syntax and token-id generator for a parse session.
All public utilities accept it as an optional `ctx` parameter — **pass it through** to keep
everything on the same configuration. `ctx` will become required in a future major version.

```ts
interface DslContext {
    syntax: SyntaxConfig;
    createId?: CreateId;
}
```

| Field      | Description                                                              |
|------------|--------------------------------------------------------------------------|
| `syntax`   | The active `SyntaxConfig` — controls escape characters, delimiters, etc. |
| `createId` | Optional token id generator — used by `createToken` when building tokens |

```ts
// Inside a handler: pass through the ctx the parser gives you
link: {
    inline: (tokens, ctx) => {
        const args = parsePipeArgs(tokens, ctx);
        return {type: "link", url: args.text(0), value: args.materializedTailTokens(1)};
    },
}

// Outside parsing: construct one yourself
const ctx: DslContext = {syntax: createSyntax(), createId: (draft) => `demo-${draft.type}`};
const args = parsePipeTextArgs("ts | Demo", ctx);
const token = createTextToken("hello", ctx);
```

### Migration to explicit `ctx`

Affects the handler → utility call chain, not the core parse API:

`TagHandler` · `parsePipeArgs` · `parsePipeTextArgs` · `parsePipeTextList` · `splitTokensByPipe` ·
`materializeTextTokens` · `unescapeInline` · `readEscapedSequence` · `createToken`

1. Add `ctx` to your `TagHandler` signatures.
2. Pass it through to every utility call inside handlers.
3. In standalone scripts/tests, construct `DslContext` explicitly.

### PipeArgs / parsePipeTextList

`parsePipeArgs` and `parsePipeTextArgs` return a `PipeArgs` object:

```ts
interface PipeArgs {
    parts: TextToken[][];
    has: (index: number) => boolean;
    text: (index: number, fallback?: string) => string;
    materializedTokens: (index: number, fallback?: TextToken[]) => TextToken[];
    materializedTailTokens: (startIndex: number, fallback?: TextToken[]) => TextToken[];
}
```

| Field                                  | Description                                                  |
|----------------------------------------|--------------------------------------------------------------|
| `parts`                                | Raw token arrays split by `\|`                               |
| `has(i)`                               | Whether part `i` exists                                      |
| `text(i, fallback?)`                   | Plain text of part `i`, unescaped and trimmed                |
| `materializedTokens(i, fallback?)`     | Unescaped tokens of part `i`                                 |
| `materializedTailTokens(i, fallback?)` | All parts from index `i` onward, merged into one token array |

If you only need `string[]` without token trees, use `parsePipeTextList` instead:

```ts
parsePipeTextList("ts | Demo | Label");  // → ["ts", "Demo", "Label"]
```

---

## Source Position Tracking

Pass `trackPositions: true` to attach a `position` (source span) to every output node. Disabled by default — when off,
no line table is built and no `position` fields appear.

```ts
import {parseRichText, type SourceSpan} from "yume-dsl-rich-text";

const tokens = parseRichText("hello $$bold(world)$$", {
    handlers: {bold: {inline: (t, _ctx) => ({type: "bold", value: t})}},
    trackPositions: true,
});

// tokens[0].position
// {
//   start: { offset: 0,  line: 1, column: 1  },
//   end:   { offset: 6,  line: 1, column: 7  }
// }

// tokens[1].position
// {
//   start: { offset: 6,  line: 1, column: 7  },
//   end:   { offset: 21, line: 1, column: 22 }
// }
```

`parseStructural` supports the same option:

```ts
import {parseStructural} from "yume-dsl-rich-text";

const nodes = parseStructural("$$bold(hi)$$", {trackPositions: true});
// nodes[0].position → { start: { offset: 0, ... }, end: { offset: 12, ... } }
```

### Types

```ts
interface SourcePosition {
    offset: number;   // 0-indexed string offset (UTF-16 code unit)
    line: number;      // 1-indexed
    column: number;    // 1-indexed
}

interface SourceSpan {
    start: SourcePosition;
    end: SourcePosition;
}
```

### Parsing substrings with `baseOffset` and `tracker`

> **TL;DR** — `baseOffset` maps substring positions back to absolute offsets in the original text;
> `tracker` resolves those absolute offsets into correct `line`/`column`. Pass both for full accuracy.

When you parse a substring extracted from a larger document, pass `baseOffset` and a pre-built `tracker`
so that **all** position fields (`offset`, `line`, `column`) point back into the original source:

```ts
import {parseRichText, buildPositionTracker} from "yume-dsl-rich-text";

const fullText = "first line\nprefix $$bold(world)$$ suffix";
const tracker = buildPositionTracker(fullText);

const start = 18;  // "$$bold(world)$$" starts at offset 18
const slice = fullText.slice(start, 33);

const tokens = parseRichText(slice, {
    handlers: {bold: {inline: (t) => ({type: "bold", value: t})}},
    trackPositions: true,
    baseOffset: start,
    tracker,           // ← built from the full document
});

// tokens[0].position.start.offset → 18  (absolute, in fullText)
// tokens[0].position.start.line   → 2   (correct line in fullText)
// tokens[0].position.start.column → 8   (correct column in fullText)
```

| Option       | Purpose                                                                        |
|--------------|--------------------------------------------------------------------------------|
| `baseOffset` | Shift all offsets by this amount (default `0`)                                 |
| `tracker`    | Pre-built tracker from the full document — enables correct `line`/`column` too |

Both options apply to `parseRichText` and `parseStructural`. They require `trackPositions: true`;
when position tracking is off, both are ignored.

**Without `tracker`** (only `baseOffset`): `offset` is shifted correctly, but `line`/`column` are
resolved locally against the substring. This is sufficient when you only need offset-based lookups.

**With `tracker`** (recommended): all three fields are fully correct against the original document.
Build the tracker **once** with `buildPositionTracker(fullText)` and reuse it across all subsequent slice parses.
Do not call `buildPositionTracker` per slice — it rebuilds the line table from scratch each time.

### What `position` covers

Each token's `position` spans the source range for that parser's own output model.

- In `parseRichText`, block/raw token spans include any trailing line break consumed by line-break normalization.
- In `parseStructural`, spans follow the raw structural syntax and therefore stop at `*end$$` / `%end$$`.

For example, given this input (27 characters):

```
$$info()*\nhello\n*end$$\nnext
0         1         2
012345678901234567890123456
```

| API               | `info` token `position.end.offset` | Covers                       |
|-------------------|------------------------------------|------------------------------|
| `parseRichText`   | **23** (past the `\n` after `$$`)  | `$$info()*\nhello\n*end$$\n` |
| `parseStructural` | **22** (stops at `$$`)             | `$$info()*\nhello\n*end$$`   |

`parseRichText` consumes the trailing `\n` as part of block line-break normalization;
`parseStructural` stops at the raw syntax boundary. The `\n` at offset 22 becomes the start of the next text node.

### Semantic differences between `parseRichText` and `parseStructural`

| Aspect                | `parseRichText`                                                                                                                  | `parseStructural`                                                                           |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Block children offset | Adjusted for leading line-break normalization — inner `position` maps back to the original source through the normalized content | Raw syntax positions — no normalization adjustment, children start at the content delimiter |

Both APIs use the same `SourceSpan` type, but the inner child positions reflect their respective processing models.
If you compare child positions across the two APIs on the same input, block content may show an offset difference
equal to the stripped leading line break (1 for `\n`, 2 for `\r\n`).

### Performance

When `trackPositions` is `false` (default):

- No line-offset table is allocated
- No `position` objects are produced
- Remaining overhead is limited to a few null-check branches in the parse pipeline — negligible in practice

When enabled, a line-offset table is built once (O(n) scan), and each position resolution uses O(log n) binary search.

Performance should be understood in tiers: `parseStructural` is a lightweight syntax/structure scanner suited for
high-throughput scenarios; `parseRichText` is a semantic parser that, beyond the state-machine scan, includes handler
execution, token-tree construction, and content normalization — the cost difference reflects capability overhead,
not a scanner implementation deficiency.

**Baseline throughput** (~48 KB DSL input, single-threaded microbenchmark):

| API               | Time / call |
|-------------------|-------------|
| `parseRichText`   | ~360 ms     |
| `stripRichText`   | ~358 ms     |
| `parseStructural` | ~7.1 ms     |

`stripRichText` internally calls `parseRichText` then `extractText`, so its cost is essentially the same.
`parseStructural` skips handlers, token construction, and materialization — roughly **50x faster** than `parseRichText`
on the same input.

**`trackPositions` overhead** (same input):

| API               | Without | With   | Overhead |
|-------------------|---------|--------|----------|
| `parseRichText`   | 360 ms  | 359 ms | ~0%      |
| `stripRichText`   | 358 ms  | 360 ms | ~0%      |
| `parseStructural` | 7.1 ms  | 7.6 ms | ~7%      |

`parseRichText` / `stripRichText` have heavier per-token work (handlers, recursion, materialization), so position
tracking is a rounding error. `parseStructural` is inherently lighter, making the relative cost of producing `position`
objects and resolving offsets more visible — but still not catastrophic.

*Measured on Kunpeng 920 24C / 32 GB (2x16 GB DDR4-2666). Local microbenchmark — magnitude is reliable; exact figures
will vary by platform.*

---

## Error Handling

Use `onError` to collect parse errors.

```ts
import type {ParseError} from "yume-dsl-rich-text";

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
    {type: "text", value: "Hello ", id: "rt-0"},
    {type: "bold", value: [{type: "text", value: "world", id: "rt-1"}], id: "rt-2"},
    {type: "text", value: " and goodbye", id: "rt-3"},
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
        note: {inline: (tokens, _ctx) => ({type: "note", value: tokens})},
    },
});

dsl.parse("$$note(ok)%\nraw content\n%end$$");
```

```ts
// The raw form is not supported → entire tag degrades to fallback text
[
    {type: "text", value: "$$note(ok)%\nraw content\n%end$$", id: "rt-0"},
]
```

### `allowForms` restriction → form stripped

When `allowForms` excludes a form, the parser acts as if handlers don't support it — even if they do.

```ts
const dsl = createParser({
    handlers: {
        bold: {inline: (tokens, _ctx) => ({type: "bold", value: tokens})},
        code: {raw: (arg, content, _ctx) => ({type: "code", lang: arg ?? "text", value: content})},
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

dsl.parse("Hello $$bold(world", {onError: (e) => errors.push(e)});
// → [{ type: "text", value: "Hello $$bold(world", id: "rt-0" }]
//
// errors[0].code === "INLINE_NOT_CLOSED"
```

Without `onError`, the same recovery happens silently — no error is thrown.

---

## Vue 3 Rendering

The parser produces a `TextToken[]` tree — here is a drop-in recursive Vue 3 component that renders it.

### 1. Set up the parser

```ts
// dsl.ts
import {
    createParser,
    createSimpleInlineHandlers,
    parsePipeArgs,
    parsePipeTextArgs,
    createToken,
    materializeTextTokens,
    type TagHandler,
    type TokenDraft,
} from "yume-dsl-rich-text";

const titledHandler = (type: string, defaultTitle: string): TagHandler => ({
    inline: (tokens, ctx): TokenDraft => {
        const args = parsePipeArgs(tokens, ctx);
        if (args.parts.length <= 1) {
            return {type, title: defaultTitle, value: args.materializedTokens(0)};
        }
        return {type, title: args.text(0), value: args.materializedTailTokens(1)};
    },
    block: (arg, tokens, _ctx): TokenDraft => ({
        type,
        title: arg || defaultTitle,
        value: tokens,
    }),
    raw: (arg, content, ctx): TokenDraft => ({
        type,
        title: arg || defaultTitle,
        value: [createToken({type: "text", value: content}, undefined, ctx)],
    }),
});

const collapseBase = titledHandler("collapse", "Click to expand");

export const dsl = createParser({
    handlers: {
        ...createSimpleInlineHandlers([
            "bold", "thin", "underline", "strike", "code", "center",
        ]),

        link: {
            inline: (tokens, ctx): TokenDraft => {
                const args = parsePipeArgs(tokens, ctx);
                const url = args.text(0);
                const display =
                    args.parts.length > 1
                        ? args.materializedTailTokens(1)
                        : args.materializedTokens(0);
                return {type: "link", url, value: display};
            },
        },

        info: titledHandler("info", "Info"),
        warning: titledHandler("warning", "Warning"),

        collapse: {block: collapseBase.block, raw: collapseBase.raw},

        "raw-code": {
            raw: (arg, content, ctx): TokenDraft => {
                const args = parsePipeTextArgs(arg ?? "", ctx);
                return {
                    type: "raw-code",
                    codeLang: args.text(0),
                    title: args.text(1) || "Code:",
                    label: args.text(2) ?? "",
                    value: content,
                };
            },
        },

        date: {
            inline: (tokens, ctx): TokenDraft => {
                const args = parsePipeArgs(tokens, ctx);
                return {
                    type: "date",
                    date: args.text(0),
                    format: args.text(1) || undefined,
                    value: "",
                };
            },
        },

        fromNow: {
            inline: (tokens, ctx): TokenDraft => {
                const args = parsePipeArgs(tokens, ctx);
                return {
                    type: "fromNow",
                    date: args.text(0),
                    value: "",
                };
            },
        },
    },
});
```

### 2. Create the recursive renderer component

```vue
<!-- RichTextRenderer.vue -->
<script lang="ts" setup>
  import type {TextToken} from "yume-dsl-rich-text";
  import {type Component, h} from "vue";

  defineOptions({name: "RichTextRenderer"});

  const props = defineProps<{
    tokens: TextToken[];
  }>();

  /* ── tag → element / component map ── */
  type RenderTarget = string | Component;

  const tagMap: Record<string, RenderTarget> = {
    bold: "strong",
    thin: "span",
    underline: "span",
    strike: "s",
    center: "span",
    code: "code",
    link: "a",
    // Add your own component mappings here, e.g.:
    // info:     NAlert,
    // collapse: CollapseWrapper,
  };

  /* ── per-type props ── */
  const getComponentProps = (token: TextToken) => {
    switch (token.type) {
      case "link":
        return {
          href: normalizeUrl(token.url as string),
          rel: "noopener noreferrer",
          target: "_blank",
        };
      case "info":
      case "warning":
        return {title: token.title};
      case "collapse":
        return {title: token.title ?? ""};
      case "raw-code":
        return {
          code: token.value as string,
          codeLang: token.codeLang,
          title: token.title,
          label: token.label,
        };
      default:
        return {};
    }
  };

  /* ── per-type CSS classes ── */
  const getComponentClass = (token: TextToken) => [
    `rich-${token.type}`,
    {
      "rich-underline": token.type === "underline",
      "rich-strike": token.type === "strike",
      "rich-center": token.type === "center",
      "rich-code": token.type === "code",
    },
  ];

  /* ── URL sanitiser ── */
  const normalizeUrl = (raw: string): string | undefined => {
    if (!raw) return undefined;
    try {
      const url = raw.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//)
          ? new URL(raw)
          : new URL("https://" + raw);
      return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
</script>

<template>
  <template v-for="token in tokens" :key="token.id">
    <!-- plain text -->
    <span v-if="token.type === 'text'" v-text="token.value"/>

    <!-- raw-code: value is a string, no recursion -->
    <component
        v-else-if="token.type === 'raw-code'"
        :is="tagMap[token.type] ?? 'pre'"
        :class="getComponentClass(token)"
        v-bind="getComponentProps(token)"
    >{{ token.value }}
    </component>

    <!-- everything else: recurse into children -->
    <component
        v-else
        :is="tagMap[token.type] ?? 'span'"
        :class="getComponentClass(token)"
        v-bind="getComponentProps(token)"
    >
      <RichTextRenderer
          v-if="Array.isArray(token.value) && token.value.length"
          :tokens="token.value"
      />
      <template v-else-if="typeof token.value === 'string'">
        {{ token.value }}
      </template>
    </component>
  </template>
</template>
```

### 3. Use it

```vue

<script setup>
  import {dsl} from "./dsl";
  import RichTextRenderer from "./RichTextRenderer.vue";

  const tokens = dsl.parse(
      "Hello $$bold(world)$$! Visit $$link(https://example.com|my site)$$."
  );
</script>

<template>
  <RichTextRenderer :tokens="tokens"/>
</template>
```

### Extending with UI libraries

The `tagMap` object is the integration point. Map any tag type to a Vue component:

```ts
import {NAlert, NCollapse, NCollapseItem} from "naive-ui";
import CodeBlock from "./CodeBlock.vue";

const tagMap: Record<string, RenderTarget> = {
    bold: "strong",
    link: "a",
    info: NAlert,        // renders $$info(title)* ... *end$$ as <n-alert>
    warning: NAlert,
    "raw-code": CodeBlock,     // renders $$raw-code(ts)% ... %end$$ as your code block
    collapse: CollapseWrapper,
};
```

For tags that need runtime logic (e.g. date formatting), use a functional component:

```ts
import {type FunctionalComponent, h} from "vue";

const DateText: FunctionalComponent<{ date?: string }> = (props) =>
    h("span", formatDate(props.date));

tagMap.date = DateText;
```

---

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
