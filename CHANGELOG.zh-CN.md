# 更新日志

## 1.0.4

- **重构：** 消除内部解析代码中所有剩余的模块级隐式状态读取
  - `ParseContext` 直接携带 `syntax`、`tagName`、`createId`——内部函数从中读取，不再调用 `getSyntax()` / `getTagNameConfig()` / 依赖 `activeCreateId`
  - 所有 scanner 函数（`findTagArgClose`、`readTagStartInfo`、`findInlineClose`、`findBlockClose`、`findRawClose`、`getTagCloserType`、`skipTagBoundary`、`skipDegradedInline`）接收显式 `syntax` / `tagName` 参数
  - `parseStructural` 通过 `parseNodes` 显式透传 `syntax` / `tagName` / `tracker`——内部不再需要 `withSyntax` / `withTagNameConfig` 包裹。入口处在无显式覆盖时捕获当前 `getSyntax()` / `getTagNameConfig()` 的 ambient 值
  - `parseRichText` 入口仍用 `withSyntax` / `withTagNameConfig` / `withCreateId` 包裹以保持向后兼容——用户 handler 中调用公开工具函数（`parsePipeArgs`、`createToken`、`unescapeInline` 等）无需任何修改
- 新增类型：`DslContext { syntax, createId? }` — 公开工具函数的轻量上下文
  - 所有公开工具函数（`readEscapedSequence`、`readEscaped`、`unescapeInline`、`splitTokensByPipe`、`parsePipeArgs`、`parsePipeTextArgs`、`parsePipeTextList`、`materializeTextTokens`、`createToken`）现在接受可选 `ctx?: DslContext | SyntaxConfig` 参数
  - 传 `DslContext` 可显式提供完整上下文；只需要 syntax 时也兼容直接传 `SyntaxConfig`
  - `createToken(..., ctx?)` 还继续兼容直接传裸 `CreateId` 函数，以保持向后兼容
  - 省略时回退到模块级默认值（`getSyntax()` / `activeCreateId`）——现有代码无需修改
  - **未来 major 版本会逐步收紧到显式 `DslContext`** — 建议现在开始采用 `DslContext` 以提前准备迁移
- `parseStructural` 复用 `context.ts` 的 `emptyBuffer()` 进行 buffer 初始化和重置
- 所有现有导出和签名保持向后兼容；`DslContext` 及可选 `ctx` 参数为新增（非破坏性）

## 1.0.3

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

## 1.0.2

- 新增可选源码位置追踪（`trackPositions: true`），同时支持 `parseRichText` 和 `parseStructural`
  - 新类型：`SourcePosition`、`SourceSpan`
  - `TextToken.position?` 和 `StructuralNode.position?` — 仅在启用时出现
  - 预计算行偏移表 + O(log n) 二分查找行列号
  - 关闭时（默认）开销可忽略——不分配行表、不产生 position 对象
  - `parseRichText` 的 block/raw token span 包含尾部换行归一化；`parseStructural` 保持原始语法 span
  - 嵌套 block 子内容位置通过基准偏移调整映射回原始源码
  - 启用位置追踪时，错误报告复用行偏移表
- `normalizeBlockTagContent` 现在返回 `{ content, leadingTrim }` 而非纯字符串（内部变更，非公开 API）

## 1.0.1

- 新增 `createEasySyntax(overrides)` — 从 `tagPrefix` 和 `tagClose` 自动推导复合符号（`endTag`、`rawOpen`、`blockOpen`、`rawClose`、`blockClose`）的便利函数。显式覆盖仍优先。`createSyntax` 保留为底层纯 merge 版本
- 提升文档可读性——精简首页信息密度、新增推荐阅读顺序、新增 API 选型建议、新增生态组合指南、重写 Default Syntax 章节（ASCII 语法示意图 + 符号联动表）

## 1.0.0

- **行为变更：** 从 `ParseOptions.mode` 中移除 `"highlight"` 值——不再接受该值。三处内部 highlight 模式分支（跳过 block 内容裁剪、跳过尾部换行消费、跳过 raw 内容反转义）已全部删除。语法高亮场景请使用 `parseStructural`
- 将 `parseStructural` 重新定位为与 `parseRichText` 共享同一套语言配置的一等结构化解析 API，而非高亮辅助工具
- 将自定义语法提升为核心特性——更新了介绍、设计理念、特性和适用场景章节
- 取消导出 `supportsInlineForm` 和 `filterHandlersByForms`（仅内部使用，0.1.18–0.1.19 changelog 中误称已导出，实际从未从 `index.ts` 重导出）

## 0.1.20

- 擦 AI 生成文档的屁股

## 0.1.18 - 0.1.19

- 新增 `parseStructural(text, options?)` — 在输出树中保留标签形态（inline / raw / block）的结构化解析器，返回 `StructuralNode[]`
