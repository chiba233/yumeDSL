[English](./CHANGELOG.md) | **中文**

# 更新日志

### 1.0.12

- 新增结构打印 API：
  - `printStructural(nodes, options?)` — 将 `StructuralNode[]` 树序列化回 DSL 源码文本
  - `PrintOptions` 类型 — 接受 `syntax` 覆盖，用于自定义语法的往返序列化
  - 支持往返序列化：当使用相同的 syntax 配置时，
    `printStructural(parseStructural(input)) === input` 对良好输入成立
- 新增结构查询工具：
  - `findFirst(nodes, predicate)` — 前序深度优先搜索，返回第一个匹配的 `StructuralNode`
  - `findAll(nodes, predicate)` — 前序深度优先搜索，返回所有匹配的 `StructuralNode[]`
  - `nodeAtOffset(nodes, offset)` — 返回包含给定源码 offset 的最深结构节点
  - `enclosingNode(nodes, offset)` — 返回包含给定源码 offset 的最深标签节点（`inline` / `raw` / `block`）
  - `StructuralVisitContext` / `StructuralPredicate` 类型 — 为结构遍历提供类型化回调上下文

### 1.0.11

- 新增 token 遍历工具：
  - `walkTokens(tokens, visitor)` — 前序深度优先只读遍历；接受通用回调或 `Record<type, fn>` 按类型分发
  - `mapTokens(tokens, visitor)` — 后序深度优先不可变变换；返回替换 token、数组展开为多个兄弟节点、
    或 `null` 删除；children 在 visitor 看到父节点之前已完成变换
  - `TokenVisitContext` — 每次回调提供 `{ parent, depth, index }`
- 修复：`createParser(defaults)` 在 `parse()` / `strip()` / `structural()` 接收 override 时，
  现在对 `syntax` 和 `tagName` 做深合并。此前传递 `{ syntax: { escapeChar: "~" } }` 等局部覆盖
  会整个替换掉默认的 `syntax` 对象，而非合并进去

### 1.0.10

- 更新文档

### 1.0.9

- 新增公开导出：`createEasyStableId(options?)` — 解析会话级有状态 `CreateId` 生成器，
  基于内容生成确定性 token ID，替代默认顺序计数器
  - 默认指纹：`type` + `value`（递归）；可传自定义 `fingerprint` 闭包完全控制
  - 相同指纹自动用数字后缀消歧（`s-abc`、`s-abc-1`、…）
  - 可配置 `prefix`（默认 `"s"`）
- 新增公开类型：`EasyStableIdOptions`
- 文档
  - README / GUIDE 新增 **稳定 Token ID** 章节，含用法、作用域和消歧示例
  - 新增 **处理器工具函数** 示例 — 一个 handler 覆盖导出表中全部 10 个工具函数
  - 更新介绍：使用场景（游戏对话、聊天/UGC、CMS、本地化）、优雅降级、
    框架无关运行时、`parseStructural` + `parseSlice` 管线

### 1.0.8

- 移除 `deprecations.ts` 中的 `isInternalCaller` / `withInternalCaller` 隐式全局标志
- `withSyntax`、`withCreateId`、`withTagNameConfig`、`getSyntax` 改为接收显式
  `{ suppressDeprecation?: boolean }` 选项，不再依赖 ambient `internalCaller` 状态
- `parseRichText` 内部调用 `with*` 时直接传递 `{ suppressDeprecation: true }`
- 弃用警告输出优先使用 `process.stderr.write`，`console.warn` 作为回退
- 修改了死妈代码，让代码像个人类能看的东西：
  - `parseRichText` 中三层 `withSyntax`/`withTagNameConfig`/`withCreateId` 嵌套收拢为 `withLegacyAmbientState`
  - `tryParseComplexTag` 的 14 个位置参数改为 `ComplexTagContext` 对象
  - `scanInlineBoundary` 的布尔标志改为命名的 `InlineBoundaryMode` 对象
  - 提取 `bufferAndAdvance` 消除 `tryConsumeDepthLimitedTag` 中重复的 append+advance 模式
  - 提取 `pushNode` 消除 `structural.ts` 中重复的条件 position 赋值
  - 提取 `createPipeFormHandlers` 合并 `createPipeBlockHandlers` / `createPipeRawHandlers` 的重复逻辑

