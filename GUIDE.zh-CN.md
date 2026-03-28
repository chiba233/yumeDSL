[English](./README.md) | **中文**

# yume-dsl-rich-text (ユメテキスト)

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

- 无正则回溯——确定性线性扫描
- inline / raw / block 三种标签形式
- 完全可配置的语法符号和标签名规则

**核心 API 已趋于稳定。** 后续更新将以向后兼容为优先；如有必要的破坏性调整，会在 major 版本中明确说明。

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
    - [DslContext](#dslcontext)
    - [PipeArgs](#pipeargs)
- [源码位置追踪](#源码位置追踪)
- [错误处理](#错误处理)
- [优雅降级](#优雅降级)
- [Vue 3 渲染](#vue-3-渲染)
- [更新日志](https://github.com/chiba233/yumeDSL/blob/main/yume-dsl-rich-text/CHANGELOG.zh-CN.md)
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
5. [编写标签处理器](#编写标签处理器) — 自定义处理器逻辑
6. [parseStructural](#parsestructural--结构化解析) — 仅当你需要高亮 / lint / 结构分析时

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

`createParser` 将你的 `ParseOptions`（handlers、syntax、tagName、mode、depthLimit、onError、trackPositions）绑定为一个可复用实例。
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

| 选项               | 预绑定后的效果                        |
|------------------|--------------------------------|
| `handlers`       | 标签定义 — 不需要每次调用都传入              |
| `allowForms`     | 限制接受的标签形式（默认：全部启用）             |
| `syntax`         | 自定义语法符号（如覆盖 `$$` 前缀等）          |
| `tagName`        | 自定义标签名字符规则                     |
| `depthLimit`     | 嵌套深度限制 — 很少需要逐次修改              |
| `createId`       | 自定义 token id 生成器（仍可按次覆盖）       |
| `blockTags`      | 需要 block 换行归一化的标签              |
| `mode`           | 仅支持 `"render"`                    |
| `onError`        | 默认错误处理器（仍可按次覆盖）                |
| `trackPositions` | 为所有输出节点附加源码位置（仍可按次覆盖）          |

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
语义专属选项（`mode`、`blockTags`、`onError`、`createId`）被自然排除，因为 `StructuralParseOptions` 不继承它们。

### `parseRichText` / `stripRichText`

底层无状态函数。适用于一次性调用或需要完全控制每次调用参数的场景。

```ts
function parseRichText(text: string, options?: ParseOptions): TextToken[];

function stripRichText(text: string, options?: ParseOptions): string;
```

`ParseOptions` 包含 `handlers`、`allowForms`、`syntax`、`tagName`、`depthLimit`、`createId`、`blockTags`、`mode`、
`onError`、`trackPositions`。详见 [ParseOptions](#parseoptions)。

应用层通常优先使用 `createParser`；只有工具函数式的一次性调用才适合直接用 `parseRichText()`。

### `parseStructural` — 结构化解析

`parseStructural` 用于**语法高亮、lint 和结构分析**——任何需要知道*使用了哪种标签形态*而不只是语义结果的场景。
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
}

interface ParseOptions extends ParserBaseOptions {
    createId?,
    blockTags?,
    mode?,
    onError?,          // 语义专属
    trackPositions?    // 与 StructuralParseOptions 共享
}

interface StructuralParseOptions extends ParserBaseOptions {
    trackPositions?: boolean;
}
```

| 参数                       | 类型                           | 说明                                          |
|--------------------------|------------------------------|---------------------------------------------|
| `text`                   | `string`                     | DSL 源码                                      |
| `options.handlers`       | `Record<string, TagHandler>` | 标签识别与形态门控（规则与 `parseRichText` 完全一致）。省略则全接受。 |
| `options.allowForms`     | `readonly TagForm[]`         | 限制接受的形态（需搭配 `handlers`）                     |
| `options.depthLimit`     | `number`                     | 最大嵌套深度（默认 `50`）                             |
| `options.syntax`         | `Partial<SyntaxInput>`       | 覆盖语法 token                                  |
| `options.tagName`        | `Partial<TagNameConfig>`     | 覆盖标签名字符规则                                   |
| `options.trackPositions` | `boolean`                    | 为每个节点附加 `position`（默认 `false`）              |

传入 `handlers` 时，标签识别和形态门控与 `parseRichText` **完全一致**——使用相同的 `supportsInlineForm` 决策表和
`filterHandlersByForms` 逻辑（共享代码，非镜像）。handler 函数本身不会被调用，只有 `inline` / `raw` / `block` 方法的存在性影响门控。

省略 `handlers` 时，所有合法标签和所有形态均被接受。

**闭包上下文继承：** 未传 `syntax` / `tagName` 覆盖时，`parseStructural` 继承外部 `withSyntax` / `withTagNameConfig`
上下文，可在自定义解析管线中自由组合：

```ts
withSyntax(customSyntax, () => {
    parseStructural(text);  // 使用 customSyntax
    parseStructural(text2); // 同样使用 customSyntax
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

纯 shallow merge 到 `DEFAULT_SYNTAX`——无推导。仅当你需要完全手动控制每个符号时使用。

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
> 自定义 syntax 在解析期间通过模块级活动状态生效。
> 对普通同步调用是安全的；如果多个并发异步请求共享同一个模块实例，需要自行做好隔离。

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

大多数项目中的标签都是简单包装器 — bold、italic、underline 等 — 不需要自定义逻辑。为每个标签写完整的
`{ inline: (tokens) => ({ type: "bold", value: ... }) }` 很繁琐。辅助函数让你可以批量注册。

### `createSimpleInlineHandlers(names)`

为一组标签名创建inline 处理器。
每个处理器将子 token 物化后包装为 `{ type: tagName, value: materializedTokens }`。

这是注册简单标签的**推荐方式**。

```ts
import {createParser, createSimpleInlineHandlers} from "yume-dsl-rich-text";

const dsl = createParser({
    handlers: {
        // 一行注册 5 个标签，而不是写 5 个处理器对象
        ...createSimpleInlineHandlers(["bold", "italic", "underline", "strike", "code"]),

        // 与需要更多逻辑的自定义处理器混合使用
        link: {
            inline: (tokens, ctx) => { /* ... */
            }
        },
    },
});
```

**它替代了什么：**

```ts
// 之前 — 重复
bold:      {
    inline: (tokens, ctx) => ({type: "bold", value: materializeTextTokens(tokens, ctx)})
}
,
italic:    {
    inline: (tokens, ctx) => ({type: "italic", value: materializeTextTokens(tokens, ctx)})
}
,
underline: {
    inline: (tokens, ctx) => ({type: "underline", value: materializeTextTokens(tokens, ctx)})
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

### `createSimpleBlockHandlers(names)`

创建block 处理器，对应 DSL 的多行 block 形式：`$$tag(arg)* ... *end$$`。
闭合标记 `*end$$` 必须独占一行，因此它更适合作为独立块使用，而不是和普通 inline 文本混排。
每个处理器直接透传 `arg` 和递归解析后的内容：`{ type: tagName, arg, value: content }`。

```ts
import {createParser, createSimpleInlineHandlers, createSimpleBlockHandlers} from "yume-dsl-rich-text";

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
import {createParser, createSimpleRawHandlers} from "yume-dsl-rich-text";

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
import {createParser, createPipeBlockHandlers} from "yume-dsl-rich-text";

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
import {createParser, createPipeRawHandlers} from "yume-dsl-rich-text";

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
import {createParser, createPassthroughTags} from "yume-dsl-rich-text";

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

`ParseOptions` 和 `StructuralParseOptions` 均继承自 `ParserBaseOptions`：

```ts
interface ParserBaseOptions {
    handlers?: Record<string, TagHandler>;
    allowForms?: readonly ("inline" | "raw" | "block")[];
    depthLimit?: number;
    syntax?: Partial<SyntaxInput>;
    tagName?: Partial<TagNameConfig>;
}

interface ParseOptions extends ParserBaseOptions {
    createId?: (token: TokenDraft) => string;
    blockTags?: readonly BlockTagInput[];
    mode?: "render";
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

### `ParseOptions` 专属字段

- `createId`：覆盖本次解析的 token id 生成策略
- `blockTags`：需要 block 换行规范化的标签 — 接受纯字符串或 `{ tag, forms }` 对象以按形式控制
- `mode`：仅支持 `"render"`。语法高亮场景请使用 `parseStructural`
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
    inline?: (tokens: TextToken[], ctx?: DslContext) => TokenDraft;
    raw?: (arg: string | undefined, content: string, ctx?: DslContext) => TokenDraft;
    block?: (arg: string | undefined, content: TextToken[], ctx?: DslContext) => TokenDraft;
}
```

你只需实现标签支持的形式。
不支持的形式会优雅降级，而非中断解析。

`ctx` 为了向后兼容仍是可选的。新写法建议接收它，并在调用 `parsePipeArgs`、`parsePipeTextList`、
`materializeTextTokens`、`unescapeInline`、`createToken` 等公开工具函数时继续透传。

新代码请统一传 `DslContext`。
旧代码可以不传，这条路径仅为向后兼容保留。

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
            inline: (tokens, ctx) => {
                const args = parsePipeArgs(tokens, ctx);
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
            raw: (arg, content, _ctx) => ({
                type: "code-block",
                lang: arg ?? "text",
                value: content,
            }),
        },

        // 自定义：同时支持 inline 和 block 形式
        info: {
            inline: (tokens, ctx) => {
                const args = parsePipeArgs(tokens, ctx);
                return {
                    type: "info",
                    title: extractText(args.materializedTokens(0)),
                    value: args.materializedTailTokens(1),
                };
            },
            block: (arg, content, _ctx) => ({
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

详见[自定义语法](#自定义语法)和[自定义标签名字符规则](#自定义标签名字符规则)。

| 导出                               | 说明                            |
|----------------------------------|-------------------------------|
| `DEFAULT_SYNTAX`                 | 内置语法符号（`$$`、`(`、`)$$` 等）      |
| `createEasySyntax(overrides)`    | 自动推导构建 `SyntaxConfig`（推荐）     |
| `createSyntax(overrides)`        | 纯 merge 构建 `SyntaxConfig`（底层） |
| `DEFAULT_TAG_NAME`               | 内置标签名字符规则                     |
| `createTagNameConfig(overrides)` | 从部分覆盖构建完整 `TagNameConfig`     |

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

大部分工具函数接受可选的 `ctx?: DslContext | SyntaxConfig` 参数。推荐的新写法是传 `DslContext`；如果只需要 syntax，也兼容直接传
`SyntaxConfig` 作为简写。`createToken()` 还继续兼容直接传裸 `CreateId` 函数，以保持向后兼容。省略时回退到 `withSyntax` /
`withCreateId` 在解析期间设置的模块级默认值——现有 handler 代码无需修改。未来 major 版本中，工具函数会逐步收紧到显式
`DslContext`。详见下方 [DslContext](#dslcontext)。

| 导出                                    | 使用者                   | 说明                                      |
|---------------------------------------|-----------------------|-----------------------------------------|
| `parsePipeArgs(tokens, ctx?)`         | 带 `\|` 参数的自定义处理器      | 按管道分割 token 并访问解析后的部分                   |
| `parsePipeTextArgs(text, ctx?)`       | 解析 raw 参数的自定义处理器      | 同上，但输入为纯文本字符串                           |
| `parsePipeTextList(text, ctx?)`       | 只需 `string[]` 的自定义处理器 | 将管道分隔字符串直接拆分为 trim 后的 `string[]`        |
| `splitTokensByPipe(tokens, ctx?)`     | 底层处理器代码               | 按 pipe 分割 token 的底层工具，不含辅助方法            |
| `extractText(tokens)`                 | 需要纯文本值的处理器            | 将 token 树展平为单个字符串                       |
| `materializeTextTokens(tokens, ctx?)` | 返回处理后子 token 的处理器     | 递归反转义 token 树中的文本 token                 |
| `unescapeInline(str, ctx?)`           | 处理 raw 字符串的处理器        | 反转义单个字符串中的 DSL 转义序列                     |
| `readEscapedSequence(text, i, ctx?)`  | 检查转义序列的处理器            | 读取位置 `i` 处的一个转义序列                       |
| `createToken(draft, position?, ctx?)` | 手动构建 token 的处理器       | 为 `TokenDraft` 添加 `id`（和可选的 `position`） |
| `resetTokenIdSeed()`                  | 测试代码                  | 重置 token id 计数器，用于确定性测试输出               |

上表中所有带 `ctx?` 的条目，当前都接受 `DslContext | SyntaxConfig`；其中 `createToken(draft, position?, ctx?)`
还额外兼容直接传裸 `CreateId` 函数。

> 解析期间，token id 默认按单次 parse 局部递增（`rt-0`、`rt-1` ...）。
> `createToken()` 只有在解析器外单独调用时才会使用模块级计数器，`resetTokenIdSeed()` 也主要用于这种测试场景。
> 如果你在 SSR 或并发异步请求里要求严格隔离，建议按运行时边界隔离 parser 的使用。

### DslContext

`DslContext` 是公开工具函数推荐使用的轻量上下文：

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

`ctx` 到底是什么：

- 在 `TagHandler` 内，`ctx` 是解析器为当前 parse 传入的第二/第三个参数。
- 它携带了这次 parse 的活动 `syntax` 和 token id 生成器。
- handler 内调用公开工具函数时，应继续把同一个 `ctx` 透传下去，这样所有工具都会沿用同一套 parse 级配置。
- 在解析器外部，你也可以手动构造 `DslContext` 并显式传入。

**当前行为：** 大部分工具函数当前接受 `ctx?: DslContext | SyntaxConfig`。

- 传 `DslContext`：同时显式提供 `syntax` 和 `createId`
- 传 `SyntaxConfig`：只显式提供 syntax 的简写
- 省略 `ctx`：从 `withSyntax` / `withCreateId` 设置的模块级状态读取
- `createToken(draft, position?, ctx?)` 还兼容直接传裸 `CreateId` 函数，作为向后兼容简写

新代码请统一传 `DslContext`。
旧代码可以不传，这条路径仅为向后兼容保留。

在解析期间的 handler 回调中，这种省略写法是正确的，因为 `parseRichText` 用这些闭包包裹了整个解析过程。

```ts
// handler 内：复用解析器传进来的 parse-local ctx
link: {
    inline: (tokens, ctx) => {
        const args = parsePipeArgs(tokens, ctx);
        return {type: "link", url: args.text(0), value: args.materializedTailTokens(1)};
    },
}

// 解析器外：手动构造 DslContext
const ctx: DslContext = {syntax: createSyntax(), createId: (draft) => `demo-${draft.type}`};
const args = parsePipeTextArgs("ts | Demo", ctx);
const token = createToken({type: "text", value: "hello"}, undefined, ctx);
```

**未来 major 版本：** 工具函数会逐步收紧到显式 `DslContext`。建议现在开始在 handler 回调之外（如独立脚本或测试中）调用工具函数时传入
`DslContext`。handler 内部的隐式回退在 major 版本变更前将继续工作。

### 迁移指南

**现有代码现在必须修改吗？**

不需要。

- 现有 handler 和工具函数调用在本版本里仍然可以不改继续工作。
- 省略 `ctx` 仍然受支持，这一版保留它 purely 是为了向后兼容。
- 新代码现在就应采用 `DslContext`，这样未来 major 的迁移会变得很小而且机械。

**受影响的 API**

这次迁移影响的是 handler 到 utility 的调用链，不是整个库一起变更：

- `TagHandler`
- `parsePipeArgs`
- `parsePipeTextArgs`
- `parsePipeTextList`
- `splitTokensByPipe`
- `materializeTextTokens`
- `unescapeInline`
- `readEscapedSequence`
- `createToken`

**Before / After**

```ts
// Before：仍然兼容
link: {
    inline: (tokens) => {
        const args = parsePipeArgs(tokens);
        return {type: "link", url: args.text(0), value: args.materializedTailTokens(1)};
    },
}

// After：推荐写法
link: {
    inline: (tokens, ctx) => {
        const args = parsePipeArgs(tokens, ctx);
        return {type: "link", url: args.text(0), value: args.materializedTailTokens(1)};
    },
}
```

```ts
// Before：独立工具调用依赖 ambient 默认值
const args = parsePipeTextArgs("ts | Demo");
const token = createToken({type: "text", value: "hello"});

// After：显式传入 DslContext
const ctx: DslContext = {syntax: createSyntax(), createId: (draft) => `demo-${draft.type}`};
const args = parsePipeTextArgs("ts | Demo", ctx);
const token = createToken({type: "text", value: "hello"}, undefined, ctx);
```

**推荐迁移顺序**

1. 先把自定义 `TagHandler` 签名改成接收 `ctx`。
2. 再把 handler 内调用的公开 utility 全部透传同一个 `ctx`。
3. 最后把独立脚本 / 测试中的 utility 调用改成手动构造并传入 `DslContext`。
4. 旧代码里暂时还能工作的隐式调用，可以等自然触达时再迁。

**未来 major 的收紧边界**

计划中的收紧范围是明确的：

- 公开 utility 会继续朝显式 `DslContext` 收紧。
- handler 示例和 helper 组合都应默认认为 `ctx` 会被接收并继续透传。
- 旧的隐式路径（`withSyntax` / `withCreateId` 的 ambient fallback，以及省略 `ctx`）预期只作为 major 版本到来前的兼容桥接层保留。
- `createToken(..., ctx?)` 也许会比其他 API 更久地保留裸 `CreateId` 简写，但新代码不应再依赖这种写法。

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
import {parsePipeTextList} from "yume-dsl-rich-text";

parsePipeTextList("ts | Demo | Label");
// → ["ts", "Demo", "Label"]
```

这也是 `createPipeBlockHandlers` 和 `createPipeRawHandlers` 内部使用的方法。

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

### `position` 覆盖范围

每个 token 的 `position` 都遵循对应解析器自己的输出语义。

- `parseRichText` 中，block/raw token 的 span 会包含因换行归一化而被消费的尾部换行。
- `parseStructural` 中，span 保持原始结构语法范围，因此会停在 `*end$$` / `%end$$` 处。

例如 `$$info()*\nhello\n*end$$\nnext` 中，`parseRichText` 的 `info.position.end` 会越过 `*end$$` 后的那个
`\n`；而 `parseStructural` 会把这个 `\n` 留给后续文本节点。

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

## 更新日志

版本历史已拆分到独立文件：

-  [更新日志](./CHANGELOG.zh-CN.md)

---

## 许可证

MIT
