# yume-rich-text

A zero-dependency, recursive rich-text DSL parser with pluggable tag handlers and configurable syntax.

The core package provides only the parsing engine — no built-in tags.
You define your own tags, or install a companion handler package.

## Features

- Zero dependencies
- Recursive parsing
- Pluggable tag handlers
- Inline / Raw / Block tag forms
- Configurable syntax tokens
- Graceful degradation for unknown tags
- Depth-limited parsing
- Custom error reporting
- Utility helpers for pipe arguments and token processing

## Install

```bash
npm install yume-dsl-rich-text
```

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

// [
//   { type: "text", value: "Hello ", id: "rt-0" },
//   {
//     type: "bold",
//     value: [{ type: "text", value: "world", id: "rt-1" }],
//     id: "rt-2"
//   },
//   { type: "text", value: "!", id: "rt-3" },
// ]
```

Unregistered tags degrade to plain text instead of throwing or crashing.

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

Parses a DSL string into a token tree.

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];
```

### `stripRichText(text, options?)`

Parses a DSL string and flattens the result into plain text.

```ts
function stripRichText(text: string, options?: ParseOptions): string;
```

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

Handlers may attach additional runtime fields such as `url`, `lang`, or `title`.

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
Unsupported forms fall back to plain text.

### Example

```ts
import {
  parseRichText,
  parsePipeArgs,
  extractText,
} from "yume-rich-text";

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

const tokens = parseRichText(input, { handlers });
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

---

## Custom Syntax

You can override syntax tokens through `options.syntax`.

```ts
import { parseRichText } from "yume-rich-text";

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
import { DEFAULT_SYNTAX } from "yume-rich-text";

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

---

## Error Handling

Use `onError` to collect parse errors.

```ts
const errors: ParseError[] = [];

parseRichText("$$bold(unclosed", {
  handlers: {
    bold: {
      inline: (tokens) => ({ type: "bold", value: tokens }),
    },
  },
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

If `onError` is omitted, malformed markup degrades to plain text and errors are discarded.

### Error Codes

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

## License

MIT