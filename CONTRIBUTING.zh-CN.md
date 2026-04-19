[English](./CONTRIBUTING.md) | **中文**

# 贡献 yumeDSL

感谢你的贡献意愿！这份指南说明如何搭建项目、运行测试，以及哪些区域适合外部贡献，哪些区域默认不建议直接动。

## 生态系统

| 包                                                                                  | 说明                                   |
|------------------------------------------------------------------------------------|--------------------------------------|
| **`yume-dsl-rich-text`**                                                           | 解析器核心：文本到 token 树（本仓库）               |
| [`yume-dsl-token-walker`](https://github.com/chiba233/yume-dsl-token-walker)       | 解释器：token 树到输出节点                     |
| [`yume-dsl-shiki-highlight`](https://github.com/chiba233/yume-dsl-shiki-highlight) | 语法高亮：tokens 或 TextMate grammar       |
| [`yume-dsl-markdown-it`](https://github.com/chiba233/yume-dsl-markdown-it)         | markdown-it 插件：在 Markdown 中嵌入 DSL 标签 |

## 前置要求

- **Node.js** >= 18
- **pnpm**（推荐） — `npm install -g pnpm`

## 开始开发

```bash
git clone https://github.com/chiba233/yumeDSL.git
cd yumeDSL
pnpm install

# 构建
pnpm build

# 运行测试
pnpm test
```

## 开发流程

1. 从 `master` 创建分支：
   ```bash
   git checkout -b fix/your-description
   ```
2. 进行修改。
3. 跑测试：
   ```bash
   pnpm test
   ```
4. 用清晰的提交信息提交（见下方[提交规范](#提交规范)）。
5. 发起 Pull Request。

## 提交规范

使用简短前缀说明改动类型：

| 前缀          | 用途                 |
|-------------|--------------------|
| `feat:`     | 新功能                |
| `fix:`      | Bug 修复             |
| `docs:`     | 仅文档                |
| `test:`     | 添加或更新测试            |
| `refactor:` | 既非修 bug 也非新功能的代码变更 |
| `chore:`    | 构建、CI、工具链          |

示例：

```text
fix(rich-text): handle escaped pipe inside raw tags
```

## 代码规范

- **`any` 和 `as any` 完全禁止。** ESLint 强制执行，没有例外 — 请修类型。
- **禁止 `switch` 语句。** 用 `if`/`else if` 链或查找对象替代。`switch` 有 fall-through 风险，且类型收窄精度不如带类型守卫的 `if` 链。
- **禁止 OOP 风格。** 不要写 `class`、不要用 `this` 分发、不要搞继承体系。整个代码库是函数 + 纯对象 + 闭包，保持这个风格。
- **优先类型守卫和联合收窄**，少用断言
- **零运行时依赖**：`yume-dsl-rich-text` 设计上保持无运行时依赖，除非先和维护者讨论

## structural 解析器维护边界

`src/structural.ts` 已经不再是一个"小解析辅助文件"，它实际上更像一个解析状态机 / 虚拟机。
对这个文件做"大而全、行为不变"的重写，现实里很难安全 review。

- 触碰 `src/structural.ts` 的 PR 应尽量限制在 bug 修复、正确性修复、窄范围回归修复
- 不要提交这个文件的功能扩张、纯清理重构、架构重写，或"把 parser 写简单一点"的 PR，除非维护者事先明确要求
- 如果必须改它，请保持补丁最小，并附最小复现或回归测试

## 默认不建议外部直接贡献的区域

这个解析器已经到了"有些部分更像语言运行时，而不是普通业务代码"的阶段。
很多看起来只是"顺手清理一下"的改动，实际上会悄悄改变语义、时序或热路径性能。

除非维护者事先明确要求，否则默认不要直接提交以下类型的 PR：

- **解析热路径重写**
    - 包括 `src/structural.ts`、`src/parse.ts`、`src/render.ts`
    - 不要做架构重写、parser 简化、虚拟机改递归、纯风格重构
    - 不要做"这个 helper / 对象 / 闭包看起来更优雅"的改动，除非它绑定到一个明确 bug 且带测试
- **公开契约重塑**
    - 不要扩大 `StructuralParseOptions`
    - 不要把 `createId`、`blockTags`、`mode`、`onError` 这类渲染层字段搬进 structural API
    - 不要试图统一 `parseRichText.position` 和 `parseStructural.position`
- **性能敏感抽象改造**
    - 不要在主解析路径上新增包装层、便捷 helper、对象重组、额外遍历，除非有 benchmark 支撑
    - "JS API 更干净"本身，不足以构成触碰热路径的理由
- **仅清理 position / error 路由**
    - `baseOffset`、`tracker`、`_meta`、内部错误通道各自职责不同
    - 如果你动这里，PR 必须明确说明保住了哪条语义边界

这些区域不是"永远不能动"，而是"默认只接受维护者主导"，除非是明确 bug、明确回归、或维护者指定任务。

## 增量解析 — 复杂是必要的

增量解析流水线（`src/incremental/`）是代码库中最复杂的部分之一。它包含多层门控、守卫、预算检查、退路和保守重建触发器。这些复杂性是**刻意的、承重的**。

每一条守卫都是因为发现了一个真实边界情况——跳过它会静默产生错误结果、过期缓存或无界重解析开销。举例：
- 脏区窗口边界计算必须考虑编辑点落在 token 中间的情况
- seam probe 必须验证复用边界两侧的结构连续性
- 基于预算的粗化机制防止对抗性输入上出现病态 diff 开销
- zone 级签名校验检测字节级 diff 看不到的语义漂移

**不要简化门控逻辑。** 不要因为"看起来多余"或"我的测试里这条分支从不触发"就移除守卫。很多守卫保护的是只在生产编辑会话中才出现的输入形状——部分删除、快速撤销/重做、并发 zone 失效。

如果你有**更好的算法**，能在更低复杂度下达到同样的安全保证，欢迎贡献——但 PR 必须：
- 明确列出替换了哪些现有守卫，以及为什么每条守卫不再需要
- 通过完整的增量解析测试套件，包括对抗性 / fuzzing fixture
- 附上短编辑和最坏情况两种工作负载的 before/after benchmark
- 不回归全量解析和增量路径之间的 `onError` / 恢复一致性

## 危险路径 — 看起来无害但会搞崩性能的改动

解析器的常数倍率经过多个版本的调优。以下模式都曾引发过真实回归，且很容易不经意间引入。**任何触碰主扫描循环或逐帧逻辑的 PR 必须附带 benchmark。**

### 禁止在主扫描循环中使用 `indexOf` / 原生扫描方法

`structural.ts` 的主扫描循环（`while` 循环 + `findNextBoundaryChar`）刻意维护完全显式的控制流 — 显式栈、显式逐字符 `charCodeAt` 比较、显式分支级联。这是设计决策，不是遗漏。

**不要**在主扫描循环或 `findNextBoundaryChar` 中引入 `indexOf`、`findIndex`、`Array.prototype.find`、`includes` 式搜索、`match` 等原生扫描方法。原因：
- 单次调用背后隐藏了一次线性扫描，让真实分支开销不可见
- 无法与其他检查短路交错
- V8 deopt 或输入形状变化时会产生不可预测的性能悬崖

注意：在 `scanner.ts` 的 `findBlockClose` / `findRawClose` 等有界区间辅助函数中使用 `indexOf` 是完全可以的——这些场景下扫描目标和边界已经确定，调用不在逐字符循环内部。此规则专门针对主扫描循环——每个字符都要经过分支级联的那条路径。

### `findNextBoundaryChar` — 快速文本跳跃循环

`structural.ts` 中的 `findNextBoundaryChar` 是最内层热循环。它用预算好的 `charCodeAt` 常量（每个语法边界 token 一个）向前扫描，返回下一个可能开始 token 的字符位置。

规则：
- **不要增加逐帧分配。** 早期方案在每帧存了一个 `number[]` 边界码数组和一个缓存 key 字符串。这在 20k 嵌套 benchmark 上导致了 +25.6% 的 `heapUsed` 回归。当前设计在每次 parse 开始时一次性预算 `tagPrefixLeadCode`、`tagCloseLeadCode`、`tagDividerLeadCode`、`escapeLeadCode`，逐帧状态（`insideArgs`、`inlineCloseToken`）通过简单 boolean / number 检查读取。
- **`NaN` 哨兵是承重结构。** 当 `inlineCloseToken` 为 `null` 时，`inlineCloseLeadCode` 被设为 `Number.NaN`。因为 `NaN !== NaN`，比较 `currentCode === inlineCloseLeadCode` 必然失败，不需要额外分支。不要"简化"成 `-1` 或条件判断 — 那会给每个字符多加一条分支。
- **`isTagStartChar` 是 shorthand 的边界停点。** 当 inline shorthand 启用时，跳跃循环必须在任何可能作为标签名开头的字符处停下来（如 `name(...)`）。这通过循环内的 `tagName.isTagStartChar` 实现。早期方案是对 shorthand 帧完全禁用 fast skip — 这在增量 inline / deep-inline benchmark 上引发了回归。

### `ParseFrame` 分配敏感性

`ParseFrame` 上的每个字段都会在每次入栈时分配。只在一个分支用到的字段（如 shorthand probe 状态）会膨胀所有帧对象。

当前设计使用 `ShorthandProbeState | null` — 一个按需创建的子对象，大多数帧上为 `null`。这替换了原来始终存在的四个数字字段，在深嵌套 benchmark 上显著降低了内存占用。

**不要给 `ParseFrame` 加字段**，除非你跑了 20k 嵌套的 heapUsed benchmark。如果字段只和一部分帧有关，请封装到按需创建的子对象中。

### WeakMap 缓存 — 按对象身份索引

若干缓存使用以 `SyntaxConfig` 或 token 数组身份为 key 的 `WeakMap`：

- `syntaxEscapableTokenCache` — 每种 syntax 下的可转义 token 集合（arg / root / blockContent）
- `tokenLeadMatcherCache` — 转义 token 的首字符分桶
- `tagArgCloseCache` — 每次 parse 按需创建的 `Map<number, number>`，只对 > 256 字符的帧启用

规则：
- **parse 开始后，`SyntaxConfig` 必须视为不可变。** WeakMap 缓存假设对象身份等价于内容身份。parse 过程中原地修改 `SyntaxConfig` 会静默返回过期的缓存数据。
- **token 数组必须保持引用稳定**，首字符分桶缓存才能命中。如果每次调用都重建数组，缓存形同虚设，每次都要重新分桶。
- **`getTagCloserTypeWithCache` 的 256 字符阈值是经验值。** 低于 256 字符时，缓存查找的开销超过缓存 argClose 位置的收益。不要在没有同时跑短帧和长帧工作负载的情况下改这个阈值。

### 转义 token 分桶

`escape.ts` 中的 `readEscapedSequenceWithTokens` 使用首字符分桶策略：token 按首字符分组存入 `Map<string, readonly string[]>`。发现转义字符时，只测试与下一个字符匹配的桶 — 而不是遍历全部 token 列表。

规则：
- `text[i] !== escapeChar[0]` 短路检查在 `startsWith` 之前执行，这是刻意的。不要移除 — 它让绝大多数字符跳过 `startsWith` 调用。
- 桶查找是 `O(桶大小)`，不是 `O(总 token 数)`。默认语法（9 个 token）下最坏桶大小约 3。如果新增可转义 token，检查是否有单个桶膨胀过大。

### `getTagCloserType` / `getTagCloserTypeWithCache` 契约

`getTagCloserType` 通过扫描 argClose 位置来判定标签是 inline、raw 还是 block。`getTagCloserTypeWithCache` 是缓存版本，仅用于 > 256 字符的帧。

- **`fillTagArgCloseCacheFrom` 必须与 `findTagArgClose` 保持同步。** 两者实现相同的深度跟踪和转义跳过逻辑。改一个必须改另一个。
- 缓存是 `Map<number, number>`（argOpen 位置 → argClose 位置），按需创建，同一帧内所有标签头共享。不要改成逐标签头缓存 — 那会失去分摊扫描开销的意义。

## 触碰 parser 内部时的最低要求

如果改动涉及 parser 内部或 parser-facing 的 public contract，PR 应至少包含：

- 最小复现
- 最小相关测试
- 如果影响时序：明确说明 `onError` 顺序、handler 调用顺序、或 `createId` 消费顺序
- 如果影响源码位置：明确说明保住的是哪条契约
    - `parseStructural` 负责 raw source truth
    - `parseRichText` 负责 normalized render truth
- 如果英文 / 中文文档描述了这条契约：两边都要改，不接受只改一边

## 测试

- 测试位于 `tests/` 目录
- 修 bug 时，先补一个能复现问题的测试，再写修复
- 不要直接改现有测试期望；如果你怀疑测试错了，先开 issue 或先和维护者确认

## 报告 Bug

请使用 [Bug Report](https://github.com/chiba233/yumeDSL/issues/new?template=bug_report.yml) 模板，并包含：

1. 受影响的包和版本
2. 最小复现代码
3. 预期行为与实际行为

## 建议新功能

请使用 [Feature Request](https://github.com/chiba233/yumeDSL/issues/new?template=feature_request.yml) 模板。

## 许可证

参与贡献即表示你同意你的贡献将在 [MIT License](./LICENSE) 下发布。