### 1.0.7

- 修复同时支持 inline 与 block/raw 形态的标签在 inline 关闭时的一个 bug：
  inline `$$tag(...)$$` 不再误用 block 归一化规则吞掉后续换行
- 修正文档中的子串位置追踪示例：
  更正 README / GUIDE 中的字符总数与尺子示例

### 1.0.6

- 新增公开导出：`buildPositionTracker(text)` — 从任意文本构建可复用的 `PositionTracker`
- 新增公开类型：`PositionTracker` — 预计算的行偏移表，用于将偏移量解析为行列号
- `ParserBaseOptions` 新增两个可选字段，支持子串解析场景：
  - `baseOffset?: number` — 将所有 `offset` 值偏移此量（默认 `0`）
  - `tracker?: PositionTracker` — 基于原始完整文档预构建的 tracker；
    传入后 `line` 和 `column` 也会基于原始文档解析
  - 两者均需要 `trackPositions: true` 才生效
  - 只传 `baseOffset` 不传 `tracker` 时，仅 `offset` 被偏移，`line`/`column` 仍为子串本地坐标
  - 同时传 `tracker` 时，三个字段（`offset`、`line`、`column`）均完全正确
- 以上选项同时适用于 `parseRichText` 和 `parseStructural`
- 无破坏性变更——所有新字段均可选，默认值向后兼容

### 1.0.5

- 新增 helper：`createPipeHandlers(definitions)`
  - 统一的 pipe-aware handler builder，可按需声明 `inline` / `raw` / `block` 的任意组合
  - `inline` handler 直接接收由 inline token 解析得到的 `PipeArgs`
  - `raw` / `block` handler 接收由 `arg` 解析得到的 `PipeArgs`，同时仍保留原始 `rawArg`
- 新增工具函数：`createTextToken(value, ctx?)`
  - 用于创建带 parse-local `createId` 支持的 `{ type: "text", value }` token 简写
- `PipeArgs` 现在补充了更顺手的读取方法，便于自定义 handler 编写
  - `has(index)`
  - `text(index, fallback?)`
  - `materializedTokens(index, fallback?)`
  - `materializedTailTokens(startIndex, fallback?)`
- `createPipeBlockHandlers` 和 `createPipeRawHandlers` 现在是 `createPipeHandlers` 的薄封装简写
- 旧版 ambient-state API 弃用告警（每条告警在运行时内只触发一次）
  - `withSyntax()`、`getSyntax()`、`withTagNameConfig()`、`withCreateId()`、`resetTokenIdSeed()` 被用户代码调用时
    发出一次性 `console.warn`
  - `parseRichText` 内部调用通过 `withInternalCaller` 屏蔽——正常解析不产生告警噪音
  - `parseStructural()` 在检测到 ambient `withSyntax()` / `withTagNameConfig()` 状态偏离默认值时专门告警；
    没有 ambient 包裹的正常调用不会告警
  - `NODE_ENV=production` 时告警被静默
- 待弃用导出正式写入新增的 **待弃用 API** 文档段落：
  `createPipeBlockHandlers`、`createPipeRawHandlers`、`createPassthroughTags`、`withSyntax`、`getSyntax`、
  `withTagNameConfig`、`withCreateId`、`resetTokenIdSeed`、`ParseOptions.mode`
- 待弃用 API 在 **2026 年 9 月前不会被移除**
- 文档整理
  - 将 `createPipeHandlers` 提升为主推荐的 pipe-aware helper
  - 将处理器辅助函数文档重组为 推荐 / 简写 / 进阶 三组
  - 在合适的工具示例里改用 `createTextToken(...)`
  - 同类辅助函数合并为共享小节，提升信息密度

### 1.0.4

