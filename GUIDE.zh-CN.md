[English](./README.md) | **中文**

# yume-dsl-rich-text (ユメテキスト)

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

[![npm](https://img.shields.io/npm/v/yume-dsl-rich-text)](https://www.npmjs.com/package/yume-dsl-rich-text)
[![GitHub](https://img.shields.io/badge/GitHub-chiba233%2FyumeDSL-181717?logo=github)](https://github.com/chiba233/yumeDSL)
[![CI](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml/badge.svg)](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Wiki](https://img.shields.io/badge/Wiki-文档-6A57D5?logo=gitbook&logoColor=white)](https://github.com/chiba233/yumeDSL/wiki/)
[![Demo](https://img.shields.io/badge/Demo-在线演示-ff6b6b?logo=vue.js&logoColor=white)](https://demo.qwwq.org/)
[![Contributing](https://img.shields.io/badge/贡献指南-guide-blue.svg)](./CONTRIBUTING.zh-CN.md)
[![Security](https://img.shields.io/badge/安全策略-policy-red.svg)](./SECURITY.md)

零依赖、单遍扫描的富文本 DSL 解析器。
文本进来，token 树出去——标签是什么意思、怎么渲染、放在哪个框架里，全部由你说了算。

- **不是** Markdown 渲染器、富文本编辑器或 HTML 生产线
- **是** 一台只认语法不认语义的 token 机器——你喂它规则，它还你结构；[语法符号完全可换](#自定义语法)
- 无正则回溯，确定性线性扫描，输入多长跑多久
- inline / raw / block 三种标签形式，语法符号和标签名规则完全可换；内置[转义序列](#转义序列)让任何语法符号都能作为普通文本出现
- 写错的、未知的标签[自动降级为纯文本](#错误处理)——不抛异常，不污染上下文
- 无框架绑定、不依赖 DOM——浏览器、Node、Deno、Bun、游戏引擎或任何 JS 运行时都能跑
- 内容驱动的[稳定 ID](#稳定-token-id)、单遍[位置追踪](#源码位置追踪)、handler 级[管道参数](#管道参数)——开箱即用或按需组合
- [`parseStructural`](#parsestructural--结构化解析) 给你一张轻量的文档地图；配合 [
  `yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker) 的 `parseSlice`，跳到任意区域拿到带完整位置的
  `TextToken[]`，不用重新解析整个文档

> **200 KB 实测（鲲鹏 920 / Node v24.14.0）：** 全量 `parseRichText` ~1382 ms → `parseStructural` ~41 ms（快 34 倍）→
`nodeAtOffset` + `parseSlice` **~0.17 ms**（快 **8000 倍**）。改一个 36 字符的标签，20 万字的文档只解析那 36 个字符。

### [▶ 实际站点演示文章 — qwwq.org/blog](https://qwwq.org/blog/dsl-fallback-museum)

**适用场景：**
游戏对话与视觉小说（打字机 / 抖动 / 变色——标签你自己发明），
聊天与评论（UGC 安全降级），
CMS 与博客、文档管线、本地化工作流（翻译人员只碰文本，不碰标记）

```tsx
// React — 递归渲染 token 树
const RichText: FC<{ tokens: TextToken[] }> = ({tokens}) => (
    <>{tokens.map(t =>
        t.type === "text" ? <span key={t.id}>{t.value as string}</span>
            : <strong key={t.id}><RichText tokens={t.value as TextToken[]}/></strong>
    )}</>
);
```

```vue
<!-- Vue 3 — 同样的思路，模板语法 -->
<template>
  <template v-for="t in tokens" :key="t.id">
    <span v-if="t.type === 'text'">{{ t.value }}</span>
    <strong v-else>
      <RichText :tokens="t.value"/>
    </strong>
  </template>
</template>
```

> 完整渲染指南：[Vue 3](https://github.com/chiba233/yumeDSL/wiki/zh-CN-Vue-3-%E6%B8%B2%E6%9F%93) ·
> [React](https://github.com/chiba233/yumeDSL/wiki/zh-CN-React-%E6%B8%B2%E6%9F%93)




## 生态

| 包                                                                                  | 角色                                   |
|------------------------------------------------------------------------------------|--------------------------------------|
| **`yume-dsl-rich-text`**                                                           | 解析器核心 — 文本到 token 树（本包）              |
| [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)       | 解释器 — token 树到输出节点                   |
| [`yume-dsl-shiki-highlight`](https://github.com/chiba233/yume-dsl-shiki-highlight) | 语法高亮 — 彩色 token 或 TextMate 语法        |
| [`yume-dsl-markdown-it`](https://github.com/chiba233/yume-dsl-markdown-it)         | markdown-it 插件 — Markdown 中渲染 DSL 标签 |

**推荐组合方式：**

- **只需把 DSL 解析成 token** → `yume-dsl-rich-text`
- **把 token 树解释为任意输出节点** → 再配合 `yume-dsl-token-walker`
- **源码级高亮或 TextMate 语法支持** → 再配合 `yume-dsl-shiki-highlight`
- **在 Markdown 中渲染 DSL（markdown-it）** → 再配合 `yume-dsl-markdown-it`

---

## 设计理念

- **无内置标签。** 每个标签的含义由你注册的处理器定义。
- **处理器就是语义层。** 处理器接收解析后的 token，返回 `TokenDraft`——输出结构、附加字段、行为全部由你决定。
- **渲染不是我们的工作。** 解析器产出 token 树；如何渲染（React、Vue、纯 HTML、终端）完全由你负责。
- **优雅降级。** 未知或不支持的标签永远不会抛出异常——静默降级。
- **一切可配置。** 语法符号、标签名规则、嵌套深度——需要覆盖什么就覆盖什么，其余保持默认。

---

## 快速导航

**从这里开始：** [安装](#安装) · [快速开始](#快速开始) · [DSL 语法](#dsl-语法) · [API](#api)

**深入了解：
** [自定义语法](#自定义语法) · [处理器辅助函数](#处理器辅助函数) · [ParseOptions](#parseoptions) · [稳定 Token ID](#稳定-token-id) · [源码位置追踪](#源码位置追踪) · [错误处理](#错误处理) · [导出一览](#导出一览) · [待弃用 API](#待弃用-api) · [兼容性](#兼容性说明)

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

**实战教程** — [Wiki](https://github.com/chiba233/yumeDSL/wiki#%E5%AE%9E%E6%88%98%E6%95%99%E7%A8%8B) 上的手把手指南：

- [从零实现 link 标签](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-link-%E6%A0%87%E7%AD%BE) —
  从零到一个可用的 `$$link(url | text)$$`
- [游戏对话标签](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-%E6%B8%B8%E6%88%8F%E5%AF%B9%E8%AF%9D) —
  为视觉小说打字机构建 shake/color/wait 标签
- [安全 UGC 聊天](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-%E5%AE%89%E5%85%A8UGC) — 白名单
  inline 标签、屏蔽危险形式、处理错误

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

// 单次覆盖会合并到默认值上。
// `syntax` 和 `tagName` 还会额外做一层深合并，因此局部覆盖不会冲掉其余默认配置。
dsl.parse(text, {onError: (e) => console.warn(e)});
```

**`createParser` 绑定了什么：**

大多数场景下，`createParser` 主要是为了绑定 `handlers`；其余选项只是顺手一起固化到实例上。

| 选项               | 预绑定后的效果                                                                                                                                                                        |
|------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **`handlers`**   | **标签定义 — 使用 `createParser` 的主要理由**                                                                                                                                             |
| `syntax`         | 自定义语法符号（如覆盖 `$$` 前缀等）                                                                                                                                                          |
| `tagName`        | 自定义标签名字符规则                                                                                                                                                                     |
| `allowForms`     | 限制接受的标签形式（默认：全部启用）                                                                                                                                                             |
| `depthLimit`     | 嵌套深度限制 — 很少需要逐次修改                                                                                                                                                              |
| `createId`       | 自定义 token id 生成器（仍可按次覆盖）                                                                                                                                                       |
| `blockTags`      | 块级换行规范化——详见 [`declareMultilineTags`](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A4%84%E7%90%86%E5%99%A8%E8%BE%85%E5%8A%A9%E5%87%BD%E6%95%B0#declaremultilinetagsnames) |
| `onError`        | 默认错误处理器（仍可按次覆盖）                                                                                                                                                                |
| `trackPositions` | 为所有输出节点附加源码位置（仍可按次覆盖）                                                                                                                                                          |

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

**方法一览：**

| 方法           | 输入                  | 输出                 | 继承的 defaults 字段                                                          |
|--------------|---------------------|--------------------|--------------------------------------------------------------------------|
| `parse`      | DSL 文本 + overrides? | `TextToken[]`      | 全部 `ParseOptions`——`syntax`/`tagName` 的 override 会深合并                    |
| `strip`      | DSL 文本 + overrides? | `string`           | 同 `parse`                                                                |
| `structural` | DSL 文本 + overrides? | `StructuralNode[]` | `handlers`、`allowForms`、`syntax`、`tagName`、`depthLimit`、`trackPositions` |
| `print`      | `StructuralNode[]`  | `string`           | 仅 `syntax`——无损序列化器，不做门控                                                  |

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

用于**结构消费场景**——高亮、lint、编辑器、源码检查。
在输出树中保留标签形态（inline / raw / block）。与 `parseRichText` 共享同一套语言配置。

```ts
const tree = parseStructural("$$bold(hello)$$ and $$code(ts)%\nconst x = 1;\n%end$$");
// [
//   { type: "inline", tag: "bold", children: [{ type: "text", value: "hello" }] },
//   { type: "text", value: " and " },
//   { type: "raw", tag: "code", args: [...], content: "\nconst x = 1;\n" },
// ]
```

**怎么选？** 渲染内容 → `parseRichText`；分析源码结构 → `parseStructural`。

详见 [API 参考 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-API-%E5%8F%82%E8%80%83#parsestructuraltext-options----%E7%BB%93%E6%9E%84%E5%8C%96%E8%A7%A3%E6%9E%90)：
`StructuralNode` 变体、`StructuralParseOptions`、与 `parseRichText` 的差异、`printStructural`。

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
            inline: (tokens, ctx) => ({type: "bold", value: tokens}),
        },
    },
});
```

详见 [自定义语法 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E8%87%AA%E5%AE%9A%E4%B9%89%E8%AF%AD%E6%B3%95)
：默认符号参考、符号联动表、`createEasySyntax` 推导规则、`createSyntax` 底层 API。

## 自定义标签名字符规则

默认标签名允许 `a-z`、`A-Z`、`0-9`、`_`、`-`（首字符不能是数字或 `-`）。

详见 [自定义标签名字符 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E8%87%AA%E5%AE%9A%E4%B9%89%E6%A0%87%E7%AD%BE%E5%90%8D%E5%AD%97%E7%AC%A6)：
`createTagNameConfig`、`DEFAULT_TAG_NAME`、冒号/数字等字符的使用示例。

## 处理器辅助函数

辅助函数让你批量注册标签处理器，无需重复编写样板代码。

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

| 辅助函数                         | 输出 Token 结构                                      |
|------------------------------|--------------------------------------------------|
| `createSimpleInlineHandlers` | `{ type: tagName, value: materializedTokens }`   |
| `createSimpleBlockHandlers`  | `{ type: tagName, arg, value: content }`         |
| `createSimpleRawHandlers`    | `{ type: tagName, arg, value: content }`（string） |

### `createPipeHandlers(definitions)`

**推荐的处理器辅助函数**，适用于需要管道参数、多形态、或自定义逻辑的标签。
每个 handler 接收预解析的 `PipeArgs`——无需手动调用 `parsePipeArgs`。

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

| 场景                            | 使用                           |
|-------------------------------|------------------------------|
| 简单 inline（bold、italic 等）      | `createSimpleInlineHandlers` |
| 简单 block（info、warning 等）      | `createSimpleBlockHandlers`  |
| 简单 raw（code、math 等）           | `createSimpleRawHandlers`    |
| 管道参数（`$$link(url \| text)$$`） | `createPipeHandlers`         |
| 多形态（inline + block + raw）     | `createPipeHandlers`         |

### `declareMultilineTags(names)` — 块级换行规范化

具有**块级/容器渲染语义**的标签——对话框、代码块、信息面板、居中标题——需要剥掉首尾边界换行。
否则，DSL 自然的多行写法：

```text
$$speaker(Alice)*
Hello!
*end$$
```

……会让内容变成 `"\nHello!\n"` 而不是 `"Hello!"`，渲染时**凭空多出空行**——一种极其隐蔽且难以排查的视觉 bug。

`declareMultilineTags` 告诉解析器哪些标签需要规范化。**不**创建处理器——配合上面的辅助函数一起使用。

**各形式的规范化行为：**

| 形式              | 剥离什么                                                | 适用场景                                          |
|-----------------|-----------------------------------------------------|-----------------------------------------------|
| `raw` / `block` | `)*` / `)%` 后的前导 `\n`，`*end$$` / `%end$$` 前的尾随 `\n` | 多行 block/raw 标签                               |
| `inline`        | inline close `$$` 后紧跟的 `\n`                         | 虽然用 inline 语法但渲染为块级元素的标签（如 `$$center(...)$$`） |

**用法：**

```ts
// 传字符串——三种形式全部规范化（raw + block + inline）
blockTags: declareMultilineTags(["info", "warning", "center"])

// 传对象——精细控制到特定形式
blockTags: declareMultilineTags([
    "info",                                // 字符串：三种形式全部规范化
    {tag: "code", forms: ["raw"]},       // 仅 raw 形式
    {tag: "center", forms: ["inline"]},  // 仅 inline 形式
])
```

**自动推导：** 解析器始终从 handler 方法自动推导 raw/block 规范化（有 `raw` → raw 形式，有 `block` → block 形式）。
传 `blockTags` 时，覆盖是**按标签的**：你列出的标签完全替换该标签的自动推导，没列出的标签保留自动推导。
**inline 规范化永远不会自动推导**——解析器无法知道一个 inline 标签是否渲染为块级元素，必须显式声明。

**经验法则：** 如果你的标签渲染为块级元素，确保它出现在 `blockTags` 中。否则边界换行会混入内容，渲染时产生多余空行。

详见 [处理器辅助函数 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A4%84%E7%90%86%E5%99%A8%E8%BE%85%E5%8A%A9%E5%87%BD%E6%95%B0)
：完整 API 签名、`PipeHandlerDefinition` 接口、各形态回调细节。

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
- `baseOffset`：子串解析时偏移所有 `offset`（默认 `0`）。
  详见 [源码位置追踪 wiki](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%BA%90%E7%A0%81%E4%BD%8D%E7%BD%AE%E8%BF%BD%E8%B8%AA#%E8%A7%A3%E6%9E%90%E5%AD%90%E5%AD%97%E7%AC%A6%E4%B8%B2baseoffset-%E5%92%8C-tracker)
- `tracker`：基于原始完整文档预构建的 `PositionTracker`，同时保证 `line`/`column` 正确。
  详见 [源码位置追踪 wiki](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%BA%90%E7%A0%81%E4%BD%8D%E7%BD%AE%E8%BF%BD%E8%B8%AA#%E8%A7%A3%E6%9E%90%E5%AD%90%E5%AD%97%E7%AC%A6%E4%B8%B2baseoffset-%E5%92%8C-tracker)

### `ParseOptions` 专属字段

- `createId`：覆盖本次解析的 token id 生成策略
- `blockTags`：块级换行规范化——纯字符串启用全部形式（raw + block + inline），`{ tag, forms }` 限定到特定形式。详见 [
  `declareMultilineTags`](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A4%84%E7%90%86%E5%99%A8%E8%BE%85%E5%8A%A9%E5%87%BD%E6%95%B0#declaremultilinetagsnames)
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
if (token.type === "link" && typeof token.url === "string") {
    console.log(token.url); // 可用，无需类型断言
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

定义继承 `TextToken` 的类型接口，在调用处做一次断言，然后通过可辨识联合收窄：

```ts
interface LinkToken extends TextToken {
    type: "link";
    url: string;
    value: MyToken[];
}

type MyToken = PlainText | BoldToken | LinkToken | CodeBlockToken;

const tokens = parseRichText(input, options) as MyToken[];
```

详见 [强类型 wiki 章节](https://github.com/chiba233/yumeDSL/wiki/zh-CN-Token-%E7%BB%93%E6%9E%84#%E5%BC%BA%E7%B1%BB%E5%9E%8B)
：完整的 render 示例与可辨识联合用法。

---

## 稳定 Token ID

默认情况下，每次 `parseRichText` 调用会分配顺序 ID（`rt-0`、`rt-1`、…）。
`createEasyStableId()` 返回一个基于内容的 `CreateId` 生成器——ID 根据 token 内容而非流中位置生成，
因此文档其他位置的编辑不会使不相关的 ID 偏移。

```ts
const tokens = parseRichText("Hello $$bold(world)$$", {
    handlers,
    createId: createEasyStableId(), // → "s-a1b2c3"（基于内容）
});
```

详见 [稳定 Token ID wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E7%A8%B3%E5%AE%9A-Token-ID)
：稳定性保证、自定义指纹、消歧、作用域控制、`EasyStableIdOptions`。

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

回调里的 `ctx` 是解析器传给你的上下文对象，不需要知道它是什么，写上就行。建议在所有回调中都声明 ctx——没有额外开销，兼容未来
ctx 必填的大版本，并避免并发环境（如 SSR）下的模块级状态问题。

### 示例

```ts
const dsl = createParser({
    handlers: {
        // 大多数标签 — 用辅助函数
        ...createSimpleInlineHandlers(["bold", "italic"]),

        // 手写处理器：只在需要自定义逻辑时
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

---

## 导出一览

| 分类           | 导出                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|--------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **核心**       | `parseRichText`、`stripRichText`、`createParser`、`parseStructural`、`printStructural`、`buildZones`                                                                                                                                                                                                                                                                                                                                            |
| **配置**       | `DEFAULT_SYNTAX`、`createEasySyntax`、`createSyntax`、`DEFAULT_TAG_NAME`、`createTagNameConfig`、`createEasyStableId`                                                                                                                                                                                                                                                                                                                           |
| **处理器辅助函数**  | `createPipeHandlers`、`createSimpleInlineHandlers`、`createSimpleBlockHandlers`、`createSimpleRawHandlers`、`declareMultilineTags`                                                                                                                                                                                                                                                                                                             |
| **处理器工具函数**  | `parsePipeArgs`、`parsePipeTextArgs`、`parsePipeTextList`、`extractText`、`createTextToken`、`splitTokensByPipe`、`materializeTextTokens`、`unescapeInline`、`readEscapedSequence`、`createToken`                                                                                                                                                                                                                                                   |
| **Token 遍历** | `walkTokens`、`mapTokens`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **位置追踪**     | `buildPositionTracker`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **类型**       | `TextToken`、`TokenDraft`、`CreateId`、`DslContext`、`TagHandler`、`TagForm`、`ParseOptions`、`ParserBaseOptions`、`StructuralParseOptions`、`Parser`、`SyntaxInput`、`SyntaxConfig`、`TagNameConfig`、`BlockTagInput`、`MultilineForm`、`ErrorCode`、`ParseError`、`StructuralNode`、`SourcePosition`、`SourceSpan`、`PositionTracker`、`PipeArgs`、`PipeHandlerDefinition`、`EasyStableIdOptions`、`PrintOptions`、`TokenVisitContext`、`WalkVisitor`、`MapVisitor` |

详见 [导出一览 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%AF%BC%E5%87%BA%E4%B8%80%E8%A7%88)
：完整签名及详细文档。

## 源码位置追踪

传入 `trackPositions: true` 可为每个输出节点附加 `position`（源码范围）。

```ts
const tokens = parseRichText("hello $$bold(world)$$", {
    handlers: {bold: {inline: (t, ctx) => ({type: "bold", value: t})}},
    trackPositions: true,
});
// tokens[0].position → { start: {offset:0, line:1, column:1}, end: {offset:6, line:1, column:7} }
```

解析子串时，传入 `baseOffset` 和 `buildPositionTracker(fullText)` 预构建的 `tracker` 可将位置映射回原始文档。

详见 [源码位置追踪 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%BA%90%E7%A0%81%E4%BD%8D%E7%BD%AE%E8%BF%BD%E8%B8%AA)
：类型定义、子串解析指南、`parseRichText` 与 `parseStructural` 差异、性能基准。

## 错误处理

使用 `onError` 收集解析错误。如果省略，错误被静默丢弃——解析器永远不会抛出异常。

```ts
const errors: ParseError[] = [];
parseRichText("$$bold(unclosed", {
    onError: (e) => errors.push(e),
});
// errors[0].code === "INLINE_NOT_CLOSED"
```

错误码：`DEPTH_LIMIT`、`UNEXPECTED_CLOSE`、`INLINE_NOT_CLOSED`、`BLOCK_NOT_CLOSED`、
`BLOCK_CLOSE_MALFORMED`、`RAW_NOT_CLOSED`、`RAW_CLOSE_MALFORMED`。

**优雅降级：** 未注册标签 → 纯文本，不支持的形式 → 回退文本，`allowForms` 限制 → 形式被剥离，未闭合标签 → 部分文本恢复。

详见 [错误处理 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E9%94%99%E8%AF%AF%E5%A4%84%E7%90%86)
：所有错误码及触发场景、详细降级示例。

## 待弃用 API

以下将在未来 major 版本中移除（2026 年 9 月前不会移除）：

`withSyntax`、`getSyntax`、`withTagNameConfig`、`withCreateId`、`resetTokenIdSeed`、
`createPipeBlockHandlers`、`createPipeRawHandlers`、`createPassthroughTags`、`ParseOptions.mode`

详见 [待弃用 API wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%BE%85%E5%BC%83%E7%94%A8-API)
：签名、替代方案及迁移指南。

---

## 更新日志

- [更新日志](./CHANGELOG.zh-CN.md)

### 兼容性说明

- 同一标签同时支持 inline 与 block/raw：`1.0.7+`
- `createParser` 局部覆盖深合并：`1.0.11+`

---

## 许可证

MIT
