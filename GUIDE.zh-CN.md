[English](./README.md) | **中文**

# yume-dsl-rich-text (ユメテキスト)

> **版本说明：** 若你使用同时支持 inline 与 block/raw 的标签，请使用 `1.0.7+`。
> `1.0.7` 修复了一个会影响换行语义的严重解析 bug。

### [▶ 在线演示 — DSL Fallback Museum](https://qwwq.org/blog/dsl-fallback-museum)

Shiki 代码高亮插件 · 合法插件用法 · 各种故意书写错误 · 错误报告

---

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

[![npm](https://img.shields.io/npm/v/yume-dsl-rich-text)](https://www.npmjs.com/package/yume-dsl-rich-text)
[![GitHub](https://img.shields.io/badge/GitHub-chiba233%2FyumeDSL-181717?logo=github)](https://github.com/chiba233/yumeDSL)
[![CI](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml/badge.svg)](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Contributing](https://img.shields.io/badge/贡献指南-guide-blue.svg)](./CONTRIBUTING.zh-CN.md)
[![Security](https://img.shields.io/badge/安全策略-policy-red.svg)](./SECURITY.md)

零依赖、单遍扫描、可插拔语义的富文本 DSL 解析器。
只负责把文本解析成 token 树；标签语义、渲染方式和 UI 集成全部由你定义。

不是 Markdown 渲染器，不是富文本组件库，不产出 HTML。
它解析自定义标记语言为 token 树，其余全是你的事——
不过 [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker) 可以帮你接管"其余"的部分。

- 无正则回溯——确定性线性扫描
- inline / raw / block 三种标签形式
- 完全可配置的语法符号和标签名规则

## 生态

| 包                                                                                  | 角色                            |
|------------------------------------------------------------------------------------|-------------------------------|
| **`yume-dsl-rich-text`**                                                           | 解析器核心 — 文本到 token 树（本包）       |
| [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)       | 解释器 — token 树到输出节点            |
| [`yume-dsl-shiki-highlight`](https://github.com/chiba233/yume-dsl-shiki-highlight) | 语法高亮 — 彩色 token 或 TextMate 语法 |

**推荐组合方式：**

- **只需把 DSL 解析成 token** → `yume-dsl-rich-text`
- **把 token 树解释为任意输出节点** → 再配合 `yume-dsl-token-walker`
- **源码级高亮或 TextMate 语法支持** → 再配合 `yume-dsl-shiki-highlight`

---

## 目录

- [设计理念](#设计理念)
- [安装](#安装)
- [快速开始](#快速开始)
- [DSL 语法](#dsl-语法)
    - [Inline 标签](#inline-标签)
    - [Raw 标签](#raw-标签)
    - [Block 标签](#block-标签)
    - [管道参数](#管道参数)
    - [转义序列](#转义序列)
- [API](#api)
    - [createParser](#createparserdefaults--推荐入口)
    - [parseRichText / stripRichText](#parserichtext--striprichtext)
    - [parseStructural](#parsestructural--结构化解析)
- [自定义语法](#自定义语法)
    - [默认语法](#默认语法)
    - [createEasySyntax](#createeasysyntax推荐)
    - [createSyntax](#createsyntax底层)
- [自定义标签名字符规则](#自定义标签名字符规则)
- [处理器辅助函数](#处理器辅助函数)
    - [createPipeHandlers](#createpipehandlersdefinitions)
    - [createSimpleInlineHandlers / createSimpleBlockHandlers / createSimpleRawHandlers](#createsimpleinlinehandlersnames--createsimpleblockhandlersnames--createsimplerawhandlersnames)
    - [declareMultilineTags](#declaremultilinetagsnames)
- [ParseOptions](#parseoptions)
- [Token 结构](#token-结构)
    - [强类型](#强类型)
- [编写标签处理器（进阶）](#编写标签处理器进阶)
- [导出一览](#导出一览)
    - [DslContext](#dslcontext)
    - [PipeArgs / parsePipeTextList](#pipeargs--parsepipetextlist)
- [源码位置追踪](#源码位置追踪)
- [错误处理](#错误处理)
- [优雅降级](#优雅降级)
- [Vue 3 渲染](#vue-3-渲染)
- [待弃用 API](#待弃用-api)
- [更新日志](#更新日志)
- [许可证](#许可证)

---

## 设计理念

- **无内置标签。** 每个标签的含义由你注册的处理器定义。
- **处理器就是语义层。** 处理器接收解析后的 token，返回 `TokenDraft`——输出结构、附加字段、行为全部由你决定。
- **渲染不是我们的工作。** 解析器产出 token 树；如何渲染（React、Vue、纯 HTML、终端）完全由你负责。
- **优雅降级。** 未知或不支持的标签永远不会抛出异常——静默降级。
- **一切可配置。** 语法符号、标签名规则、嵌套深度——需要覆盖什么就覆盖什么，其余保持默认。

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
    {type: "text", value: "Hello ", id: "rt-0"},
    {
        type: "bold",
        value: [{type: "text", value: "world", id: "rt-1"}],
        id: "rt-2",
    },
    {type: "text", value: "!", id: "rt-3"},
]
```

### 3. 提取纯文本

```ts
const plain = dsl.strip("Hello $$bold(world)$$!");
// "Hello world!"
```

适用于提取可搜索的纯文本、生成摘要或构建无障碍标签。

未注册的标签会优雅降级，而不是抛出异常。

### 推荐阅读顺序

第一次使用建议按以下顺序阅读：

1. **快速开始**（你在这里）
2. [DSL 语法](#dsl-语法) — 三种标签形式
3. [createParser](#createparserdefaults--推荐入口) — 主入口
4. [处理器辅助函数](#处理器辅助函数) — 批量注册标签，减少模板代码
5. [编写标签处理器（进阶）](#编写标签处理器进阶) — 自定义处理器逻辑
6. [parseStructural](#parsestructural--结构化解析) — 用于结构消费场景（高亮、lint、编辑器、源码检查）

---

## DSL 语法

默认使用 `$$` 作为标签前缀。所有语法符号（前缀、分隔符、转义字符、block/raw
标记）均可完全自定义——参见[自定义语法](#自定义语法)。
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

`createParser` 将你的 `ParseOptions`（handlers、syntax、tagName、depthLimit、onError、trackPositions）绑定为一个可复用实例。
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

// 到处使用 — handlers 已经绑定
dsl.parse("Hello $$bold(world)$$!");
dsl.strip("Hello $$bold(world)$$!");

// 单次覆盖会浅合并到默认值上
dsl.parse(text, {onError: (e) => console.warn(e)});
```

**`createParser` 绑定了什么：**

大多数场景下，`createParser` 主要是为了绑定 `handlers`；其余选项只是顺手一起固化到实例上。

| 选项               | 预绑定后的效果                          |
|------------------|----------------------------------|
| **`handlers`**   | **标签定义 — 使用 `createParser` 的主要理由** |
| `syntax`         | 自定义语法符号（如覆盖 `$$` 前缀等）            |
| `tagName`        | 自定义标签名字符规则                       |
| `allowForms`     | 限制接受的标签形式（默认：全部启用）               |
| `depthLimit`     | 嵌套深度限制 — 很少需要逐次修改                |
| `createId`       | 自定义 token id 生成器（仍可按次覆盖）         |
| `blockTags`      | 需要 block 换行归一化的标签                |
| `onError`        | 默认错误处理器（仍可按次覆盖）                  |
| `trackPositions` | 为所有输出节点附加源码位置（仍可按次覆盖）            |

**不用 `createParser` 的话**，每次调用都需要传入完整选项：

```ts
// 重复 — 必须到处传 handlers
parseRichText(text1, {handlers});
parseRichText(text2, {handlers});
stripRichText(text3, {handlers});
parseStructural(text4, {handlers});

// 用 createParser — 绑定一次，到处使用
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

`structural` 共享 `defaults` 中的 `handlers`、`allowForms`、`syntax`、`tagName`、`depthLimit`、`trackPositions`——
语义专属选项（`blockTags`、`onError`、`createId`）被自然排除，因为 `StructuralParseOptions` 不继承它们。

### `parseRichText` / `stripRichText`

底层无状态函数。适用于一次性调用或需要完全控制每次调用参数的场景。

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];

function stripRichText(text: string, options?: ParseOptions): string;
```

`ParseOptions` 包含 `handlers`、`allowForms`、`syntax`、`tagName`、`depthLimit`、`createId`、`blockTags`、
`onError`、`trackPositions`。详见 [ParseOptions](#parseoptions)。

应用层通常优先使用 `createParser`；只有工具函数式的一次性调用才适合直接用 `parseRichText()`。

### `parseStructural` — 结构化解析

`parseStructural` 用于**结构消费场景**——高亮、lint、编辑器、源码检查，或任何需要知道*使用了哪种标签形态*而不只是语义结果的场景。
在输出树中保留标签形态（inline / raw / block）。

它与 `parseRichText` 共享同一套语言配置（`handlers`、`allowForms`、`syntax`、`tagName`、`depthLimit`、
`trackPositions`），因此你不需要维护两套不同的 DSL 规则。

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

`StructuralParseOptions` 继承自 `ParserBaseOptions`——与 `ParseOptions` 共享同一基类：

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
    mode?,             // 已弃用
    onError?,          // 语义专属
    trackPositions?    // 与 StructuralParseOptions 共享
}

interface StructuralParseOptions extends ParserBaseOptions {
    trackPositions?: boolean;
}
```

| 参数                       | 类型                           | 说明                                                            |
|--------------------------|------------------------------|---------------------------------------------------------------|
| `text`                   | `string`                     | DSL 源码                                                        |
| `options.handlers`       | `Record<string, TagHandler>` | 标签识别与形态门控（规则与 `parseRichText` 完全一致）。省略则接受所有语法合法的标签和形态，不做语义门控。 |
| `options.allowForms`     | `readonly TagForm[]`         | 限制接受的形态（需搭配 `handlers`）                                       |
| `options.depthLimit`     | `number`                     | 最大嵌套深度（默认 `50`）                                               |
| `options.syntax`         | `Partial<SyntaxInput>`       | 覆盖语法 token                                                    |
| `options.tagName`        | `Partial<TagNameConfig>`     | 覆盖标签名字符规则                                                     |
| `options.trackPositions` | `boolean`                    | 为每个节点附加 `position`（默认 `false`）                                |

传入 `handlers` 时，标签识别和形态门控与 `parseRichText` **完全一致**——使用相同的 `supportsInlineForm` 决策表和
`filterHandlersByForms` 逻辑（共享代码，非镜像）。handler 函数本身不会被调用，只有 `inline` / `raw` / `block` 方法的存在性影响门控。

省略 `handlers` 时，所有合法标签和所有形态均被接受。

**Ambient 捕获：** 未传 `syntax` / `tagName` 覆盖时，`parseStructural` 在入口处一次性捕获当前
`getSyntax()` / `getTagNameConfig()` 的值，并在解析过程中显式透传。因此可以在 `withSyntax` /
`withTagNameConfig` 包裹中使用：

```ts
withSyntax(customSyntax, () => {
    parseStructural(text);  // 入口捕获 customSyntax
    parseStructural(text2); // 同样在入口捕获 customSyntax
});
```

**`StructuralNode` 变体：**

| 类型          | 字段                               | 说明                   |
|-------------|----------------------------------|----------------------|
| `text`      | `value: string`                  | 纯文本                  |
| `escape`    | `raw: string`                    | 转义序列（如 `\)`）         |
| `separator` | —                                | 管道符 `\|` 分隔（仅参数区）    |
| `inline`    | `tag`, `children`                | `$$tag(…)$$`         |
| `raw`       | `tag`, `args`, `content: string` | `$$tag(…)% … %end$$` |
| `block`     | `tag`, `args`, `children`        | `$$tag(…)* … *end$$` |

启用 `trackPositions` 时，所有变体均携带可选的 `position?: SourceSpan`。

与 `parseRichText` 的差异（特性，非缺陷）：

|          | `parseRichText`                                  | `parseStructural`                                    |
|----------|--------------------------------------------------|------------------------------------------------------|
| 标签识别     | 共享（`ParserBaseOptions`）                          | 共享（`ParserBaseOptions`）                              |
| 形态门控     | 共享                                               | 共享                                                   |
| 换行归一化    | 始终裁剪（render 模式）                                  | 始终保留                                                 |
| 管道符 `\|` | 文本的一部分                                           | 参数区产出 `separator`；正文中为纯文本                            |
| 错误上报     | `onError` 回调                                     | 静默降级                                                 |
| 转义处理     | 根级反转义                                            | 结构化 `escape` 节点                                      |
| 位置追踪     | `trackPositions` → `TextToken.position`（归一化后的偏移） | `trackPositions` → `StructuralNode.position`（原始语法偏移） |
| 输出类型     | `TextToken[]`                                    | `StructuralNode[]`                                   |

**怎么选？** 目标是*渲染内容*，用 `parseRichText`；目标是*分析源码结构*，用 `parseStructural`。

---

## 自定义语法

所有语法符号——前缀、开闭分隔符、管道分隔符、转义字符、block/raw 标记——均可通过 `options.syntax` 覆盖。
这让你可以将 DSL 适配到任何宿主标记语言而不产生冲突。

```ts
import {createEasySyntax, parseRichText} from "yume-dsl-rich-text";

const syntax = createEasySyntax({tagPrefix: "@@"});
// endTag, rawClose, blockClose 自动推导：")@@", "%end@@", "*end@@"

const tokens = parseRichText("@@bold(hello)@@", {
    syntax,
    handlers: {
        bold: {
            inline: (tokens, _ctx) => ({type: "bold", value: tokens}),
        },
    },
});
```

### 默认语法

默认符号及其在语法中的位置：

```text
Inline:   $$tag(content)$$
               ↑       ↑
          tagOpen(  endTag)$$

嵌套括号： $$tag(fn(x) text)$$
                  ↑ ↑
          tagOpen(  tagClose)   ← 深度追踪保持内层括号平衡

带参数：   $$tag(arg | content)$$
                    ↑
               tagDivider |

Raw:      $$tag(arg)%
                   ↑  raw 内容（不递归解析）
              rawOpen)%
          %end$$
          ↑
          rawClose

Block:    $$tag(arg)*
                   ↑  block 内容（递归解析）
             blockOpen)*
          *end$$
          ↑
          blockClose

转义：     \)  \\  \|
          ↑
          escapeChar \
```

```ts
import {DEFAULT_SYNTAX} from "yume-dsl-rich-text";
// DEFAULT_SYNTAX.tagPrefix   === "$$"        // 标签起始标记
// DEFAULT_SYNTAX.tagOpen     === "("         // 打开标签参数/内容
// DEFAULT_SYNTAX.tagClose    === ")"         // 与 tagOpen 配对，用于参数区嵌套括号深度匹配
// DEFAULT_SYNTAX.tagDivider  === "|"         // 在 (…) 内分隔参数
// DEFAULT_SYNTAX.endTag      === ")$$"       // 关闭 inline 标签
// DEFAULT_SYNTAX.rawOpen     === ")%"        // 从参数切换到 raw 内容
// DEFAULT_SYNTAX.blockOpen   === ")*"        // 从参数切换到 block 内容
// DEFAULT_SYNTAX.rawClose    === "%end$$"    // 关闭 raw 标签（必须独占一行）
// DEFAULT_SYNTAX.blockClose  === "*end$$"    // 关闭 block 标签（必须独占一行）
// DEFAULT_SYNTAX.escapeChar  === "\\"        // 将下一个语法符号按字面量转义
```

> 注意：
> 语法符号之间必须保持可区分。
> 如果两个符号配置为相同的字符串，行为未定义。

**符号联动关系** — `createSyntax` 只做纯 shallow merge，无自动推导。
解析器内部存在硬耦合——破坏它们标签就会失效：

| 符号           | 约束                                        | 原因                                                                    |
|--------------|-------------------------------------------|-----------------------------------------------------------------------|
| `tagClose`   | **`endTag`、`rawOpen`、`blockOpen` 必须以它开头** | `getTagCloserType` 从 `findTagArgClose` 停止的位置匹配这三个符号——该位置指向 `tagClose` |
| `tagOpen`    | 必须与 `tagClose` 配对                         | `findTagArgClose` 用 `tagOpen`/`tagClose` 做嵌套深度配对                      |
| `endTag`     | 必须以 `tagClose` 开头                         | 见 `tagClose`                                                          |
| `rawOpen`    | 必须以 `tagClose` 开头                         | 见 `tagClose`                                                          |
| `blockOpen`  | 必须以 `tagClose` 开头                         | 见 `tagClose`                                                          |
| `tagPrefix`  | —                                         | 独立                                                                    |
| `rawClose`   | —                                         | 独立（整行匹配）                                                              |
| `blockClose` | —                                         | 独立（整行匹配）                                                              |
| `tagDivider` | —                                         | 独立                                                                    |
| `escapeChar` | —                                         | 独立                                                                    |

### createEasySyntax（推荐）

```ts
function createEasySyntax(overrides?: Partial<SyntaxInput>): SyntaxConfig
```

改基础 token，复合 token 自动保持一致。
接受 `SyntaxInput` 的任意子集——基础 token 驱动推导，显式传入的复合 token 优先。

| 基础 token（你设置）                                              | 复合 token（自动推导）                                         |
|------------------------------------------------------------|--------------------------------------------------------|
| `tagPrefix`、`tagOpen`、`tagClose`、`tagDivider`、`escapeChar` | `endTag`、`rawOpen`、`blockOpen`、`rawClose`、`blockClose` |

推导规则：

```text
endTag     = tagClose + tagPrefix       ")" + "$$"     → ")$$"
rawOpen    = tagClose + "%"             ")" + "%"      → ")%"
blockOpen  = tagClose + "*"             ")" + "*"      → ")*"
rawClose   = "%" + "end" + tagPrefix    "%end" + "$$"  → "%end$$"
blockClose = "*" + "end" + tagPrefix    "*end" + "$$"  → "*end$$"
```

```ts
import {createEasySyntax} from "yume-dsl-rich-text";

// 改前缀——复合符号跟随变化
createEasySyntax({tagPrefix: "@@"});
// endTag → ")@@"   rawClose → "%end@@"   blockClose → "*end@@"

// 改前缀 + 闭合符——复合符号同时适配
createEasySyntax({tagPrefix: "@@", tagClose: "]"});
// endTag → "]@@"   rawOpen → "]%"   blockOpen → "]*"
```

当开闭协议本身不规则时（如 `rawOpen: "<raw>"` 或 raw/block 使用不同的关闭关键字），推导帮不上忙——改用
[`createSyntax`](#createsyntax底层)。

### createSyntax（底层）

`createSyntax` 不是 `createEasySyntax` 的增强版——它只是一个不做联动校验和推导的裸构建器。
仅当你需要完全手动控制每个符号时使用。

```ts
import {createSyntax} from "yume-dsl-rich-text";

const syntax = createSyntax({tagPrefix: "@@", endTag: ")@@"});
// 必须自己更新 endTag、rawClose、blockClose——不会自动推导
```

```ts
interface SyntaxConfig extends SyntaxInput {
    escapableTokens: string[];  // 预计算，按长度降序排列
}
```

> 注意：
> 内部解析管线通过显式参数传递 parser 状态。`parseRichText` 保留模块级 ambient 包裹（`withSyntax` / `withCreateId`）
> 仅用于 handler 工具函数调用的向后兼容。对普通同步调用是安全的；如果多个并发异步请求共享同一个模块实例，
> 需要自行做好隔离——或者显式传 `DslContext` 以消除 ambient 依赖。

---

## 自定义标签名字符规则

```ts
function createTagNameConfig(overrides?: Partial<TagNameConfig>): TagNameConfig
```

控制解析器接受哪些标签名字符。只需提供要修改的函数，其余回退到 `DEFAULT_TAG_NAME`。

| 函数               | 默认值                       | 作用   | 匹配示例                  |
|------------------|---------------------------|------|-----------------------|
| `isTagStartChar` | `a-z`、`A-Z`、`_`           | 首字符  | `$$bold(` — `b`       |
| `isTagChar`      | `a-z`、`A-Z`、`0-9`、`_`、`-` | 后续字符 | `$$my-tag(` — `y-tag` |

默认情况下 `$$ui:button(...)$$` 会失败，因为 `:` 不在 `isTagChar` 中。允许它：

```ts
import {createParser, createTagNameConfig} from "yume-dsl-rich-text";

const dsl = createParser({
    handlers: {
        "ui:button": {inline: (value, _ctx) => ({type: "ui:button", value})},
    },
    // 只覆盖 isTagChar——isTagStartChar 保持默认。
    // 保留默认可用字符，并额外允许 ":" 出现在首字符之后。
    tagName: createTagNameConfig({
        isTagChar: (char) => /[A-Za-z0-9_-]/.test(char) || char === ":",
    }),
});

dsl.parse("$$ui:button(hello)$$");  // 正常工作
```

也可以直接传 partial 对象给 `tagName`——`createTagNameConfig` 不是必须的：

```ts
parseRichText("$$1tag(hello)$$", {
    handlers: {"1tag": {inline: (v, _ctx) => ({type: "1tag", value: v})}},
    tagName: {
        isTagStartChar: (char) => /[A-Za-z0-9_]/.test(char),  // 允许数字开头
        isTagChar: (char) => /[A-Za-z0-9_-]/.test(char) || char === ":",  // 保留默认字符，并额外允许 ":"
    },
});
```

---

## 处理器辅助函数

辅助函数让你批量注册标签处理器，无需重复编写样板代码。

### `createPipeHandlers(definitions)`

**推荐的处理器辅助函数**，适用于需要管道参数、多形态、或任何超出简单包装的自定义逻辑的标签。
在一个定义对象中支持 `inline`、`raw`、`block` 的任意组合。

每个 handler 接收预解析的 `PipeArgs` — 无需手动调 `parsePipeArgs` / `parsePipeTextArgs`。
`raw` 和 `block` handler 还额外接收原始 `rawArg` 字符串，以便需要未解析值的场景。

```ts
import {createParser, createPipeHandlers, createSimpleInlineHandlers} from "yume-dsl-rich-text";

const dsl = createParser({
    handlers: {
        // 简单标签 — 用 createSimpleInlineHandlers
        ...createSimpleInlineHandlers(["bold", "italic", "underline"]),

        // 带管道参数或多形态的标签 — 用 createPipeHandlers
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

**何时用哪个 helper：**

| 场景                            | 使用                           |
|-------------------------------|------------------------------|
| 简单 inline（bold、italic 等）      | `createSimpleInlineHandlers` |
| 简单 block（info、warning 等）      | `createSimpleBlockHandlers`  |
| 简单 raw（code、math 等）           | `createSimpleRawHandlers`    |
| 管道参数（`$$link(url \| text)$$`） | `createPipeHandlers`         |
| 多形态（inline + block + raw）     | `createPipeHandlers`         |
| raw/block 标签带结构化参数            | `createPipeHandlers`         |

### `createSimpleInlineHandlers(names)` / `createSimpleBlockHandlers(names)` / `createSimpleRawHandlers(names)`

批量注册不需要管道参数或自定义逻辑的标签。每种形态产出最小 token：

| Helper                       | Token 结构                                         |
|------------------------------|--------------------------------------------------|
| `createSimpleInlineHandlers` | `{ type: tagName, value: materializedTokens }`   |
| `createSimpleBlockHandlers`  | `{ type: tagName, arg, value: content }`         |
| `createSimpleRawHandlers`    | `{ type: tagName, arg, value: content }`（string） |

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

> **已弃用。** 详见[待弃用 API](#待弃用-api)。

### `declareMultilineTags(names)`

声明哪些已注册的标签是多行类型。返回 `BlockTagInput[]`，传入 `ParseOptions.blockTags`。

该函数**不**注册标签或创建处理器 — 它只告诉解析器哪些标签需要换行符修剪（剥离 `)*` / `)%` 开启符后的前导 `\n`，以及
`*end$$` / `%end$$` 关闭符前的尾随 `\n`）。

每个条目可以是纯标签名（raw 和 block 形式均执行修剪 — 向后兼容），也可以是带 `forms` 数组的对象，将修剪限定到特定的多行形式。

```ts
import {createParser, createSimpleInlineHandlers, declareMultilineTags} from "yume-dsl-rich-text";

// 基础用法 — 所有多行形式均修剪（向后兼容）
const dsl = createParser({
    handlers: {
        ...createSimpleInlineHandlers(["bold", "italic"]),
        info: { /* 自定义处理器，单独注册 */},
        warning: { /* 自定义处理器，单独注册 */},
    },
    blockTags: declareMultilineTags(["info", "warning"]),
});

// 细粒度 — 将修剪限定到特定形式
const dsl2 = createParser({
    handlers: { /* ... */},
    blockTags: declareMultilineTags([
        "info",                              // raw 和 block 均修剪
        {tag: "code", forms: ["raw"]},     // 仅 raw 形式修剪
        {tag: "note", forms: ["block"]},   // 仅 block 形式修剪
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

### `createPassthroughTags(names)`

> **已弃用。** 详见[待弃用 API](#待弃用-api)。

---

## ParseOptions

`ParseOptions` 和 `StructuralParseOptions` 均继承自 `ParserBaseOptions`：

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
    mode?: "render";    // 已弃用
    onError?: (error: ParseError) => void;
    trackPositions?: boolean;
}

interface StructuralParseOptions extends ParserBaseOptions {
    trackPositions?: boolean;
}
```

### 共享字段（`ParserBaseOptions`）

- `handlers`：标签名 → 处理器定义
- `allowForms`：限制解析器接受的标签形式（默认：全部启用）
- `depthLimit`：最大嵌套深度，默认 `50`
- `syntax`：覆盖默认语法符号
- `tagName`：覆盖标签名字符规则
- `baseOffset`：启用 `trackPositions` 时，将所有 `offset` 偏移此量（默认 `0`）。
  详见[子串解析：baseOffset 与 tracker](#子串解析baseoffset-与-tracker)
- `tracker`：基于原始完整文档预构建的 `PositionTracker`，同时保证 `line`/`column` 正确。
  详见[子串解析：baseOffset 与 tracker](#子串解析baseoffset-与-tracker)

### `ParseOptions` 专属字段

- `createId`：覆盖本次解析的 token id 生成策略
- `blockTags`：需要 block 换行规范化的标签 — 接受纯字符串或 `{ tag, forms }` 对象以按形式控制
- `mode`：已弃用——详见[待弃用 API](#待弃用-api)
- `onError`：解析错误回调
- `trackPositions`：为每个 `TextToken` 附加源码位置信息 `position`（默认 `false`）。详见[源码位置追踪](#源码位置追踪)

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
    position?: SourceSpan;

    [key: string]: unknown;
}
```

`TextToken` 是解析器的输出类型。`type` 和 `value` 字段使用宽松类型（`string`），以便解析器可以在不了解你的 schema
的情况下表示任意标签。

可选的 `position` 字段在启用 [`trackPositions`](#源码位置追踪) 时出现，记录产出该 token 的源码范围（偏移量、行号、列号）。

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
import {parseRichText, type TextToken} from "yume-dsl-rich-text";

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

## 编写标签处理器（进阶）

大多数标签用 [`createPipeHandlers`](#createpipehandlersdefinitions) 或
[`createSimple*` 辅助函数](#处理器辅助函数)就够了。只有当辅助函数无法表达你的逻辑时——
例如条件字段映射、内容转换、动态类型选择——才需要手写 `TagHandler`。

### TagHandler 接口

```ts
interface TagHandler {
    inline?: (tokens: TextToken[], ctx?: DslContext) => TokenDraft;
    raw?: (arg: string | undefined, content: string, ctx?: DslContext) => TokenDraft;
    block?: (arg: string | undefined, content: TextToken[], ctx?: DslContext) => TokenDraft;
}
```

只实现标签支持的形式即可，不支持的形式会优雅降级。
调用 `parsePipeArgs`、`materializeTextTokens` 等工具函数时透传 `ctx`。

### 示例

```ts
const dsl = createParser({
    handlers: {
        // 大多数标签 — 用辅助函数
        ...createSimpleInlineHandlers(["bold", "italic"]),

        // 手写处理器：只在需要自定义逻辑时
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

---

## 导出一览

### 核心

| 导出                | 签名                                                                     | 说明                  |
|-------------------|------------------------------------------------------------------------|---------------------|
| `parseRichText`   | `(text: string, options?: ParseOptions) => TextToken[]`                | 将 DSL 文本解析为 token 树 |
| `stripRichText`   | `(text: string, options?: ParseOptions) => string`                     | 解析后展平为纯文本           |
| `createParser`    | `(defaults: ParseOptions) => Parser`                                   | 创建预填选项的可复用解析器       |
| `parseStructural` | `(text: string, options?: StructuralParseOptions) => StructuralNode[]` | 解析为保留标签形态的结构树       |

### 配置

详见[自定义语法](#自定义语法)和[自定义标签名字符规则](#自定义标签名字符规则)。

| 导出                    | 签名                                                      | 说明                            |
|-----------------------|---------------------------------------------------------|-------------------------------|
| `DEFAULT_SYNTAX`      | `SyntaxInput`                                           | 内置语法符号（`$$`、`(`、`)$$` 等）      |
| `createEasySyntax`    | `(overrides?: Partial<SyntaxInput>) => SyntaxConfig`    | 自动推导构建 `SyntaxConfig`（推荐）     |
| `createSyntax`        | `(overrides?: Partial<SyntaxInput>) => SyntaxConfig`    | 纯 merge 构建 `SyntaxConfig`（底层） |
| `DEFAULT_TAG_NAME`    | `TagNameConfig`                                         | 内置标签名字符规则                     |
| `createTagNameConfig` | `(overrides?: Partial<TagNameConfig>) => TagNameConfig` | 从部分覆盖构建完整 `TagNameConfig`     |

### 处理器辅助函数

批量创建处理器的便利函数 — 大多数项目只需要这些。

| 导出                           | 签名                                                                                   | 说明                                               |
|------------------------------|--------------------------------------------------------------------------------------|--------------------------------------------------|
| `createPipeHandlers`         | `(definitions: Record<string, PipeHandlerDefinition>) => Record<string, TagHandler>` | pipe-aware handler builder，inline/raw/block 任意组合 |
| `createSimpleInlineHandlers` | `(names: readonly string[]) => Record<string, TagHandler>`                           | 批量创建简单标签的 inline 处理器                             |
| `createSimpleBlockHandlers`  | `(names: readonly string[]) => Record<string, TagHandler>`                           | 批量创建简单标签的 block 处理器                              |
| `createSimpleRawHandlers`    | `(names: readonly string[]) => Record<string, TagHandler>`                           | 批量创建简单标签的 raw 处理器                                |
| `declareMultilineTags`       | `(names: readonly BlockTagInput[]) => BlockTagInput[]`                               | 声明哪些标签需要多行换行符修剪                                  |

另见[待弃用 API](#待弃用-api)：`createPipeBlockHandlers`、`createPipeRawHandlers`、`createPassthroughTags`。

### 处理器工具函数

编写自定义 `TagHandler` 时使用的底层工具。
如果你只使用上面的辅助函数，则不需要这些。

`ctx?` 参数为向后兼容而保留可选。新代码应将其视为实际必填——传入 handler 回调收到的 `DslContext`，
或自行构造一个。详见下方 [DslContext](#dslcontext)。

| 导出                      | 签名                                                                                        | 说明                                         |
|-------------------------|-------------------------------------------------------------------------------------------|--------------------------------------------|
| `parsePipeArgs`         | `(tokens: TextToken[], ctx?: DslContext) => PipeArgs`                                     | 按管道分割 token 并访问解析后的部分                      |
| `parsePipeTextArgs`     | `(text: string, ctx?: DslContext) => PipeArgs`                                            | 同上，但输入为纯文本字符串                              |
| `parsePipeTextList`     | `(text: string, ctx?: DslContext) => string[]`                                            | 将管道分隔字符串直接拆分为 trim 后的 `string[]`           |
| `splitTokensByPipe`     | `(tokens: TextToken[], ctx?: DslContext) => TextToken[][]`                                | 按 pipe 分割 token 的底层工具，不含辅助方法               |
| `extractText`           | `(tokens?: TextToken[]) => string`                                                        | 将 token 树展平为单个字符串                          |
| `materializeTextTokens` | `(tokens: TextToken[], ctx?: DslContext) => TextToken[]`                                  | 递归反转义 token 树中的文本 token                    |
| `unescapeInline`        | `(str: string, ctx?: DslContext \| SyntaxConfig) => string`                               | 反转义单个字符串中的 DSL 转义序列 \*                     |
| `readEscapedSequence`   | `(text: string, i: number, ctx?: DslContext \| SyntaxConfig) => [string \| null, number]` | 读取位置 `i` 处的一个转义序列 \*                       |
| `createTextToken`       | `(value: string, ctx?: DslContext) => TextToken`                                          | 创建带 `id` 的 `{ type: "text", value }` token |
| `createToken`           | `(draft: TokenDraft, position?: SourceSpan, ctx?: DslContext \| CreateId) => TextToken`   | 为 `TokenDraft` 添加 `id`（和可选的 `position`） \* |

> \* `unescapeInline` 和 `readEscapedSequence` 也接受裸 `SyntaxConfig`；`createToken` 也接受裸 `CreateId`。
> 这些较窄的重载为内部和遗留用法保留。**新代码应传 `DslContext`** — 未来 major 版本会将宽类型收窄为仅 `DslContext`。

### 位置追踪

单遍解析内置位置追踪，关闭时零开销。
传 `trackPositions: true` 即可为每个输出节点附加 `position`（包含 `offset` / `line` / `column` 的源码范围）。
解析子串时，`baseOffset` + `tracker` 可将位置映射回原始文档。
完整文档、类型定义和示例见[源码位置追踪](#源码位置追踪)。

| 导出                     | 签名                                  | 说明                      |
|------------------------|-------------------------------------|-------------------------|
| `buildPositionTracker` | `(text: string) => PositionTracker` | 构建可复用的行偏移表，用于将偏移量解析为行列号 |

相关 `ParseOptions` / `StructuralParseOptions` 字段：

| 选项               | 类型                | 说明                                            |
|------------------|-------------------|-----------------------------------------------|
| `trackPositions` | `boolean`         | 启用位置追踪（默认 `false`）                            |
| `baseOffset`     | `number`          | 子串解析时偏移所有 offset                              |
| `tracker`        | `PositionTracker` | 基于原始完整文档预构建的 tracker，用于正确解析 `line` / `column` |

> **注意：** 完整导出列表包含上方未列出的已弃用 API。
> 详见[待弃用 API](#待弃用-api)：`withSyntax`、`getSyntax`、`withTagNameConfig`、
> `resetTokenIdSeed`、`createPipeBlockHandlers`、`createPipeRawHandlers`、`createPassthroughTags`。

### DslContext

`DslContext` 携带当前 parse 会话的 syntax 和 token id 生成器。
所有公开工具函数都通过可选的 `ctx` 参数接收它——**透传即可**保持全链路配置一致。
`ctx` 在未来 major 版本中会变为必填。

```ts
interface DslContext {
    syntax: SyntaxConfig;
    createId?: CreateId;
}
```

| 字段         | 说明                                            |
|------------|-----------------------------------------------|
| `syntax`   | 当前 `SyntaxConfig` — 控制转义字符、分隔符等               |
| `createId` | 可选的 token id 生成器 — `createToken` 构建 token 时使用 |

```ts
// handler 内：透传解析器传进来的 ctx
link: {
    inline: (tokens, ctx) => {
        const args = parsePipeArgs(tokens, ctx);
        return {type: "link", url: args.text(0), value: args.materializedTailTokens(1)};
    },
}

// 解析器外：手动构造
const ctx: DslContext = {syntax: createSyntax(), createId: (draft) => `demo-${draft.type}`};
const args = parsePipeTextArgs("ts | Demo", ctx);
const token = createTextToken("hello", ctx);
```

### 迁移到显式 `ctx`

影响的是 handler → utility 调用链，不涉及核心解析 API：

`TagHandler` · `parsePipeArgs` · `parsePipeTextArgs` · `parsePipeTextList` · `splitTokensByPipe` ·
`materializeTextTokens` · `unescapeInline` · `readEscapedSequence` · `createToken`

1. 给自定义 `TagHandler` 签名加上 `ctx`。
2. handler 内调用的 utility 全部透传同一个 `ctx`。
3. 独立脚本 / 测试中手动构造 `DslContext` 并传入。

### PipeArgs / parsePipeTextList

`parsePipeArgs` 和 `parsePipeTextArgs` 返回 `PipeArgs` 对象：

```ts
interface PipeArgs {
    parts: TextToken[][];
    has: (index: number) => boolean;
    text: (index: number, fallback?: string) => string;
    materializedTokens: (index: number, fallback?: TextToken[]) => TextToken[];
    materializedTailTokens: (startIndex: number, fallback?: TextToken[]) => TextToken[];
}
```

| 字段                                     | 说明                         |
|----------------------------------------|----------------------------|
| `parts`                                | 按 `\|` 分割的未处理的 token 数组    |
| `has(i)`                               | 第 `i` 部分是否存在               |
| `text(i, fallback?)`                   | 第 `i` 部分的纯文本，已反转义并去除首尾空格   |
| `materializedTokens(i, fallback?)`     | 第 `i` 部分已反转义的 token        |
| `materializedTailTokens(i, fallback?)` | 从索引 `i` 起所有部分合并成的 token 数组 |

如果只需要 `string[]` 而不需要 token 树，用 `parsePipeTextList` 代替：

```ts
parsePipeTextList("ts | Demo | Label");  // → ["ts", "Demo", "Label"]
```

---

## 源码位置追踪

传入 `trackPositions: true` 可为每个输出节点附加 `position`（源码范围）。默认关闭——关闭时不构建行表，不产生
`position` 字段。

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

`parseStructural` 同样支持：

```ts
import {parseStructural} from "yume-dsl-rich-text";

const nodes = parseStructural("$$bold(hi)$$", {trackPositions: true});
// nodes[0].position → { start: { offset: 0, ... }, end: { offset: 12, ... } }
```

### 类型

```ts
interface SourcePosition {
    offset: number;   // 0-indexed 字符串偏移（UTF-16 code unit）
    line: number;      // 1-indexed
    column: number;    // 1-indexed
}

interface SourceSpan {
    start: SourcePosition;
    end: SourcePosition;
}
```

### 子串解析：`baseOffset` 与 `tracker`

> **一句话** — `baseOffset` 负责把子串内位置映射回原始文本的绝对 offset；
> `tracker` 负责把这些绝对 offset 解析为原始文本中正确的 `line`/`column`。两个都传才全对。

解析从大文档中截取的子串时，传入 `baseOffset` 和预构建的 `tracker`，让 `offset`、`line`、`column` 全部指回原始文档：

```ts
import {parseRichText, buildPositionTracker} from "yume-dsl-rich-text";

const fullText = "第一行\nprefix $$bold(world)$$ suffix";
const tracker = buildPositionTracker(fullText);

const start = 11;  // "$$bold(world)$$" 在 fullText 中的起始偏移
const slice = fullText.slice(start, 26);

const tokens = parseRichText(slice, {
    handlers: {bold: {inline: (t) => ({type: "bold", value: t})}},
    trackPositions: true,
    baseOffset: start,
    tracker,           // ← 基于完整文档构建
});

// tokens[0].position.start.offset → 11  (绝对偏移，指向 fullText)
// tokens[0].position.start.line   → 2   (fullText 中的正确行号)
// tokens[0].position.start.column → 8   (fullText 中的正确列号)
```

| 选项           | 用途                                         |
|--------------|--------------------------------------------|
| `baseOffset` | 将所有 offset 偏移此量（默认 `0`）                    |
| `tracker`    | 基于完整文档预构建的 tracker，同时保证 `line`/`column` 正确 |

两个选项同时适用于 `parseRichText` 和 `parseStructural`，需要 `trackPositions: true` 才生效。

**只传 `baseOffset`**：`offset` 被正确偏移，但 `line`/`column` 基于子串本地计算。适合只需 offset 查找的场景。

**同时传 `tracker`**（推荐）：三个字段全部正确。用 `buildPositionTracker(fullText)` **构建一次**，后续所有切片复用。
不要对每个 slice 单独 build tracker——它每次都会从头扫描整个文本重建行表。

### `position` 覆盖范围

每个 token 的 `position` 都遵循对应解析器自己的输出语义。

- `parseRichText` 中，block/raw token 的 span 会包含因换行归一化而被消费的尾部换行。
- `parseStructural` 中，span 保持原始结构语法范围，因此会停在 `*end$$` / `%end$$` 处。

例如下面这段输入（27 个字符）：

```
$$info()*\nhello\n*end$$\nnext
0         1         2
012345678901234567890123456
```

| API               | `info` 的 `position.end.offset` | 覆盖范围                         |
|-------------------|--------------------------------|------------------------------|
| `parseRichText`   | **23**（越过 `$$` 后的 `\n`）        | `$$info()*\nhello\n*end$$\n` |
| `parseStructural` | **22**（停在 `$$`）                | `$$info()*\nhello\n*end$$`   |

`parseRichText` 会把尾部 `\n` 作为 block 换行归一化的一部分消费掉；
`parseStructural` 停在原始语法边界。offset 22 处的 `\n` 成为下一个文本节点的起始。

### `parseRichText` 与 `parseStructural` 的语义差异

| 方面          | `parseRichText`                            | `parseStructural`            |
|-------------|--------------------------------------------|------------------------------|
| block 子节点偏移 | 经前导换行归一化调整——内部 `position` 通过归一化后的内容映射回原始源码 | 原始语法位置——不做归一化调整，子节点从内容分隔符处开始 |

两个 API 使用相同的 `SourceSpan` 类型，但子节点位置反映各自的处理模型。如果在同一输入上对比两个 API 的子节点位置，
block 内容可能存在等于被裁剪的前导换行长度的偏移差（`\n` 为 1，`\r\n` 为 2）。

### 性能

`trackPositions` 为 `false`（默认）时：

- 不分配行偏移表
- 不产生 `position` 对象
- 剩余开销仅限于解析管线中少量 null 检查分支——实践中可忽略

启用时，入口处一次性构建行偏移表（O(n) 扫描），每次位置解析使用 O(log n) 二分查找。

性能应分层理解：`parseStructural` 是轻量的语法/结构扫描器，适合高吞吐场景；`parseRichText` 是语义解析器，
除状态机扫描外还包含 handler 执行、token 树构建与内容归一化，因此成本明显更高——这属于能力开销，而非扫描实现失效。

**基准吞吐**（~48 KB DSL 输入，单线程 microbenchmark）：

| API               | 单次耗时    |
|-------------------|---------|
| `parseRichText`   | ~360 ms |
| `stripRichText`   | ~358 ms |
| `parseStructural` | ~7.1 ms |

`stripRichText` 内部先调 `parseRichText` 再调 `extractText`，因此耗时基本相同。
`parseStructural` 跳过 handler、token 构建和 materialization——同一输入下约比 `parseRichText` 快 **50 倍**。

**`trackPositions` 开销**（同一输入）：

| API               | 关闭     | 开启     | 开销  |
|-------------------|--------|--------|-----|
| `parseRichText`   | 360 ms | 359 ms | ~0% |
| `stripRichText`   | 358 ms | 360 ms | ~0% |
| `parseStructural` | 7.1 ms | 7.6 ms | ~7% |

`parseRichText` / `stripRichText` 单 token 处理更重（handler 调用、递归、materialization），位置追踪的占比被稀释。
`parseStructural` 本身很轻，生成 `position` 对象和解析偏移的相对成本更明显——但仍非灾难级。

*测试环境：鲲鹏 920 24C / 32 GB（2x16 GB DDR4-2666）。本地 microbenchmark——量级可信，具体数字因平台而异。*

---

## 错误处理

使用 `onError` 收集解析错误。

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
    {type: "text", value: "Hello ", id: "rt-0"},
    {type: "bold", value: [{type: "text", value: "world", id: "rt-1"}], id: "rt-2"},
    {type: "text", value: " and goodbye", id: "rt-3"},
    //                      ↑ "italic" 未注册 — 内容变为纯文本
]
```

### 处理器不支持的形式 → 回退文本

处理器只需实现它支持的形式。如果标签以处理器不支持的形式使用，整个标记降级为纯文本。

```ts
const dsl = createParser({
    handlers: {
        // "note" 只支持 inline，不支持 raw
        note: {inline: (tokens, _ctx) => ({type: "note", value: tokens})},
    },
});

dsl.parse("$$note(ok)%\nraw content\n%end$$");
```

```ts
// raw 形式不受支持 → 整个标签降级为回退文本
[
    {type: "text", value: "$$note(ok)%\nraw content\n%end$$", id: "rt-0"},
]
```

### `allowForms` 限制 → 形式被剥离

当 `allowForms` 排除了某种形式时，解析器视为处理器不支持该形式 — 即使实际支持。

```ts
const dsl = createParser({
    handlers: {
        bold: {inline: (tokens, _ctx) => ({type: "bold", value: tokens})},
        code: {raw: (arg, content, _ctx) => ({type: "code", lang: arg ?? "text", value: content})},
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

dsl.parse("Hello $$bold(world", {onError: (e) => errors.push(e)});
// → [{ type: "text", value: "Hello $$bold(world", id: "rt-0" }]
//
// errors[0].code === "INLINE_NOT_CLOSED"
```

不提供 `onError` 时，同样的恢复行为静默发生 — 不会抛出任何异常。

---

## Vue 3 渲染

解析器输出 `TextToken[]` 树 — 下面是一个开箱即用的递归 Vue 3 组件，可直接渲染它。

### 1. 配置解析器

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

const collapseBase = titledHandler("collapse", "点击展开");

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

        info: titledHandler("info", "提示"),
        warning: titledHandler("warning", "警告"),

        collapse: {block: collapseBase.block, raw: collapseBase.raw},

        "raw-code": {
            raw: (arg, content, ctx): TokenDraft => {
                const args = parsePipeTextArgs(arg ?? "", ctx);
                return {
                    type: "raw-code",
                    codeLang: args.text(0),
                    title: args.text(1) || "代码：",
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

### 2. 创建递归渲染组件

```vue
<!-- RichTextRenderer.vue -->
<script lang="ts" setup>
  import type {TextToken} from "yume-dsl-rich-text";
  import {type Component, h} from "vue";

  defineOptions({name: "RichTextRenderer"});

  const props = defineProps<{
    tokens: TextToken[];
  }>();

  /* ── 标签 → 元素 / 组件映射 ── */
  type RenderTarget = string | Component;

  const tagMap: Record<string, RenderTarget> = {
    bold: "strong",
    thin: "span",
    underline: "span",
    strike: "s",
    center: "span",
    code: "code",
    link: "a",
    // 在这里添加你自己的组件映射，例如：
    // info:     NAlert,
    // collapse: CollapseWrapper,
  };

  /* ── 每个类型的 props ── */
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

  /* ── 每个类型的 CSS 类 ── */
  const getComponentClass = (token: TextToken) => [
    `rich-${token.type}`,
    {
      "rich-underline": token.type === "underline",
      "rich-strike": token.type === "strike",
      "rich-center": token.type === "center",
      "rich-code": token.type === "code",
    },
  ];

  /* ── URL 安全校验 ── */
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
    <!-- 纯文本 -->
    <span v-if="token.type === 'text'" v-text="token.value"/>

    <!-- raw-code：value 是字符串，不递归 -->
    <component
        v-else-if="token.type === 'raw-code'"
        :is="tagMap[token.type] ?? 'pre'"
        :class="getComponentClass(token)"
        v-bind="getComponentProps(token)"
    >{{ token.value }}
    </component>

    <!-- 其他：递归渲染子节点 -->
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

### 3. 使用

```vue

<script setup>
  import {dsl} from "./dsl";
  import RichTextRenderer from "./RichTextRenderer.vue";

  const tokens = dsl.parse(
      "你好 $$bold(世界)$$！访问 $$link(https://example.com|我的网站)$$。"
  );
</script>

<template>
  <RichTextRenderer :tokens="tokens"/>
</template>
```

### 扩展 UI 组件库

`tagMap` 是集成入口。将任意标签类型映射到 Vue 组件即可：

```ts
import {NAlert, NCollapse, NCollapseItem} from "naive-ui";
import CodeBlock from "./CodeBlock.vue";

const tagMap: Record<string, RenderTarget> = {
    bold: "strong",
    link: "a",
    info: NAlert,        // $$info(标题)* ... *end$$ 渲染为 <n-alert>
    warning: NAlert,
    "raw-code": CodeBlock,     // $$raw-code(ts)% ... %end$$ 渲染为你的代码块组件
    collapse: CollapseWrapper,
};
```

对于需要运行时逻辑的标签（如日期格式化），使用函数式组件：

```ts
import {type FunctionalComponent, h} from "vue";

const DateText: FunctionalComponent<{ date?: string }> = (props) =>
    h("span", formatDate(props.date));

tagMap.date = DateText;
```

---

## 待弃用 API

**核心解析 API 已趋于稳定。** 部分工具函数和 ambient-state API 处于迁移过渡期。
如有破坏性调整，会在 major 版本中明确说明。

以下导出将在未来 major 版本中移除。当前仍可正常使用，保留用于向后兼容。

Ambient-state API（`withSyntax`、`getSyntax`、`withTagNameConfig`、`withCreateId`、`resetTokenIdSeed`）被用户代码
调用时会发出一次性 `console.warn`。`parseRichText` 内部调用自动屏蔽，不产生告警噪音。`parseStructural` 仅在检测到
ambient 状态被 `withSyntax` / `withTagNameConfig` 改变时告警；没有 ambient 包裹的正常调用不会告警。

`NODE_ENV=production` 时告警被静默。

这些 API 在 **2026 年 9 月前不会被移除**。

| 导出                        | 签名                                                         | 替代方案                          | 告警 | 原因                                    |
|---------------------------|------------------------------------------------------------|-------------------------------|----|---------------------------------------|
| `withSyntax`              | `<T>(syntax: SyntaxConfig, fn: () => T) => T`              | `DslContext`                  | 是  | 模块级隐式状态；应显式传 `DslContext`             |
| `getSyntax`               | `() => SyntaxConfig`                                       | `DslContext`                  | 是  | 同上                                    |
| `withTagNameConfig`       | `<T>(config: TagNameConfig, fn: () => T) => T`             | 通过 `ParseOptions` 传 `tagName` | 是  | 同上                                    |
| `withCreateId`            | `<T>(createId: CreateId, fn: () => T) => T`                | `DslContext`                  | 是  | 同上                                    |
| `resetTokenIdSeed`        | `() => void`                                               | `DslContext.createId`         | 是  | 仅在依赖模块级 id 计数器时需要                     |
| `createPipeBlockHandlers` | `(names: readonly string[]) => Record<string, TagHandler>` | `createPipeHandlers`          | 否  | 冗余 helper；`createPipeHandlers` 覆盖全部场景 |
| `createPipeRawHandlers`   | `(names: readonly string[]) => Record<string, TagHandler>` | `createPipeHandlers`          | 否  | 同上                                    |
| `createPassthroughTags`   | `(names: readonly string[]) => Record<string, TagHandler>` | `createSimpleInlineHandlers`  | 否  | 隐式行为；显式 handler 更清晰                   |
| `ParseOptions.mode`       | `"render"`                                                 | *（移除）*                        | 否  | 只有一个值（`"render"`），不再有意义               |

---

## 更新日志

版本历史已拆分到独立文件：

- [更新日志](./CHANGELOG.zh-CN.md)

---

## 许可证

MIT