- **重构：** 消除内部解析代码中所有剩余的模块级隐式状态读取
  - `ParseContext` 直接携带 `syntax`、`tagName`、`createId`——内部函数从中读取，不再调用 `getSyntax()` /
    `getTagNameConfig()` / 依赖 `activeCreateId`
  - 所有 scanner 函数（`findTagArgClose`、`readTagStartInfo`、`findInlineClose`、`findBlockClose`、`findRawClose`、
    `getTagCloserType`、`skipTagBoundary`、`skipDegradedInline`）接收显式 `syntax` / `tagName` 参数
  - `parseStructural` 通过 `parseNodes` 显式透传 `syntax` / `tagName` / `tracker`——内部不再需要 `withSyntax` /
    `withTagNameConfig` 包裹。入口处在无显式覆盖时捕获当前 `getSyntax()` / `getTagNameConfig()` 的 ambient 值
  - `parseRichText` 入口仍用 `withSyntax` / `withTagNameConfig` / `withCreateId` 包裹以保持向后兼容——用户 handler
    中调用公开工具函数（`parsePipeArgs`、`createToken`、`unescapeInline` 等）无需任何修改
- 新增类型：`DslContext { syntax, createId? }` — 公开工具函数的轻量上下文
  - 构建器工具（`splitTokensByPipe`、`parsePipeArgs`、`parsePipeTextArgs`、`parsePipeTextList`、
    `materializeTextTokens`）接受 `ctx?: DslContext`
  - 转义工具（`readEscapedSequence`、`readEscaped`、`unescapeInline`）接受 `ctx?: DslContext | SyntaxConfig`
    ——用户代码传 `DslContext`，内部 scanner 调用传裸 `SyntaxConfig`
  - `createToken(..., ctx?)` 接受 `ctx?: DslContext | CreateId`——用户代码传 `DslContext`，内部上下文透传传裸
    `CreateId`
  - syntax 解析（`resolveSyntax`）和 createId 解析（`resolveCreateId`）各集中在一处
  - 省略 `ctx` 时，所有工具函数回退到模块级默认值（`getSyntax()` / `activeCreateId`）——现有代码无需修改
  - **未来 major 版本将收紧为必填 `DslContext`**
- `TagHandler` 回调签名新增可选末尾参数 `ctx?: DslContext`
  - `inline?: (tokens, ctx?) => TokenDraft`
  - `raw?: (arg, content, ctx?) => TokenDraft`
  - `block?: (arg, content, ctx?) => TokenDraft`
  - 解析器调用 handler 时传入 `DslContext`——不接收 `ctx` 的现有 handler 不受影响（JS 安全忽略多余参数）
  - 选择接收 `ctx` 的 handler 可将其透传给工具函数，完全消除对隐式全局状态的依赖
- 内置 handler 便利函数现在在完整调用链中透传 `ctx`
  - `createSimpleInlineHandlers` → `materializeTextTokens(tokens, ctx)`
  - `createPipeBlockHandlers` → `parsePipeTextList(arg, ctx)`
  - `createPipeRawHandlers` → `parsePipeTextList(arg, ctx)`
- `parseStructural` 复用 `context.ts` 的 `emptyBuffer()` 进行 buffer 初始化和重置
- 所有现有导出和签名保持向后兼容；`DslContext` 及可选 `ctx` 参数为新增（非破坏性）

### 1.0.3

- **重构：** 位置追踪器从模块级隐式状态改为显式参数透传
  - `ParseContext` 直接携带 `tracker: PositionTracker | null`
  - `parseStructural` 通过 `parseNodes` 显式传递 tracker——无隐藏全局状态
  - `emitError` / `getErrorContext` 改为接收 tracker 参数，不再读模块状态
  - `complex.ts` 显式接收 tracker；内层解析偏移调整使用 `offsetTracker`（替代 `withBaseOffset` + `withPositionTracker`）
- **重构：** Buffer 累积状态合并为 `BufferState` 对象
  - `ParseContext.buffer` / `bufferStart` / `bufferSourceEnd` 合并为 `ParseContext.buf: BufferState`
  - `emptyBuffer()` 工厂函数用于初始化和重置
- **重构：** Block 内容归一化 + 偏移映射封装为 `prepareBlockContent`
  - 返回 `{ content, baseOffset }`——调用方不再手动拼接 `normalizeBlockTagContent` + `leadingTrim` + `contentStart`
