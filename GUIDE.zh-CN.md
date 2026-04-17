[English](./README.md) | **中文**

# yume-dsl-rich-text (ユメテキスト)

<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" />

[![npm](https://img.shields.io/npm/v/yume-dsl-rich-text)](https://www.npmjs.com/package/yume-dsl-rich-text)
[![GitHub](https://img.shields.io/badge/GitHub-chiba233%2FyumeDSL-181717?logo=github)](https://github.com/chiba233/yumeDSL)
[![CI](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml/badge.svg)](https://github.com/chiba233/yumeDSL/actions/workflows/publish-dsl.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Wiki](https://img.shields.io/badge/Wiki-文档-6A57D5?logo=gitbook&logoColor=white)](https://github.com/chiba233/yumeDSL/wiki/)
[![Demo](https://img.shields.io/badge/Demo-在线演示-ff6b6b?logo=vue.js&logoColor=white)](https://chiba233.github.io/richTextDemo/)
[![Contributing](https://img.shields.io/badge/贡献指南-guide-blue.svg)](./CONTRIBUTING.zh-CN.md)
[![Security](https://img.shields.io/badge/安全策略-policy-red.svg)](./SECURITY.md)

零依赖、**Θ(n)**、给够堆内存时 public `parseStructural` 能跑完 5000 万层嵌套（`1.1.4` benchmark）的富文本 DSL 解析器。
文本进来，token 树出去——标签语义、渲染方式、目标框架，全部由你定义。

- **不是** Markdown 渲染器、富文本编辑器或 HTML 生产线
- **是** 一台只认语法不认语义的 token 机器——你喂它规则，它还你结构；[语法符号完全可换](#自定义语法)
- 无正则回溯、无递归——全迭代确定性扫描，输入多长跑多久
- **Θ(n)，n = `text.length`**（UTF-16 code units）。`1.1.2` 起 inline 帧改用 `parenDepth`
  计数器就地判定关闭，不再前扫 `findInlineClose`；render 层 `materializeTextTokens` 用
  `WeakSet` 跳过已处理子树——两条原 O(n²) 路径均已线性化。实际耗时取决于标签密度、节点密度、
  嵌套深度和 API 路径（`parseRichText` ≈ structural 扫描 + render 物化）。
  [完整复杂度分析](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E7%BA%BF%E6%80%A7%E6%97%B6%E9%97%B4%E5%A4%8D%E6%9D%82%E5%BA%A6)
- inline / raw / block 三种标签形式，语法符号和标签名规则完全可换；内置[转义序列](#转义序列)让任何语法符号都能作为普通文本出现
- 写错的、未知的标签[自动降级为纯文本](#错误处理)——不抛异常，不污染上下文
- 无框架绑定、不依赖 DOM——浏览器、Node、Deno、Bun、游戏引擎或任何 JS 运行时都能跑
- 内容驱动的[稳定 ID](#稳定-token-id)、[位置追踪](#源码位置追踪)、handler 级[管道参数](#管道参数)——开箱即用或按需组合
- [`parseStructural`](#parsestructural--结构化解析) 给你一张轻量的文档地图；配合 [
  `yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker) 的 `parseSlice`，跳到任意区域拿到带完整位置的
  `TextToken[]`，不用重新解析整个文档

### **[▶ 在线体验——输入 DSL，即时查看 token 树](https://chiba233.github.io/richTextDemo/)**

**实时编辑标签、开关 handler、边打字边看 token 树更新。**

> **`1.1.7` 实测 — 鲲鹏 920 aarch64 / Node v24.14.0**
>
> 200 KB dense inline 全量解析：`parseRichText` **~30.6 ms**，`parseStructural` **~23.3 ms**。
> 全迭代 O(n)，任意嵌套深度均不会爆栈。
>
> Structural parse 后堆内存：200 KB **~21.60 MB**，2 MB **~138.51 MB**。
>
> 子字符串解析：`parseRichText` 切片 + `baseOffset + tracker` **~20.62 µs**，`parseStructural` 同路径 **~13.47 µs**。
>
> 增量解析（~200 KB 文档里改一个 36 字符标签）：`nodeAtOffset` **~456.76 µs** + `parseSlice` **~8.36 µs**；
> 同文档全量 `parseRichText` 需要 **~19.45 ms**——增量路径快约 **42 倍**。
>
> 极限压测：5000 万层单链 inline 嵌套（~500 MB）`parseStructural` **~224.1 s**（历史 `1.1.4` 基准，当前 `1.4.x` 未重测）。
> 大规模深嵌套基准使用放宽后的堆预算；具体条件见性能页。
>
> 配合 [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker) 的 `parseSlice`——只重解析被修改的区域。
> `createIncrementalSession(...)` 把“编辑器级”的结构缓存能力直接带进连续编辑场景，让解析器在高频改动下也不用每次从头重建。
> `parseIncremental(...)` 则把同一套增量模型打包成一份可继续复用的首帧快照，适合从单次解析自然接入增量管线。
> 完整 session 生命周期、精确签名、`applyEditWithDiff(...)`
> 字段展开请看 [增量解析 wiki](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A2%9E%E9%87%8F%E8%A7%A3%E6%9E%90)。
> [完整性能数据](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%80%A7%E8%83%BD)

**适用场景：**
[游戏对话与视觉小说](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-%E6%B8%B8%E6%88%8F%E5%AF%B9%E8%AF%9D)
（打字机 / 抖动 / 变色——标签你自己发明）

[聊天与评论](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-%E5%AE%89%E5%85%A8UGC)（UGC 安全降级）

[CMS 与博客、文档管线、本地化工作流](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-%E5%AE%89%E5%85%A8UGC)
（翻译人员只碰文本，不碰标记）

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

**深入了解：**
[自定义语法](#自定义语法) · [处理器辅助函数](#处理器辅助函数) · [ParseOptions](#parseoptions) · [稳定 Token ID](#稳定-token-id) · [源码位置追踪](#源码位置追踪) · [错误处理](#错误处理) · [导出一览](#导出一览) · [增量解析](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A2%9E%E9%87%8F%E8%A7%A3%E6%9E%90) · [待弃用 API](#待弃用-api) · [兼容性](#兼容性说明)

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

> **降级规则：** 输入不合法或 handler 不支持用户写的形式时，解析器会优雅降级为纯文本而非抛出异常。完整规则——包括 raw/block
> 嵌套在 inline 内的常见陷阱——详见
> [DSL 语法 — 优雅降级规则](https://github.com/chiba233/yumeDSL/wiki/zh-CN-DSL-%E8%AF%AD%E6%B3%95#%E4%BC%98%E9%9B%85%E9%99%8D%E7%BA%A7%E8%A7%84%E5%88%99)
> wiki 页面。

### Inline 标签

```text
$$tagName(content)$$
```

Inline 内容递归解析，嵌套自然生效。

```text
$$bold(Hello $$italic(world)$$)$$
```

Inline 简写示例（`implicitInlineShorthand`）：

```text
$$bold(1234underline()test())$$
```

备注：简写仅在 inline 参数区生效，且仅匹配已注册并支持 inline form
的标签。配置方式见下文 [implicitInlineShorthand](#implicitinlineshorthand)。

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

| 选项                        | 预绑定后的效果                                                                                                                                                                        |
|---------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **`handlers`**            | **标签定义 — 使用 `createParser` 的主要理由**                                                                                                                                             |
| `syntax`                  | 自定义语法符号（如覆盖 `$$` 前缀等）                                                                                                                                                          |
| `tagName`                 | 自定义标签名字符规则                                                                                                                                                                     |
| `allowForms`              | 限制接受的标签形式（默认：全部启用）                                                                                                                                                             |
| `implicitInlineShorthand` | 控制 inline 参数中的 `name(...)` 简写（默认：关闭）。_1.3 起_                                                                                                                                   |
| `depthLimit`              | 嵌套深度限制 — 很少需要逐次修改                                                                                                                                                              |
| `createId`                | 自定义 token id 生成器（仍可按次覆盖）                                                                                                                                                       |
| `blockTags`               | 块级换行规范化——详见 [`declareMultilineTags`](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A4%84%E7%90%86%E5%99%A8%E8%BE%85%E5%8A%A9%E5%87%BD%E6%95%B0#declaremultilinetagsnames) |
| `onError`                 | 默认错误处理器（仍可按次覆盖）                                                                                                                                                                |
| `trackPositions`          | 为所有输出节点附加源码位置（仍可按次覆盖）                                                                                                                                                          |

**不用 `createParser` 的话**，每次调用都需要传入完整选项：

```ts
parseRichText(text, {handlers});
stripRichText(text, {handlers});

// 用 createParser
const dsl = createParser({handlers});
dsl.parse(text);
dsl.strip(text);
```

**方法一览：**

| 方法           | 输入                              | 输出                 | 继承的 defaults 字段                                                          |
|--------------|---------------------------------|--------------------|--------------------------------------------------------------------------|
| `parse`      | DSL 文本 + overrides?             | `TextToken[]`      | 全部 `ParseOptions`——`syntax`/`tagName` 的 override 会深合并                    |
| `strip`      | DSL 文本 + overrides?             | `string`           | 同 `parse`                                                                |
| `structural` | DSL 文本 + overrides?             | `StructuralNode[]` | `handlers`、`allowForms`、`syntax`、`tagName`、`depthLimit`、`trackPositions` |
| `print`      | `StructuralNode[]` + overrides? | `string`           | 仅 `syntax`——overrides 与 defaults 深合并。无损序列化器，不做门控                         |

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

### `parseIncremental` / `createIncrementalSession` — 增量结构缓存

这两个 API 用在“不是只解析一次，而是文档会被持续编辑”的场景。

这组增量 API 在 `1.4.x` 已属于稳定公开能力。
尤其要注意：session 级 fallback 是文档化契约，不是异常边角行为；
`applyEdit(...)` / `applyEditWithDiff(...)` 可能返回 `mode: "full-fallback"` 并带 `fallbackReason`，
而 diff 细化预算参数现在放在 `sessionOptions.diff`（也可在 `applyEditWithDiff(..., diffOptions)` 按次覆盖）。

- `parseIncremental(source, options?)` —— 建好并返回第一份增量快照（`IncrementalDocument`）
- `createIncrementalSession(source, options?, sessionOptions?)` —— 建一个长期存活的 session，后面反复吃 edit

简单记：

- 只要第一份快照 → `parseIncremental(...)`
- 编辑器 / 实时预览 / 连续更新 → `createIncrementalSession(...)`

README / GUIDE 里这里只放最短说明。`getDocument`、`applyEdit`、`applyEditWithDiff`、`rebuild` 的完整用法、diff
消费方式与集成示例，统一看 [增量解析 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A2%9E%E9%87%8F%E8%A7%A3%E6%9E%90)。

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

当标签渲染成块级 / 容器元素时，用它避免边界换行混进内容。它**不**创建处理器，只负责换行规范化。
如果你想按标签、按 form 做细粒度控制，它也支持 `{ tag, forms }` 对象形式，不只支持字符串数组。

**最短用法：**

```ts
blockTags: declareMultilineTags(["info", "warning", "center"])
```

**经验法则：** 如果你的标签渲染为块级元素，确保它出现在 `blockTags` 中。否则边界换行会混入内容，渲染时产生多余空行。

详见 [处理器辅助函数 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A4%84%E7%90%86%E5%99%A8%E8%BE%85%E5%8A%A9%E5%87%BD%E6%95%B0#declaremultilinetagsnames)
：完整 API 签名、各形态规则、`PipeHandlerDefinition` 接口细节。

## ParseOptions

这里先只保留最短概览。完整字段说明、示例、边界行为，统一看 [ParseOptions wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-ParseOptions-%E9%80%89%E9%A1%B9)。

`ParseOptions` 和 `StructuralParseOptions` 均继承自 `ParserBaseOptions`：

```ts
interface ParserBaseOptions {
    handlers?: Record<string, TagHandler>;
    allowForms?: readonly ("inline" | "raw" | "block")[];
    implicitInlineShorthand?: boolean | readonly string[];
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

### 你通常只需要记住这些字段

- `handlers`：你的标签定义
- `syntax` / `tagName`：改语法符号或标签名规则
- `allowForms`：全局限制只接受哪些标签形式
- `implicitInlineShorthand`：在 inline 参数区启用 `name(...)` 简写
- `depthLimit`：嵌套上限
- `trackPositions`、`baseOffset`、`tracker`：源码位置映射
- `blockTags`：块级换行规范化
- `onError`：收集解析错误
- `createId`：自定义本次解析的 token id

`StructuralParseOptions` 是偏结构解析的轻量子集；`ParseOptions` 在它之上再加 `createId`、`blockTags`、`onError` 这类渲染侧字段。

### allowForms

这个字段适合“评论区只允许 inline”这类全局门控场景。没列出的形式不会报错，而是优雅降级成普通文本。

完整示例和行为细节见：[ParseOptions wiki —
`allowForms`](https://github.com/chiba233/yumeDSL/wiki/zh-CN-ParseOptions-%E9%80%89%E9%A1%B9)。

### implicitInlineShorthand

> _1.3 起_

这个字段让 inline 参数区支持更轻量的 `name(...)` 简写；它只影响 inline 参数区，不影响顶层文本。可取 `false`、`true` 或标签白名单。

完整示例、白名单行为和解析优先级见：[ParseOptions wiki —
`implicitInlineShorthand`](https://github.com/chiba233/yumeDSL/wiki/zh-CN-ParseOptions-%E9%80%89%E9%A1%B9#implicitinlineshorthand)。

---

## Token 结构

`TextToken` 是解析器的输出形状：有 `type`、`value`、`id`、可选 `position`，以及你在 handler 里附加的额外字段。
它刻意保持开放结构，这样解析器不需要预先知道你的业务 schema。

### 强类型

如果你想要更强的编译期收窄，可以用 `NarrowToken`、`NarrowDraft`、`createTokenGuard`。

详见 [强类型 wiki 章节](https://github.com/chiba233/yumeDSL/wiki/zh-CN-Token-%E7%BB%93%E6%9E%84#%E5%BC%BA%E7%B1%BB%E5%9E%8B)
：完整 render 示例、`NarrowTokenUnion`、以及手写判别联合替代方案。

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

即使暂时不用，也建议在手写 handler 里把 `ctx` 参数写上，这样更符合后续 ctx-first 方向，也能避免并发环境下的模块级状态问题。

**最短示例：**

```ts
const dsl = createParser({
    handlers: {
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

> 增量解析这组 API 的表面积比核心解析更大。
> 如果你要接 session 或 diff，请先对照 wiki 里的精确签名和版本说明。

| 分类             | 导出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **核心**         | `parseRichText`、`stripRichText`、`createParser`、`parseStructural`、`printStructural`、`buildZones`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **增量解析**       | `parseIncremental`、`createIncrementalSession`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **配置**         | `DEFAULT_SYNTAX`、`createEasySyntax`、`createSyntax`、`DEFAULT_TAG_NAME`、`createTagNameConfig`、`createEasyStableId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **处理器辅助函数**    | `createPassthroughTags`、`createPipeHandlers`、`createPipeBlockHandlers`、`createPipeRawHandlers`、`createSimpleInlineHandlers`、`createSimpleBlockHandlers`、`createSimpleRawHandlers`、`declareMultilineTags`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **处理器工具函数**    | `parsePipeArgs`、`parsePipeTextArgs`、`parsePipeTextList`、`extractText`、`createTextToken`、`splitTokensByPipe`、`materializeTextTokens`、`unescapeInline`、`readEscapedSequence`、`createToken`、`createTokenGuard`、`resetTokenIdSeed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Token 遍历**   | `walkTokens`、`mapTokens`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **位置追踪**       | `buildPositionTracker`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **兼容上下文（已弃用）** | `withSyntax`、`getSyntax`、`withTagNameConfig`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **类型**         | `TextToken`、`TokenDraft`、`CreateId`、`DslContext`、`TagHandler`、`TagForm`、`InlineShorthandOption`、`ParseOptions`、`ParserBaseOptions`、`StructuralParseOptions`、`Parser`、`SyntaxInput`、`SyntaxConfig`、`TagNameConfig`、`BlockTagInput`、`BlockTagLookup`、`MultilineForm`、`ErrorCode`、`ParseError`、`StructuralNode`、`SourcePosition`、`SourceSpan`、`PositionTracker`、`PipeArgs`、`PipeHandlerDefinition`、`EasyStableIdOptions`、`PrintOptions`、`TokenVisitContext`、`WalkVisitor`、`MapVisitor`、`Zone`、`IncrementalDocument`、`IncrementalEdit`、`IncrementalParseOptions`、`IncrementalSessionOptions`、`TokenDiffResult`、`IncrementalSessionApplyResult`、`IncrementalSessionApplyWithDiffResult`、`NarrowToken`、`NarrowDraft`、`NarrowTokenUnion` |

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

解析器默认优雅降级而不是抛异常：未知标签、不支持的形式、以及不合法输入都会尽量回到文本形态。

> **⚠️ 常见陷阱：** raw / block 标签嵌套在 inline 参数区内时，handler 必须同时声明 `inline`。
> 否则解析器无法进入子帧，整个嵌套标签会降级为纯文本。
> 完整的降级决策表和示例见
> [DSL 语法 — 优雅降级规则](https://github.com/chiba233/yumeDSL/wiki/zh-CN-DSL-%E8%AF%AD%E6%B3%95#%E4%BC%98%E9%9B%85%E9%99%8D%E7%BA%A7%E8%A7%84%E5%88%99)
> wiki 页面。

详见 [错误处理 wiki 页面](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E9%94%99%E8%AF%AF%E5%A4%84%E7%90%86)
：错误码、触发场景、详细降级示例。

## 待弃用 API

以下这些**已导出的兼容 API**将在未来 major 版本中移除（2026 年 9 月前不会移除）：

`withSyntax`、`getSyntax`、`withTagNameConfig`、`resetTokenIdSeed`、
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
