# yume-rich-text

A zero-dependency, recursive rich-text DSL parser with **pluggable tag handlers** and **configurable syntax**.

The core package provides only the parsing engine. Tag definitions (bold, link, code-block, etc.) are **not** included — you register your own handlers, or install a companion handler package.

## Install

```bash
npm install yume-rich-text
```

## Quick Start

```ts
import { parseRichText } from "yume-rich-text";

const tokens = parseRichText("Hello $$bold(world)$$!", {
  handlers: {
    bold: {
      inline: (tokens) => ({ type: "bold", value: tokens }),
    },
  },
});
// → [
//   { type: "text", value: "Hello ", id: "rt-0" },
//   { type: "bold", value: [{ type: "text", value: "world", id: "rt-1" }], id: "rt-2" },
//   { type: "text", value: "!", id: "rt-3" },
// ]
```

Tags that are **not** registered in `handlers` degrade to plain text — no crash, no error.

---

## DSL Syntax

Default syntax uses `$$` as the tag prefix. Three tag forms are supported:

### Inline

```
$$tagName(content)$$
```

Content is parsed recursively and may contain nested tags.

```
$$bold(Hello $$italic(world)$$)$$
```

### Raw (no inner parsing)

```
$$tagName(arg)%
raw content preserved as-is
%end$$
```

The close marker `%end$$` **must** sit on its own line.

### Block (parsed content)

```
$$tagName(arg)*
block content — parsed recursively
*end$$
```

The close marker `*end$$` **must** sit on its own line. Blocks support nesting.

### Pipe Parameters

Inside tag arguments, `|` splits parameters:

```
$$link(https://example.com | click here)$$
$$code(js | Title | label)%
const x = 1;
%end$$
```

Use `\|` to escape a literal pipe.

### Escape Sequences

Prefix any syntax token with `\` to produce a literal:

| Escape | Output |
|--------|--------|
| `\(` | `(` |
| `\)` | `)` |
| `\|` | `|` |
| `\\` | `\` |
| `\%end$$` | `%end$$` |
| `\*end$$` | `*end$$` |

---

## API

### `parseRichText(text, options?)`

Parse a DSL string into a token tree.

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];
```

### `stripRichText(text, options?)`

Parse and flatten to a plain string (all tags removed).

```ts
function stripRichText(text: string, options?: ParseOptions): string;
```

### `ParseOptions`

```ts
interface ParseOptions {
  handlers?: Record<string, TagHandler>;   // tag name → handler
  blockTags?: string[];   // tags with block-level line-break normalization
                          // defaults to tags whose handler has `raw` or `block`
  depthLimit?: number;    // max nesting depth (default: 50)
  mode?: "render" | "highlight";   // "render" normalises block line breaks,
                                   // "highlight" preserves them
  onError?: (error: ParseError) => void;   // error callback
  syntax?: Partial<SyntaxInput>;           // override syntax tokens
}
```

### `TextToken`

Every node in the output tree:

```ts
interface TextToken {
  type: string;                    // "text" or the tag name
  value: string | TextToken[];     // plain text or nested children
  id: string;                      // unique id (e.g. "rt-0")
}
```

Handlers can attach arbitrary extra properties (e.g. `url`, `lang`, `title`) — they are preserved on the token at runtime.

---

## Writing Tag Handlers

A `TagHandler` defines how a tag is parsed in each of the three forms:

```ts
interface TagHandler {
  inline?: (tokens: TextToken[]) => TokenDraft;
  raw?:    (arg: string | undefined, content: string) => TokenDraft;
  block?:  (arg: string | undefined, content: TextToken[]) => TokenDraft;
}
```

You only need to implement the forms your tag supports. Unimplemented forms fall back to text.

### Example: full handler set

```ts
import { parseRichText, parsePipeArgs, extractText } from "yume-rich-text";

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
        value: args.parts.length > 1
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
    // also usable as inline
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

const tokens = parseRichText(input, { handlers });
```

---

## Utility Exports

These helpers are useful when writing tag handlers:

| Export | Description |
|--------|-------------|
| `parsePipeArgs(tokens)` | Split tokens by `\|` → `PipeArgs` with `.text(i)`, `.materializedTokens(i)`, `.materializedTailTokens(i)` |
| `parsePipeTextArgs(text)` | Same as above but from a plain string |
| `splitTokensByPipe(tokens)` | Low-level: split into `TextToken[][]` |
| `extractText(tokens)` | Flatten a token tree to a plain string |
| `materializeTextTokens(tokens)` | Unescape text tokens in a tree |
| `unescapeInline(str)` | Unescape a single string |
| `createToken(draft)` | Add an auto-incremented `id` to a `TokenDraft` |
| `resetTokenIdSeed()` | Reset the id counter (useful in tests) |

---

## Custom Syntax

Override any syntax token via `options.syntax`:

```ts
const tokens = parseRichText("@@bold(hello)@@", {
  syntax: {
    tagPrefix: "@@",
    endTag: ")@@",
  },
  handlers: {
    bold: { inline: (t) => ({ type: "bold", value: t }) },
  },
});
```

Full defaults:

```ts
import { DEFAULT_SYNTAX } from "yume-rich-text";

// DEFAULT_SYNTAX = {
//   tagPrefix:  "$$",
//   tagOpen:    "(",
//   tagClose:   ")",
//   tagDivider: "|",
//   endTag:     ")$$",
//   rawOpen:    ")%",
//   blockOpen:  ")*",
//   blockClose: "*end$$",
//   rawClose:   "%end$$",
//   escapeChar: "\\",
// }
```

> **Warning**: Syntax tokens must be mutually distinguishable. Setting two tokens to the same string will cause undefined behaviour.

---

## Error Handling

Pass an `onError` callback to receive parse errors. If omitted, errors are silently discarded and malformed markup degrades to plain text.

```ts
const errors: ParseError[] = [];

parseRichText("$$bold(unclosed", {
  handlers: { bold: { inline: (t) => ({ type: "bold", value: t }) } },
  onError: (e) => errors.push(e),
});

// errors[0]:
// {
//   code: "INLINE_NOT_CLOSED",
//   message: "(L1:C1) Inline tag not closed:  >>>$$bold(<<< unclosed",
//   line: 1,
//   column: 1,
//   snippet: " >>>$$bold(<<< unclosed"
// }
```

### Error Codes

| Code | Meaning |
|------|---------|
| `DEPTH_LIMIT` | Nesting exceeded `depthLimit` |
| `UNEXPECTED_CLOSE` | Stray `)$$` with no matching open |
| `INLINE_NOT_CLOSED` | Inline tag never closed |
| `BLOCK_NOT_CLOSED` | Block `*end$$` marker missing |
| `BLOCK_CLOSE_MALFORMED` | `*end$$` exists but not on its own line |
| `RAW_NOT_CLOSED` | Raw `%end$$` marker missing |
| `RAW_CLOSE_MALFORMED` | `%end$$` exists but not on its own line |

---

## License

MIT
