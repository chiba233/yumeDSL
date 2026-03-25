[English](./README.md) | **中文**

# yume-dsl-rich-text

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

零依赖、递归解析的富文本 DSL 解析器，支持可插拔的标签处理器和可配置语法。

**仅包含解析器核心。**
本包不附带内置标签、渲染或 UI 集成。
语义和渲染层完全由你定义。

---

## 目录

- [适用场景](#适用场景)
- [特性](#特性)
- [优雅降级](#优雅降级)
- [安装](#安装)
- [快速开始](#快速开始)
- [DSL 语法](#dsl-语法)
  - [行内标签](#行内标签)
  - [原始标签](#原始标签)
  - [块级标签](#块级标签)
  - [管道参数](#管道参数)
  - [转义序列](#转义序列)
- [API](#api)
  - [createParser](#createparser)
- [ParseOptions](#parseoptions)
- [Token 结构](#token-结构)
  - [强类型](#强类型)
- [编写标签处理器](#编写标签处理器)
- [工具函数导出](#工具函数导出)
  - [PipeArgs](#pipeargs)
- [自定义语法](#自定义语法)
  - [createSyntax](#createsyntax)
- [错误处理](#错误处理)
- [更新日志](#更新日志)
- [许可证](#许可证)

---

## 适用场景

适合以下需求：

- 使用自定义富文本 DSL 而非 Markdown
- 需要对解析语义和渲染行为有高度控制
- 标签形式不支持时需要优雅降级
- 小巧的解析器核心，无预设语义
- 可预测的解析行为，无正则回溯

本包仅将 DSL 输入解析为 token。
渲染完全由你负责。

---

## 特性

- 零依赖
- 递归解析，支持深度限制
- 可插拔的标签处理器
- 行内 / 原始 / 块级三种标签形式
- 可配置语法符号
- 未知标签优雅降级
- 自定义错误上报
- 管道参数和 token 处理工具函数
- 单遍前向扫描（无回溯）
- 不使用正则表达式解析
- 确定性线性扫描

---

## 优雅降级

未知或不支持的标签不会抛出错误，
而是优雅降级，不影响整体解析结果。

这允许在不崩溃的情况下部分支持 DSL。

---

## 安装

```bash
npm install yume-dsl-rich-text
pnpm add yume-dsl-rich-text
yarn add yume-dsl-rich-text
```

---

## 快速开始

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

未注册的标签会优雅降级，而不是抛出异常。

### stripRichText

```ts
import { stripRichText } from "yume-dsl-rich-text";

const plain = stripRichText("Hello $$bold(world)$$!");
// "Hello world!"
```

适用于提取可搜索的纯文本、生成摘要或构建无障碍标签。

---

## DSL 语法

默认使用 `$$` 作为标签前缀。

支持三种形式：

### 行内标签

```text
$$tagName(content)$$
```

行内内容递归解析，嵌套自然生效。

```text
$$bold(Hello $$italic(world)$$)$$
```

### 原始标签

```text
$$tagName(arg)%
原始内容，按原样保留
%end$$
```

原始内容不会递归解析。

关闭标记 `%end$$` 必须独占一行。

### 块级标签

```text
$$tagName(arg)*
块级内容，递归解析
*end$$
```

块级内容递归解析。

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

### `parseRichText(text, options?)`

将 DSL 字符串解析为 token 树。

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];
```

### `stripRichText(text, options?)`

将 DSL 字符串解析并展平为纯文本。

```ts
function stripRichText(text: string, options?: ParseOptions): string;
```

### `createParser(defaults)`

创建一个预绑定选项的可复用解析器实例，避免每次调用都传入相同的 handlers。

```ts
import { createParser } from "yume-dsl-rich-text";

const dsl = createParser({
  handlers: {
    bold: { inline: (tokens) => ({ type: "bold", value: tokens }) },
    // ...
  },
});

// 无需再次传入 handlers
dsl.parse("Hello $$bold(world)$$!");
dsl.strip("Hello $$bold(world)$$!");

// 仍然接受单次调用的覆盖选项
dsl.parse(text, { onError: (e) => console.warn(e) });
```

```ts
interface Parser {
  parse: (text: string, overrides?: ParseOptions) => TextToken[];
  strip: (text: string, overrides?: ParseOptions) => string;
}
```

提供 `overrides` 时，会浅合并到默认值上（`{ ...defaults, ...overrides }`）。

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

### 字段

- `handlers`：标签名 → 处理器定义
- `blockTags`：需要块级换行规范化的标签
- `depthLimit`：最大嵌套深度，默认 `50`
- `mode`：
  - `"render"` 规范化块级换行
  - `"highlight"` 保留原始换行
- `onError`：解析错误回调
- `syntax`：覆盖默认语法符号

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

`TextToken` 是解析器的输出类型。`type` 和 `value` 字段使用宽松类型（`string`），以便解析器可以在不了解你的 schema 的情况下表示任意标签。

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

`TagHandler` 可以定义三种标签形式的行为。

```ts
interface TagHandler {
  inline?: (tokens: TextToken[]) => TokenDraft;
  raw?: (arg: string | undefined, content: string) => TokenDraft;
  block?: (arg: string | undefined, content: TextToken[]) => TokenDraft;
}
```

你只需实现标签支持的形式。
不支持的形式会优雅降级，而非中断解析。

### 示例

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

### 推荐：createParser

实际使用中，通常会在各处复用相同的 handlers。
使用 [`createParser`](#createparser) 绑定一次即可：

```ts
import { createParser } from "yume-dsl-rich-text";

const dsl = createParser({ handlers });

// 到处使用
dsl.parse(text);
dsl.strip(text);

// 需要时添加 onError
dsl.parse(text, { onError: (error) => console.warn(error) });
```

---

## 工具函数导出

这些辅助函数在编写处理器时很有用。

| 导出 | 说明 |
|------|------|
| `parsePipeArgs(tokens)` | 按 `\|` 分割 token 并访问解析后的部分 |
| `parsePipeTextArgs(text)` | 同上，但输入为纯文本 |
| `splitTokensByPipe(tokens)` | 底层 token 分割器 |
| `extractText(tokens)` | 将 token 树展平为纯文本 |
| `materializeTextTokens(tokens)` | 反转义 token 树中的文本 token |
| `unescapeInline(str)` | 反转义单个字符串 |
| `createToken(draft)` | 为 token draft 添加自增 `id` |
| `resetTokenIdSeed()` | 重置 token id 计数器，用于测试 |

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

| 字段 | 说明 |
|------|------|
| `parts` | 按 `\|` 分割的原始 token 数组 |
| `text(i)` | 第 `i` 部分的纯文本，已反转义并去除首尾空格 |
| `materializedTokens(i)` | 第 `i` 部分已反转义的 token |
| `materializedTailTokens(i)` | 从索引 `i` 起所有部分合并成的 token 数组 |

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

| 错误码 | 含义 |
|--------|------|
| `DEPTH_LIMIT` | 嵌套超过 `depthLimit` |
| `UNEXPECTED_CLOSE` | 孤立的关闭标签，无匹配的打开标签 |
| `INLINE_NOT_CLOSED` | 行内标签未闭合 |
| `BLOCK_NOT_CLOSED` | 块级关闭标记缺失 |
| `BLOCK_CLOSE_MALFORMED` | 块级关闭标记存在但格式错误 |
| `RAW_NOT_CLOSED` | 原始关闭标记缺失 |
| `RAW_CLOSE_MALFORMED` | 原始关闭标记存在但格式错误 |

---

## 更新日志

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
- 支持行内、原始和块级标签形式的递归 DSL 解析器
- 可插拔的标签处理器，支持优雅降级
- 可配置语法符号
- 工具函数：`parsePipeArgs`、`extractText`、`materializeTextTokens` 等

---

## 许可证

MIT
