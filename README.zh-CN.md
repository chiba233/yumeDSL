[English](./README.md) | **中文**

# yume-dsl-rich-text (ユメテキスト)

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

[![npm](https://img.shields.io/npm/v/yume-dsl-rich-text)](https://www.npmjs.com/package/yume-dsl-rich-text)
[![GitHub](https://img.shields.io/badge/GitHub-chiba233%2FyumeDSL-181717?logo=github)](https://github.com/chiba233/yumeDSL)

零依赖、递归解析的富文本 DSL 解析器，支持可插拔的标签处理器和可配置语法。
亦可嵌入 Markdown 或其他标记语言中作为二级语法层使用。

**仅包含解析器核心。**
本包不附带内置标签、渲染或 UI 集成。
语义和渲染层完全由你定义。

---

## 目录

- [设计理念](#设计理念)
- [适用场景](#适用场景)
- [边界说明](#边界说明)
- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [DSL 语法](#dsl-语法)
  - [Inline 标签](#Inline 标签)
  - [Raw 标签](#Raw 标签)
  - [Block 标签](#Block 标签)
  - [管道参数](#管道参数)
  - [转义序列](#转义序列)
- [API](#api)
  - [createParser](#createparserdefaults--推荐入口)
  - [parseRichText / stripRichText](#parserichtext--striprichtext)
- [处理器辅助函数](#处理器辅助函数)
  - [createSimpleInlineHandlers](#createsimpleinlinehandlersnames)
  - [declareMultilineTags](#declaremultilinetagsnames)
  - [createSimpleBlockHandlers](#createsimpleblockhandlersnames)
  - [createSimpleRawHandlers](#createsimplerawhandlersnames)
  - [createPassthroughTags（进阶）](#createpassthroughtagsnames进阶)
- [ParseOptions](#parseoptions)
- [Token 结构](#token-结构)
  - [强类型](#强类型)
- [编写标签处理器](#编写标签处理器)
- [工具函数导出](#工具函数导出)
  - [PipeArgs](#pipeargs)
- [自定义语法](#自定义语法)
  - [createSyntax](#createsyntax)
- [自定义标签名字符规则](#自定义标签名字符规则)
- [错误处理](#错误处理)
- [优雅降级](#优雅降级)
- [更新日志](#更新日志)
- [许可证](#许可证)

---

## 设计理念

本解析器采用 **「解析器核心 + 用户定义语义」** 架构：

- **解析器不认识任何标签。** 没有内置的 `bold`、`link`、`code` 等标签。每个标签的含义由你注册的处理器定义。
- **处理器就是语义层。** 处理器接收解析后的 token，返回 `TokenDraft` — 输出结构、附加字段、行为全部由你决定。
- **渲染不是我们的工作。** 解析器产出 token 树；如何渲染（React、Vue、纯 HTML、终端）完全由你负责。
- **默认优雅降级。** 未知或不支持的标签永远不会抛出异常 — 它们静默降级，让部分 DSL 支持也能正常工作。

这种分离意味着你可以替换渲染框架、新增标签、修改标签语义，而无需触碰解析器。

---

## 适用场景

适合以下需求：

- 使用自定义富文本 DSL 而非 Markdown
- 需要对解析语义和渲染行为有高度控制
- 标签形式不支持时需要优雅降级
- 小巧的解析器核心，无预设语义
- 可预测的解析行为，无正则回溯

---

## 边界说明

本包**会做**的事：

- 将 DSL 字符串解析为 token 树（`TextToken[]`）
- 通过处理器提供标签注册 — 标签只有注册了才存在
- 处理递归嵌套、转义、管道参数分割
- 未知或格式错误的标签优雅降级
- 通过 `onError` 上报结构化错误

本包**不会做**的事：

- 附带任何内置标签（没有 bold、italic、link 等）
- 将 token 渲染为 HTML、React 组件或任何输出格式
- 校验 token 语义（那是处理器的工作）
- 提供 Markdown 兼容的语法

---

## 特性

- 零依赖
- 递归解析，支持深度限制
- 可插拔的标签处理器
- inline / raw / block 三种标签形式
- 处理器辅助函数，支持批量注册标签
- 可配置语法符号
- 未知标签优雅降级
- 自定义错误上报
- 管道参数和 token 处理工具函数
- 单遍前向扫描（无回溯）
- 不使用正则表达式解析
- 确定性线性扫描

---

## 安装

```bash
npm install yume-dsl-rich-text
pnpm add yume-dsl-rich-text
yarn add yume-dsl-rich-text
```

---

## 快速开始

### 1. 创建解析器并注册标签

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

### 2. 解析

```ts
const tokens = dsl.parse("Hello $$bold(world)$$!");
```

结果：

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

### 3. 提取纯文本

```ts
const plain = dsl.strip("Hello $$bold(world)$$!");
// "Hello world!"
```

适用于提取可搜索的纯文本、生成摘要或构建无障碍标签。

未注册的标签会优雅降级，而不是抛出异常。

---

## DSL 语法

默认使用 `$$` 作为标签前缀。
标签名允许 `a-z`、`A-Z`、`0-9`、`_`、`-`（首字符不能是数字或 `-`）。
如需自定义，参见[自定义标签名字符规则](#自定义标签名字符规则)。

支持三种形式：

### Inline 标签

```text
$$tagName(content)$$
```

Inline 内容递归解析，嵌套自然生效。

```text
$$bold(Hello $$italic(world)$$)$$
```

### Raw 标签

```text
$$tagName(arg)%
Raw 内容，按原样保留
%end$$
```

Raw 内容不会递归解析。

关闭标记 `%end$$` 必须独占一行。

### Block 标签

```text
$$tagName(arg)*
Block 内容，递归解析
*end$$
```

Block 内容递归解析。

关闭标记 `*end$$` 必须独占一行。

### 管道参数

在参数中，`|` 用于分隔多个参数。

```text
$$link(https://example.com | click here)$$
$$code(js | Title | label)%
const x = 1;
%end$$
```

使用 `\|` 转义字面管道符。

### 转义序列

在语法符号前加 `\` 使其作为字面量输出。

- `\(` → `(`
- `\)` → `)`
- `\|` → `|`
- `\\` → `\`
- `\%end$$` → `%end$$`
- `\*end$$` → `*end$$`

---

## API

### `createParser(defaults)` — 推荐入口

`createParser` 将你的 `ParseOptions`（handlers、syntax、tagName、mode、depthLimit、onError）绑定为一个可复用实例。
这是**推荐的使用方式** — 定义一次标签处理器，然后在各处调用 `dsl.parse()` / `dsl.strip()`，无需重复传入配置。

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

// 到处使用 — handlers 已经绑定
dsl.parse("Hello $$bold(world)$$!");
dsl.strip("Hello $$bold(world)$$!");

// 单次覆盖会浅合并到默认值上
dsl.parse(text, { onError: (e) => console.warn(e) });
```

**`createParser` 绑定了什么：**

| 选项           | 预绑定后的效果                                  |
|--------------|------------------------------------------|
| `handlers`   | 标签定义 — 不需要每次调用都传入                        |
| `syntax`     | 自定义语法符号（如覆盖 `$$` 前缀等）                    |
| `tagName`    | 自定义标签名字符规则                               |
| `mode`       | `"render"` 或 `"highlight"` — 为你的场景设置一次即可 |
| `depthLimit` | 嵌套深度限制 — 很少需要逐次修改                        |
| `onError`    | 默认错误处理器（仍可按次覆盖）                          |

**不用 `createParser` 的话**，每次调用都需要传入完整选项：

```ts
// 重复 — 必须到处传 handlers
parseRichText(text1, { handlers });
parseRichText(text2, { handlers });
stripRichText(text3, { handlers });

// 用 createParser — 绑定一次，到处使用
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

底层无状态函数。适用于一次性调用或需要完全控制每次调用参数的场景。

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];

function stripRichText(text: string, options?: ParseOptions): string;
```

大多数应用场景建议使用 [`createParser`](#createparser--推荐入口)。

---

## 处理器辅助函数

大多数项目中的标签都是简单包装器 — bold、italic、underline 等 — 不需要自定义逻辑。为每个标签写完整的
`{ inline: (tokens) => ({ type: "bold", value: ... }) }` 很繁琐。辅助函数让你可以批量注册。

### `createSimpleInlineHandlers(names)`

为一组标签名创建inline 处理器。
每个处理器将子 token 物化后包装为 `{ type: tagName, value: materializedTokens }`。

这是注册简单标签的**推荐方式**。

```ts
import { createParser, createSimpleInlineHandlers } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    // 一行注册 5 个标签，而不是写 5 个处理器对象
    ...createSimpleInlineHandlers(["bold", "italic", "underline", "strike", "code"]),

    // 与需要更多逻辑的自定义处理器混合使用
    link: {
      inline: (tokens) => { /* ... */
      }
    },
  },
});
```

**它替代了什么：**

```ts
// 之前 — 重复
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

// 之后 — 一行搞定
...
createSimpleInlineHandlers(["bold", "italic", "underline"])
```

```ts
function createSimpleInlineHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `declareMultilineTags(names)`

声明哪些已注册的标签是多行类型。返回 `BlockTagInput[]`，传入 `ParseOptions.blockTags`。

该函数**不**注册标签或创建处理器 — 它只告诉解析器哪些标签需要换行符修剪（剥离 `)*` / `)%` 开启符后的前导 `\n`，以及
`*end$$` / `%end$$` 关闭符前的尾随 `\n`）。

每个条目可以是纯标签名（raw 和 block 形式均执行修剪 — 向后兼容），也可以是带 `forms` 数组的对象，将修剪限定到特定的多行形式。

```ts
import { createParser, createSimpleInlineHandlers, declareMultilineTags } from "yume-dsl-rich-text";

// 基础用法 — 所有多行形式均修剪（向后兼容）
const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold", "italic"]),
    info: { /* 自定义处理器，单独注册 */ },
    warning: { /* 自定义处理器，单独注册 */ },
  },
  blockTags: declareMultilineTags(["info", "warning"]),
});

// 细粒度 — 将修剪限定到特定形式
const dsl2 = createParser({
  handlers: { /* ... */ },
  blockTags: declareMultilineTags([
    "info",                              // raw 和 block 均修剪
    { tag: "code", forms: ["raw"] },     // 仅 raw 形式修剪
    { tag: "note", forms: ["block"] },   // 仅 block 形式修剪
  ]),
});
```

> **注意：** 如果省略 `blockTags`，解析器会从具有 `raw` 或 `block` 方法的处理器自动推导。
> 当需要显式控制哪些标签接受换行符修剪时使用 `declareMultilineTags`。

```ts
type MultilineForm = "raw" | "block";
type BlockTagInput = string | { tag: string; forms?: readonly MultilineForm[] };

function declareMultilineTags(names: readonly BlockTagInput[]): BlockTagInput[];
```

### `createSimpleBlockHandlers(names)`

创建block 处理器，对应 DSL 的多行 block 形式：`$$tag(arg)* ... *end$$`。
闭合标记 `*end$$` 必须独占一行，因此它更适合作为独立块使用，而不是和普通 inline 文本混排。
每个处理器直接透传 `arg` 和递归解析后的内容：`{ type: tagName, arg, value: content }`。

```ts
import { createParser, createSimpleInlineHandlers, createSimpleBlockHandlers } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold", "italic"]),
    ...createSimpleBlockHandlers(["info", "warning"]),
  },
});

dsl.parse("$$info(Notice)*\nThis is a $$bold(block)$$ example.\n*end$$");
// → [{ type: "info", arg: "Notice", value: [... 解析后的 token ...], id: "..." }]
```

```ts
function createSimpleBlockHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `createSimpleRawHandlers(names)`

为一组标签名创建raw 处理器，对应 DSL 的多行 raw 形式。每个处理器直接透传 `arg` 和 raw 字符串内容：
`{ type: tagName, arg, value: content }`。

解析后的 token 结构如下：

```ts
{
  type: string;
  arg ? : string;
  value: string;
}
```

适用于按原样保留内容的Raw 标签 — `$$tagName(arg)%...%end$$`。
和 block 标签一样，`%end$$` 也必须独占一行，因此更适合作为多行块书写。

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
// → [{ type: "code", arg: "ts", value: "const x = 1\n", id: "..." }]
```

```ts
function createSimpleRawHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `createPipeBlockHandlers(names)`

创建 block 处理器，既保留原始 `arg`，也会按 pipe 拆出 `args`，并保留解析后的 block 内容：
`{ type: tagName, arg, args, value: content }`。

它只处理结构，不会自动赋予 `title`、`label` 之类业务字段名。

```ts
import { createParser, createPipeBlockHandlers } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createPipeBlockHandlers(["panel"]),
  },
});
```

```ts
function createPipeBlockHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `createPipeRawHandlers(names)`

创建 raw 处理器，既保留原始 `arg`，也会按 pipe 拆出 `args`，并保留 raw 内容：
`{ type: tagName, arg, args, value: content }`。

适合需要复用 pipe 参数拆分，但又不想在核心 helper 里硬编码 `lang`、`title` 等业务字段名的场景。

```ts
import { createParser, createPipeRawHandlers } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    ...createPipeRawHandlers(["code"]),
  },
});
```

```ts
function createPipeRawHandlers(names: readonly string[]): Record<string, TagHandler>;
```

### `createPassthroughTags(names)`（进阶）

> 大多数场景推荐使用上面的 `createSimpleInlineHandlers`。

创建空的标签处理器（`{}`），仅让解析器识别标签名，不包含任何逻辑。
解析器对已注册但没有 `inline` 方法的标签会产出 `{ type: tagName, value: materializedTokens }` — 与
`createSimpleInlineHandlers` 输出结构相同。

区别在于**显式 vs 隐式**：`createSimpleInlineHandlers` 显式声明了每个标签的 inline 行为；`createPassthroughTags`
依赖你了解解析器对已注册标签的默认产出行为。同时 `handler.inline` 会是 `undefined`，如果外部代码需要检查处理器方法则需注意。

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
  createId?: (token: TokenDraft) => string;
  allowForms?: readonly ("inline" | "raw" | "block")[];
  blockTags?: readonly BlockTagInput[];
  depthLimit?: number;
  mode?: "render" | "highlight";
  onError?: (error: ParseError) => void;
  syntax?: Partial<SyntaxInput>;
}
```

### 字段

- `handlers`：标签名 → 处理器定义
- `createId`：覆盖本次解析的 token id 生成策略
- `allowForms`：限制解析器接受的标签形式（默认：全部启用）
- `blockTags`：需要 block 换行规范化的标签 — 接受纯字符串或 `{ tag, forms }` 对象以按形式控制
- `depthLimit`：最大嵌套深度，默认 `50`
- `mode`：
  - `"render"` 规范化 block 换行
  - `"highlight"` 保留原文换行
- `onError`：解析错误回调
- `syntax`：覆盖默认语法符号

### allowForms

控制解析器接受哪些标签形式。未列出的形式按处理器不支持处理 — 解析器优雅降级。

实际效果上，被禁用的形式会按普通文本保留，而且这个规则也适用于未注册标签。例如禁用 `"inline"` 后，
`$$unknown(...)$$` 会整体按原文保留，而不是去壳。

```ts
// 只允许 inline 标签 — block 和 raw 语法被忽略
const dsl = createParser({
  handlers,
  allowForms: ["inline"],
});

// 允许 inline 和 block，但不允许 raw
const dsl2 = createParser({
  handlers,
  allowForms: ["inline", "block"],
});
```

适用于用户生成内容（评论、聊天消息），希望允许简单的 inline 格式但禁止多行 block 或 raw 标签的场景。

省略时启用全部形式。

---

## Token 结构

```ts
interface TextToken {
  type: string;
  value: string | TextToken[];
  id: string;

  [key: string]: unknown;
}
```

`TextToken` 是解析器的输出类型。`type` 和 `value` 字段使用宽松类型（`string`），以便解析器可以在不了解你的 schema
的情况下表示任意标签。

处理器返回的额外字段（如 `url`、`lang`、`title`）会保留在结果 `TextToken` 上，类型为 `unknown`。你可以直接读取，只需在使用前收窄类型：

```ts
const token = tokens[0];
if (token.type === "link" && typeof token.href === "string") {
  console.log(token.href); // 可用，无需类型断言
}
```

处理器返回 `TokenDraft`，具有相同的开放结构：

```ts
interface TokenDraft {
  type: string;
  value: string | TextToken[];

  [key: string]: unknown;
}
```

### 强类型

对于简单场景，可以通过 `typeof` 收窄直接访问额外字段，无需类型断言。

如需对整个 token schema 实现完整的类型安全，定义继承 `TextToken` 的类型接口，并在调用处做一次类型断言：

```ts
import { parseRichText, type TextToken } from "yume-dsl-rich-text";

// 1. 定义你的 token 类型 — 继承 TextToken 以保持兼容性
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

// 2. 在调用处做一次类型断言
const tokens = parseRichText(input, options) as MyToken[];

// 3. 通过可辨识联合类型收窄
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

只要处理器返回的 draft 与联合类型匹配，类型断言就是安全的。
增删标签时相应更新联合类型，TypeScript 会在穷举 switch 中标记未处理的 `type`。

---

## 编写标签处理器

对于需要自定义逻辑的标签 — 提取参数、附加额外字段、支持多种形式 — 你需要手动编写 `TagHandler`。

简单包装标签请使用[处理器辅助函数](#处理器辅助函数)。在以下场景需要自定义处理器：

- **管道参数** — 如 `$$link(url | 显示文本)$$`
- **输出 token 上的额外字段** — 如 `url`、`lang`、`title`
- **多种形式** — 同一标签同时支持 inline、raw 和 block 语法
- **转换逻辑** — 如代码块的语言别名映射

### TagHandler 接口

```ts
interface TagHandler {
  inline?: (tokens: TextToken[]) => TokenDraft;
  raw?: (arg: string | undefined, content: string) => TokenDraft;
  block?: (arg: string | undefined, content: TextToken[]) => TokenDraft;
}
```

你只需实现标签支持的形式。
不支持的形式会优雅降级，而非中断解析。

### 示例：完整处理器集

```ts
import {
  createParser,
  createSimpleInlineHandlers,
  extractText,
  parsePipeArgs,
} from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    // 简单标签 — 使用辅助函数
    ...createSimpleInlineHandlers(["bold", "italic", "underline"]),

    // 自定义：管道参数 → 额外字段
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

    // 自定义：raw 形式 → 内容按原样保留
    code: {
      raw: (arg, content) => ({
        type: "code-block",
        lang: arg ?? "text",
        value: content,
      }),
    },

    // 自定义：同时支持 inline 和 block 形式
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

输入：

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

## 工具函数导出

### 配置

| 导出                               | 说明                       |
|----------------------------------|--------------------------|
| `DEFAULT_SYNTAX`                 | 内置语法符号（`$$`、`(`、`)$$` 等） |
| `createSyntax(overrides)`        | 覆盖语法符号，未提供字段回退默认值        |
| `DEFAULT_TAG_NAME`               | 内置标签名字符规则                |
| `createTagNameConfig(overrides)` | 覆盖标签名字符规则，未提供字段回退默认值     |

### 处理器辅助函数

批量创建处理器的便利函数 — 大多数项目只需要这些。

| 导出                                  | 说明                                |
|-------------------------------------|-----------------------------------|
| `createSimpleInlineHandlers(names)` | 批量创建简单标签的inline 处理器               |
| `createSimpleBlockHandlers(names)`  | 批量创建简单标签的block 处理器                |
| `createSimpleRawHandlers(names)`    | 批量创建简单标签的raw 处理器                  |
| `createPipeBlockHandlers(names)`    | 创建同时暴露 `arg` 与 `args` 的 block 处理器 |
| `createPipeRawHandlers(names)`      | 创建同时暴露 `arg` 与 `args` 的 raw 处理器   |
| `createPassthroughTags(names)`      | 批量注册空处理器的标签名                      |
| `declareMultilineTags(names)`       | 声明哪些标签需要多行换行符修剪                   |

### 处理器工具函数

编写自定义 `TagHandler` 时使用的底层工具。
如果你只使用上面的辅助函数，则不需要这些。

| 导出                              | 使用者                   | 说明                               |
|---------------------------------|-----------------------|----------------------------------|
| `parsePipeArgs(tokens)`         | 带 `\|` 参数的自定义处理器      | 按管道分割 token 并访问解析后的部分            |
| `parsePipeTextArgs(text)`       | 解析 raw 参数的自定义处理器      | 同上，但输入为纯文本字符串                    |
| `parsePipeTextList(text)`       | 只需 `string[]` 的自定义处理器 | 将管道分隔字符串直接拆分为 trim 后的 `string[]` |
| `splitTokensByPipe(tokens)`     | 底层处理器代码               | 按 pipe 分割 token 的底层工具，不含辅助方法     |
| `extractText(tokens)`           | 需要纯文本值的处理器            | 将 token 树展平为单个字符串                |
| `materializeTextTokens(tokens)` | 返回处理后子 token 的处理器     | 递归反转义 token 树中的文本 token          |
| `unescapeInline(str)`           | 处理 raw 字符串的处理器        | 反转义单个字符串中的 DSL 转义序列              |
| `createToken(draft)`            | 手动构建 token 的处理器       | 为 `TokenDraft` 添加 `id`           |
| `resetTokenIdSeed()`            | 测试代码                  | 重置 token id 计数器，用于确定性测试输出        |

> 解析期间，token id 默认按单次 parse 局部递增（`rt-0`、`rt-1` ...）。
> `createToken()` 只有在解析器外单独调用时才会使用模块级计数器，`resetTokenIdSeed()` 也主要用于这种测试场景。
> 如果你在 SSR 或并发异步请求里要求严格隔离，建议按运行时边界隔离 parser 的使用。

### PipeArgs

`parsePipeArgs` 和 `parsePipeTextArgs` 返回 `PipeArgs` 对象：

```ts
interface PipeArgs {
  parts: TextToken[][];
  text: (index: number) => string;
  materializedTokens: (index: number) => TextToken[];
  materializedTailTokens: (startIndex: number) => TextToken[];
}
```

| 字段                          | 说明                         |
|-----------------------------|----------------------------|
| `parts`                     | 按 `\|` 分割的未处理的 token 数组    |
| `text(i)`                   | 第 `i` 部分的纯文本，已反转义并去除首尾空格   |
| `materializedTokens(i)`     | 第 `i` 部分已反转义的 token        |
| `materializedTailTokens(i)` | 从索引 `i` 起所有部分合并成的 token 数组 |

### parsePipeTextList

如果只需要文本值的 `string[]`（不需要 token 树），可以使用 `parsePipeTextList` 简写：

```ts
import { parsePipeTextList } from "yume-dsl-rich-text";

parsePipeTextList("ts | Demo | Label");
// → ["ts", "Demo", "Label"]
```

这也是 `createPipeBlockHandlers` 和 `createPipeRawHandlers` 内部使用的方法。

---

## 自定义语法

可以通过 `options.syntax` 覆盖语法符号。

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

### 默认语法

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

> 注意：
> 语法符号之间必须保持可区分。
> 如果两个符号配置为相同的字符串，行为未定义。

### createSyntax

`createSyntax` 从部分覆盖构建完整的 `SyntaxConfig`。适用于需要在解析之外检查或复用已解析语法的场景。

```ts
import { createSyntax } from "yume-dsl-rich-text";

const syntax = createSyntax({ tagPrefix: "@@", endTag: ")@@" });

// SyntaxConfig 在 SyntaxInput 基础上扩展了一个预计算字段：
// syntax.escapableTokens — 可转义的符号，按长度降序排列
```

```ts
interface SyntaxConfig extends SyntaxInput {
  escapableTokens: string[];
}
```

正常使用不需要 `createSyntax` — `options.syntax` 接受 `Partial<SyntaxInput>`，解析器会在内部解析。

> 注意：
> 自定义 syntax 在解析期间通过模块级活动状态生效。
> 对普通同步调用是安全的；如果多个并发异步请求共享同一个模块实例，需要自行做好隔离。

---

## 自定义标签名字符规则

解析器通过两个函数决定哪些字符可以出现在标签名中：

| 函数               | 默认值                       | 作用       |
|------------------|---------------------------|----------|
| `isTagStartChar` | `a-z`、`A-Z`、`_`           | 标签名的首字符  |
| `isTagChar`      | `a-z`、`A-Z`、`0-9`、`_`、`-` | 首字符之后的字符 |

默认值导出为 `DEFAULT_TAG_NAME`。

### 覆盖方式

向 `createParser` 或 `parseRichText` 传入 `tagName` 选项。
只需指定要修改的函数，未指定的字段自动回退 `DEFAULT_TAG_NAME`。
`createTagNameConfig()` 是执行这个合并的便利函数，但你也可以直接传入部分对象。

**通过 `createParser`**（预绑定，推荐）：

```ts
import { createParser, createTagNameConfig } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    "ui:button": {
      inline: (value) => ({ type: "ui:button", value }),
    },
  },
  tagName: createTagNameConfig({
    isTagChar: (char) => /[A-Za-z0-9_:-]/.test(char),
  }),
});

dsl.parse("$$ui:button(hello)$$");
```

**通过 `parseRichText`**（单次调用）：

```ts
import { parseRichText } from "yume-dsl-rich-text";

const tokens = parseRichText("$$1ui:button(hello)$$", {
  handlers: {
    "1ui:button": {
      inline: (value) => ({ type: "1ui:button", value }),
    },
  },
  tagName: {
    isTagStartChar: (char) => /[A-Za-z0-9_]/.test(char),
    isTagChar: (char) => /[A-Za-z0-9_:-]/.test(char),
  },
});
```

---

## 错误处理

使用 `onError` 收集解析错误。

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

如果省略 `onError`，格式错误的标记会优雅降级，错误被静默丢弃。

### 错误码

`ParseError.code` 的类型为 `ErrorCode`，是所有可能错误码的联合类型：

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

| 错误码                     | 含义                |
|-------------------------|-------------------|
| `DEPTH_LIMIT`           | 嵌套超过 `depthLimit` |
| `UNEXPECTED_CLOSE`      | 孤立的关闭标签，无匹配的打开标签  |
| `INLINE_NOT_CLOSED`     | Inline 标签未闭合      |
| `BLOCK_NOT_CLOSED`      | Block 关闭标记缺失      |
| `BLOCK_CLOSE_MALFORMED` | Block 关闭标记存在但格式错误 |
| `RAW_NOT_CLOSED`        | Raw 关闭标记缺失        |
| `RAW_CLOSE_MALFORMED`   | Raw 关闭标记存在但格式错误   |

---

## 优雅降级

解析器永远不会因格式错误或未识别的输入而抛出异常。它将内容降级为纯文本，并通过 `onError` 可选地上报错误。以下是具体的降级场景。

### 未注册的标签 → 纯文本

不在 `handlers` 中的标签不会被识别。其内容被展开为纯文本。

```ts
const dsl = createParser({
  handlers: {
    ...createSimpleInlineHandlers(["bold"]),
    // "italic" 未注册
  },
});

dsl.parse("Hello $$bold(world)$$ and $$italic(goodbye)$$");
```

```ts
[
  { type: "text", value: "Hello ", id: "rt-0" },
  { type: "bold", value: [{ type: "text", value: "world", id: "rt-1" }], id: "rt-2" },
  { type: "text", value: " and goodbye", id: "rt-3" },
  //                      ↑ "italic" 未注册 — 内容变为纯文本
]
```

### 处理器不支持的形式 → 回退文本

处理器只需实现它支持的形式。如果标签以处理器不支持的形式使用，整个标记降级为纯文本。

```ts
const dsl = createParser({
  handlers: {
    // "note" 只支持 inline，不支持 raw
    note: { inline: (tokens) => ({ type: "note", value: tokens }) },
  },
});

dsl.parse("$$note(ok)%\nraw content\n%end$$");
```

```ts
// raw 形式不受支持 → 整个标签降级为回退文本
[
  { type: "text", value: "$$note(ok)%\nraw content\n%end$$", id: "rt-0" },
]
```

### `allowForms` 限制 → 形式被剥离

当 `allowForms` 排除了某种形式时，解析器视为处理器不支持该形式 — 即使实际支持。

```ts
const dsl = createParser({
  handlers: {
    bold: { inline: (tokens) => ({ type: "bold", value: tokens }) },
    code: { raw: (arg, content) => ({ type: "code", lang: arg ?? "text", value: content }) },
  },
  allowForms: ["inline"],   // ← 禁用了 raw 和 block
});

dsl.parse("$$bold(hello)$$");
// → [{ type: "bold", ... }]   ✓ inline 正常工作

dsl.parse("$$code(ts)%\nconst x = 1;\n%end$$");
// → [{ type: "text", value: "$$code(ts)%\nconst x = 1;\n%end$$", ... }]
//   ↑ raw 形式被禁用 — 整个标签降级为纯文本
```

### 未闭合标签 → 部分文本恢复

当标签打开但未关闭时，解析器上报错误并将开头标记恢复为纯文本。

```ts
const errors: ParseError[] = [];

dsl.parse("Hello $$bold(world", { onError: (e) => errors.push(e) });
// → [{ type: "text", value: "Hello $$bold(world", id: "rt-0" }]
//
// errors[0].code === "INLINE_NOT_CLOSED"
```

不提供 `onError` 时，同样的恢复行为静默发生 — 不会抛出任何异常。

---

## 更新日志

### 0.1.13

- 重组 `index.ts` 导出分组：配置、处理器辅助函数、处理器工具函数、类型子分组
- 重组 README「工具函数导出」章节为 配置 / 处理器辅助函数 / 处理器工具函数 子表格
- 将所有 `tagName` 文档集中到「自定义标签名字符规则」章节
- 修复 IDEA 中 dist smoke test 的 TS7016 错误（改用包名自引用 + `paths` 映射）

### 0.1.12

- `ParseOptions` 新增 `tagName`，允许用户自定义 `isTagStartChar` / `isTagChar`
- 新增 `TagNameConfig`、`DEFAULT_TAG_NAME`、`createTagNameConfig`
- README 补充 `parseRichText` 和 `createParser` 下的自定义标签名规则示例
- `declareMultilineTags` 新增按形式控制的细粒度声明 — 条目可使用 `{ tag, forms }` 对象将换行符修剪限定到特定多行形式
  （`"raw"` / `"block"`）
- 纯字符串条目完全向后兼容（同时修剪 raw 和 block 形式）
- 新增导出类型 `MultilineForm`、`BlockTagInput`、`BlockTagLookup`
- 内部：将 `Set<string>` 块标签查询替换为按形式感知的 `BlockTagLookup`；`deriveBlockTags` 现在按 handler 方法各自注册对应形式，
  自动推导更精确

### 0.1.11

- 默认将解析器生成的 token id 改为单次 parse 局部递增（每次解析从 `rt-0` 开始）
- 新增 `createId` 选项，允许按单次 parse / parser 覆盖 token id 生成策略

### 0.1.10

- 新增 `parsePipeTextList(text)` 工具函数 — 将管道分隔的参数字符串直接拆分为 `string[]`，无需中间 token 分配
- 重构 `createPipeBlockHandlers()` / `createPipeRawHandlers()`，内部改用 `parsePipeTextList`
- 为 inline 形式门控函数（`supportsInlineForm`）添加决策表注释，防止后续修改引入回归
- 为 `materializeTextTokens` 添加 JSDoc，明确其仅对 text 类型叶节点做反转义

### 0.1.9

- 移除 source map 文件以减小发布包体积
- 修复 `allowForms`：当禁用 `"inline"` 时，仍保留 `raw` / `block` handler 的标签不再错误接受 inline 语法
- 修复 `allowForms`：当禁用 `"inline"` 时，未注册的 `$$unknown(...)$$` 也会按原文保留
- 修复 `createSimpleBlockHandlers()` / `createSimpleRawHandlers()`：block / raw helper 不再隐式接受 inline 语法
- 修复自定义 syntax 对多字符 `tagOpen` / `tagClose` / `tagDivider` 的解析问题
- 修复 `allowForms: ["inline"]`：已注册但被 form 过滤掉的 block/raw-only 标签会按原文保留，不再被当成 unknown inline 标签
- 为 `onError` 增加保护，用户回调抛错时不再中断解析
- 补全自定义 syntax 的可转义 token，`endTag` / `rawOpen` / `blockOpen` 现在也能按字面量转义
- 新增 `createPipeBlockHandlers()` / `createPipeRawHandlers()` helper，用于结构化 pipe 参数拆分
- 补充 `allowForms` 与新 helper 的回归测试
- 补充自定义 syntax 边界测试、类型编译检查与更强的 fuzz 覆盖
- 微调 README，对多行 block/raw helper 与降级行为的说明更直观

### 0.1.8

- 新增 `ParseOptions.allowForms` 选项 — 限制解析器接受的标签形式（`"inline"`、`"raw"`、`"block"`），被禁用的形式优雅降级
- 新增 `createSimpleInlineHandlers(names)` 辅助函数 — 批量注册简单 inline 标签，无需编写重复的处理器对象
- 新增 `declareMultilineTags(names)` 辅助函数 — 声明哪些标签需要多行换行符修剪（`blockTags`）
- 新增 `createSimpleBlockHandlers(names)` 辅助函数 — 批量注册简单 block 标签
- 新增 `createSimpleRawHandlers(names)` 辅助函数 — 批量注册简单 raw 标签
- 新增 `createPassthroughTags(names)` 辅助函数 — 批量注册空处理器的标签名（进阶用法）
- 所有辅助函数均通过 `const` 泛型保留字面量 key 类型 — `createSimpleInlineHandlers(["bold", "italic"])` 推导为
  `Record<"bold" | "italic", TagHandler>`
- 导出 `TagForm` 类型

### 0.1.7

- 为 `TextToken` 添加索引签名（`[key: string]: unknown`）— 处理器返回的额外字段现在无需类型断言即可在类型系统中可见
- 移除 `createToken` 中不必要的 `as TextToken` 断言
- 在 tsconfig 中启用 `allowImportingTsExtensions` — 项目现在可以干净通过 `tsc --noEmit`
- 更新 README：文档化 `TextToken` 索引签名，推荐使用 `extends TextToken` 实现强类型

### 0.1.6

- 仅更新 Markdown。

### 0.1.5

- 添加 `createParser()` 工厂函数，支持预绑定选项
- 导出 `Parser` 接口

### 0.1.4

- 将 `ParseError.code` 从 `string` 收窄为 `ErrorCode` 联合类型
- 导出 `ErrorCode` 类型
- 优化 `extractText` — 用 `for...of` 循环替代 `.map().join("")`
- 优化 `getErrorContext` — 用单遍行计数器替代 `slice` + `split`
- 修复 `findMalformedWholeLineTokenCandidate` 中重复的 `trimStart()` 调用

### 0.1.3

- 全面重写 README，包含完整 API 文档
- 添加 LICENSE 文件
- 添加 CI 发布工作流（npm 和 GitHub Packages）
- 添加发布前 README 验证步骤

### 0.1.1

- 修复：确保解析错误正确上报
- 添加 golden 测试套件（60 个用例）和 dist 冒烟测试（36 个用例）
- 添加 CJS + ESM 双格式构建

### 0.1.0

- 首次发布
- 支持 inline、raw 和 block 标签形式的递归 DSL 解析器
- 可插拔的标签处理器，支持优雅降级
- 可配置语法符号
- 工具函数：`parsePipeArgs`、`extractText`、`materializeTextTokens` 等

---

## 许可证

MIT