- 无公开 API 变更，全部为内部改动

### 1.0.2

- 新增可选源码位置追踪（`trackPositions: true`），同时支持 `parseRichText` 和 `parseStructural`
  - 新类型：`SourcePosition`、`SourceSpan`
  - `TextToken.position?` 和 `StructuralNode.position?` — 仅在启用时出现
  - 预计算行偏移表 + O(log n) 二分查找行列号
  - 关闭时（默认）开销可忽略——不分配行表、不产生 position 对象
  - `parseRichText` 的 block/raw token span 包含尾部换行归一化；`parseStructural` 保持原始语法 span
  - 嵌套 block 子内容位置通过基准偏移调整映射回原始源码
  - 启用位置追踪时，错误报告复用行偏移表
- `normalizeBlockTagContent` 现在返回 `{ content, leadingTrim }` 而非纯字符串（内部变更，非公开 API）

### 1.0.1

- 新增 `createEasySyntax(overrides)` — 从 `tagPrefix` 和 `tagClose` 自动推导复合符号（`endTag`、`rawOpen`、
  `blockOpen`、`rawClose`、`blockClose`）的便利函数。显式覆盖仍优先。`createSyntax` 保留为底层纯 merge 版本
- 提升文档可读性——精简首页信息密度、新增推荐阅读顺序、新增 API 选型建议、新增生态组合指南、
  重写 Default Syntax 章节（ASCII 语法示意图 + 符号联动表）

### 1.0.0

- **行为变更：** 从 `ParseOptions.mode` 中移除 `"highlight"` 值——不再接受该值。
  三处内部 highlight 模式分支（跳过 block 内容裁剪、跳过尾部换行消费、跳过 raw 内容反转义）已全部删除。
  语法高亮场景请使用 `parseStructural`
- 将 `parseStructural` 重新定位为与 `parseRichText` 共享同一套语言配置的一等结构化解析 API，而非高亮辅助工具
- 将自定义语法提升为核心特性——更新了介绍、设计理念、特性和适用场景章节
- 取消导出 `supportsInlineForm` 和 `filterHandlersByForms`（仅内部使用，0.1.18–0.1.19 changelog 中误称已导出，
  实际从未从 `index.ts` 重导出）

### 0.1.20

- 擦AI生成文档的屁股

### 0.1.18 - 0.1.19

- 新增 `parseStructural(text, options?)` — 在输出树中保留标签形态（inline / raw / block）的结构化解析器，返回
  `StructuralNode[]`
  - 与 `parseRichText` 共享 `ParserBaseOptions`——传入 `handlers` 时标签识别和形态门控完全一致
  - 省略 `handlers` 则全接受（高亮模式）
  - 未传 override 时继承外部 `withSyntax` / `withTagNameConfig` 闭包上下文，可自由组合
- 抽取 `ParserBaseOptions` — `ParseOptions` 和 `StructuralParseOptions` 的共享基类
  （`handlers`、`allowForms`、`depthLimit`、`syntax`、`tagName`）
- `createParser` 返回值新增 `parser.structural()` 方法——与 `parse()` / `strip()` 共享基础配置
- 从内部模块导出 `supportsInlineForm`、`filterHandlersByForms`（structural 解析器共用，单一来源）
- 导出 `readEscapedSequence`、`withSyntax`、`getSyntax`、`withTagNameConfig`
- 导出 `ParserBaseOptions`、`StructuralNode`、`StructuralParseOptions` 类型
- 生态表新增 `yume-dsl-shiki-highlight`

### 0.1.15 – 0.1.17

- 新增[在线演示](https://qwwq.org/blog/dsl-fallback-museum) — 展示 Shiki 代码高亮插件、合法插件用法、故意书写错误的标记及错误报告
- 优化 npm 包体积，排除非必要文档（缩小约 30%）
- 新增 Vue 3 渲染指南，提供开箱即用的递归渲染组件示例
- 新增社区文档：`CONTRIBUTING.md`、`SECURITY.md`、Issue 模板、PR 模板
- 新增 `CONTRIBUTING.zh-CN.md` 中文贡献指南

### 0.1.14

- 更新readme和添加黄金测试。

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
