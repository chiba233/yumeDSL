[English](./CHANGELOG.md) | **中文**

# 更新日志

### 1.3.7

- **修复：`endTag` 不再吞掉紧随其后标签的 `tagPrefix`**
  - 当 `)` 紧邻 `$$tagname(` 时，扫描器贪婪匹配 `)$$` 为 `endTag`，吞掉了下一个标签所需的 `$$` 前缀。如 `)$$bold(hello)$$` 会整体退化为纯文本。
  - 非 inline 帧现在只消费 `tagClose`（`)`），将 `tagPrefix`（`$$`）留给下一轮识别为标签起始。
  - 当剩余 `tagPrefix` 构成合法标签头时，抑制 `UNEXPECTED_CLOSE` 错误，避免误报。
- 无公共 API 变化

### 1.3.6

- **相较 1.3.5：转义规则改为按上下文生效**
  - 1.3.5 使用一套全局转义名单。
  - 1.3.6 改为按解析上下文（`root` / inline 参数 / raw 正文 / block 正文）分别处理，更符合各区域真实语法。
- **相较 1.3.5：混合内容下的闭合边界更稳定**
  - raw/block 正文内被转义的边界标记处理更可预期。
  - inline/raw/block 混合输入下，误闭合与歧义闭合显著减少。
- 无公共 API 变化

### 1.3.5

- **`createEasyStableId`：新增 `disambiguationScope` 选项**
  - 新选项 `disambiguationScope?: "parse" | "lifetime"`，控制消歧计数器的重置时机。
  - `"parse"`（新默认值）：每次 `parseRichText` 调用时通过内部 parse-lifecycle hook 自动清空计数器和 `arrayCache`。共享同一个 generator 时，相同输入在不同 parse 中产生相同 ID。重入 parse（handler 内部再次调用 `parseRichText`）栈安全——内层 parse 状态不会污染外层。
  - `"lifetime"`：计数器在 generator 生命周期内累积不重置——等同于此前行为。
- **行为变更（默认作用域）**
  - 此前，同一个 `createEasyStableId()` generator 跨多次 `parseRichText` 调用时，消歧后缀会累积，导致相同输入在后续 parse 中产生不同 ID。
  - 现在默认 `"parse"` 作用域会在每次 parse 前重置，相同输入始终产生相同 ID。依赖跨 parse 唯一性的用户需改用 `disambiguationScope: "lifetime"`。
- 无其他公共 API 变化

### 1.3.4

- **重构：inline 状态机路径收敛为单入口**
  - inline close 处理、tag/text 消费、EOF 收敛分别抽成单入口函数。
  - 主循环控制流更平坦、更一致；语义保持不变。
- **解析策略定稿：局部恢复优先于整段保留**
  - 错误恢复明确采用“局部成功 / 局部失败”的最近边界恢复，不再追求把历史 malformed 片段整坨保留。
  - 该策略是有意选择，用于统一解析模型与用户心智。
- **shorthand / full-form 归属仲裁继续集中化**
  - push / close / EOF 阶段继续复用同一归属判定函数。
  - 在 shorthand continuation 与 full-form close 竞争时，仍优先 full-form close。
- **测试：新增 shorthand 开关行为矩阵**
  - 新增 `implicitInlineShorthand=false/true` 双模式行为矩阵测试，固定当前恢复输出。
  - 同时覆盖 `extractText` 预期与 `printStructural` 回环（round-trip）检查，防止回归漂移。
- 无公共 API 变化

### 1.3.3

- **修复：恢复 shorthand + 完整 DSL 混合嵌套时的数据正确性**
  - 之前一版 shorthand 歧义守卫会在 shorthand 内容内出现完整 DSL 标签时过早结束 shorthand 上下文，导致结构分组错误。典型输入：
    - `=bold<天気がbold<い=italic<い>=>から>=散歩しましょう`
  - 现在 shorthand 子帧会跨过其内部完整 DSL 子标签继续保持开启，仅在自身关闭符（`tagClose`）处关闭，恢复预期树结构。
- **修复：保留歧义防护且不再误拒**
  - 继续保留 `=bold<bold<>=` 与 `=bold<bold<<>=` 的父级闭合防护，同时避免此前“过度拒绝 shorthand”的副作用。
- **行为说明**
  - inline 参数上下文中，shorthand 与完整 DSL 现在可在同一子树稳定共存（`bold<...=italic<...>=...>`），闭合归属确定且可预期。
- 无公共 API 变化

### 1.3.2

- **修复：shorthand 在紧邻父级闭合边界时不再抢占闭合（`=bold<bold<>=`）**
  - 在 inline 参数 shorthand 模式下，`name<` 曾可能在参数起点恰好命中父级 `endTag` 时仍被当作 shorthand 子标签。
  - `tryPushInlineShorthandChild` 现已在该边界拒绝进入 shorthand 子帧，父级 inline 闭合归属父帧。
- **修复：shorthand 不再通过首个 `tagClose` 误吃父级闭合（`=bold<bold<<>=`）**
  - shorthand 候选可能吞掉本该作为父级 `endTag` 起点的 `tagClose`，导致外层 inline 退化为纯文本。
  - 现在该模式会按歧义处理，`name<...` 保留为父级内容文本。
- **性能：同帧复用 shorthand 歧义前探结果**
  - 新增帧级前探缓存（`start` / `firstClose` / `firstCloseIsEndTag`），减少相邻 shorthand 候选的重复向前扫描。
  - 语义不变，仅优化重复探测开销。
- 无公共 API 变化

### 1.3.1

- **修复：shorthand 现在正确受 `depthLimit` 约束**
  - shorthand 标签（`name(...)`）此前绕过了深度限制检查，因为它不走完整标签头识别路径。深层 shorthand 嵌套可以超过 `depthLimit` 而不触发降级。
  - `tryPushInlineShorthandChild` 现在检查 `frame.depth >= depthLimit` 并报告 `DEPTH_LIMIT` 错误，将 shorthand 标签头降级为纯文本——与完整 DSL 行为一致。
- **修复：括号不配平不再导致整个标签退化为纯文本**
  - `findTagArgClose` 匹配内容中所有裸 `(` / `)` 字符，因此任何括号不配平（如漏写一个 `)`）都会导致参数闭合搜索失败 → `getTagCloserType` 返回 `null` → 整个标签退化为纯文本。
  - 当 `getTagCloserType` 返回 `null` 时，解析器现在强制进入 inline 子帧，而非回退为文本。inline 子帧使用 `scanInlineBoundary`（仅将完整的 `$$tag(` 计为嵌套层级），逐字符正确找到真正的闭合标记。
  - 效果：单个漏括号现在只影响最内层不配平的标签，外层标签完整保留。此前整棵标签树都会坍塌为纯文本。
  - 这是自 v1.0 以来的历史 bug，并非 shorthand 引入。

### 1.3.0

- **新增：inline 隐式简写（`name(...)`）**
  - 在 inline 参数上下文中支持 shorthand 解析。
  - 解析优先级固定为：完整 DSL 结构（`inline` / `raw` / `block`）优先，其次 shorthand，最后普通文本。
  - shorthand 状态不会跨完整结构继承，避免跨层误闭合。
  - inline 参数扫描在 shorthand 处理上不再依赖裸括号配平，仍保持单遍扫描、无回溯、O(n)。
- **print 联动：`printStructural` 支持 shorthand 形态输出**
  - 当 inline 节点带 `implicitInlineShorthand: true` 且位于 inline 参数上下文时，打印为 `name(...)`（或自定义语法下的等价 shorthand 形态）。
  - 非 inline 参数上下文仍按完整 DSL 形态输出，保证向后兼容。
- **配置项：`implicitInlineShorthand`**
  - 新增解析选项：`implicitInlineShorthand?: boolean | readonly string[]`。
  - `false`（默认）：关闭。
  - `true`：对所有已注册且支持 inline form 的标签开启。
  - `string[]`：仅对白名单标签开启。
- **行为边界（兼容性说明）**
  - `implicitInlineShorthand` 仅在 `$$tag(` 的 inline 参数子扫描上下文中生效。
  - 顶层文本扫描与完整 DSL 结构入口不会把普通 `name(...)` 当作 shorthand。
  - shorthand 产物仅作为 inline 子节点标记（`implicitInlineShorthand: true`），不会改变完整 `$$tag(...)$$` 的既有语义。
- **增量正确性修复**
  - 修复 `implicitInlineShorthand` 默认值与增量指纹不一致的问题。
  - `undefined` 现在按 `false` 参与指纹计算（与运行时默认行为一致），从 `undefined` 切到 `true` 时会正确触发重建，不会复用过期增量结果。
- **结构节点元信息**
  - `StructuralNode` 的 inline 节点新增可选字段 `implicitInlineShorthand?: boolean`。
  - 仅当该 inline 节点由 inline 参数上下文中的 shorthand（`name(...)`）生成时，该字段为 `true`。
- **增量签名一致性**
  - zone/node 签名已纳入 inline shorthand 标记，避免 shorthand 与非 shorthand inline 节点在复用路径上发生结构误判。
- **诊断信息**
  - 新增解析错误码：`SHORTHAND_NOT_CLOSED`。
  - 当隐式 inline shorthand 帧（`name(...)`）在 EOF 前未遇到闭合 `)` 时上报该错误。
  - 现有完整 inline form 的 `INLINE_NOT_CLOSED` 语义保持不变。
- 现有公共 API 无破坏性变化。

### 1.2.7

- **清除运行时热路径中剩余的原生递归**
  - `cloneSnapshotValueInternal`（增量 parse-options 快照克隆）从原生递归改为显式栈迭代，并保留 `WeakMap` 循环引用保护。
  - `cloneToken`（render 阶段用于 block 边界裁剪的 token 深拷贝）从原生递归改为显式栈 DFS 克隆。
  - 修复深层树工作负载中剩余的栈安全短板，外部行为保持不变。
- 无公共 API 变化

### 1.2.6

- **增量签名路径栈安全修复**
  - 将 `nodeSignature` 的递归遍历改为显式栈后序迭代（`frameStack` + `valueStack`）。
  - 增量 seam 签名路径（`zoneSignature` / 右侧复用探测）不再依赖 JS 调用栈深度，修复超深嵌套树在增量更新时的栈溢出问题。
- 无公共 API 变化

### 1.2.5

- **增量路径延迟 `cloneParseOptions`**
  - `nextParseOptionsSnapshot` 现在仅在所有 early full-rebuild 守卫通过后才计算。此前 `cloneParseOptions(options)` 在函数入口无条件执行；若任一守卫触发全量重建，该 clone 即被浪费——而 `parseIncrementalInternal` 内部还会再 clone 一次。
- **full-rebuild fallback 时复用 tracker**
  - `parseIncrementalInternal` 新增可选 `existingTracker` 参数。当增量路径在 `buildPositionTracker` 已构建之后 fallback 到全量重建时，直接透传已有 tracker，避免重复构建。
- **`findDirtyRange` 单遍扫描**
  - 重叠检测与插入点搜索合并为单次线性遍历。此前无重叠的编辑会触发第二次遍历来定位插入点；现在插入点作为重叠扫描的副产品一并记录，消除了额外遍历。
- **`cloneSnapshotValueInternal` 消除逐层 `Object.keys` 分配**
  - plain-object 分支从 `Object.keys(value)` + 索引循环改为 `for...in` 直接遍历，省去递归深拷贝时每层的临时 `string[]` 分配。语义不变——`isPlainObject` 已保证 prototype 为 `Object.prototype`（内置属性不可枚举）或 `null`（无继承）。

### 1.2.4

- **纯 inline 文档 zone 切分（`softZoneNodeCap`）**
  - 内部 zone 构建器现在会在非 breaker 节点（text / escape / separator / inline）连续超过可配软上限时自动切分（`SOFT_ZONE_NODE_CAP`，默认 64）。
  - 公开 API `buildZones(...)` 行为不变——始终返回与之前相同的结果。zone 切分仅在增量内部路径（`buildZonesInternal`）生效。
  - 以前没有 `raw` / `block` 节点的文档（纯 inline）只产生 1 个 zone，增量解析等于没用。切分后 1 MB 纯 inline 文档产生约 800 个 zone，相比全量重建加速 14.6 倍。
  - 新增会话选项 `softZoneNodeCap?: number`（`IncrementalSessionOptions`），允许调用方根据自身场景调节 zone 粒度。最小有效值 2（内部 clamp）。
- **低 zone 数量守卫**
  - 上一快照 zone 数 ≤ 1（如极短文档或无 handler 的纯文本）时，增量路径直接跳过、走全量重建。避免在无法复用 zone 的场景浪费增量开销。
  - 触发时返回 `INTERNAL_FULL_REBUILD` 回退原因。
- **增量性能优化：惰性右侧平移**
  - 右侧 zone 复用从即时深拷贝 + 递归平移改为 O(1) 惰性 delta 累积（`deferShiftZone`）。
  - 首次消费时才物化节点位置（`materializeZone`），通过 `Object.defineProperty` 惰性 getter 延迟 `tree` / `zones` 展开。
  - 连续头部编辑场景下 delta 自动叠加，不触发中间物化，大幅降低右侧子树开销。
- **快照克隆开销优化**
  - `cloneParseOptions` 引入 `frozenSnapshots` WeakSet：已生成的快照重入时跳过 handlers 深拷贝（full-rebuild → parseIncremental 路径受益）。
  - 快路径修正：frozen 快照重入时返回 shallow spread 新对象而非同一引用，防止跨代 alias 导致旧文档 mutation 穿透到新文档。
- **签名哈希瘦身**
  - `nodeSignature` 内容哈希从全量 `hashText` 改为 O(1) 有界采样（头尾各 32 字符 `fnvFeedStringBounded`）：保留同长度异内容检测能力，避免长文本节点线性扫描开销。
- **内部重构**
  - 提取 `fullRebuild()` 局部函数，5 处重复的三行重建模式合一。
  - 新增 `feedChildSignatures` 工具函数，消除 nodeSignature 中 init→feed→shift 的重复流程。
  - `createShiftedNodeShell` 分支压缩为单行 return。
  - `shiftNode` 移除 `shouldExpandNestedNode` 间接层，帧分发合并。
  - syntax fingerprint 8 字段重复调用改为 `syntaxKeys` 数组循环。
- **基准测试数据（1 MB 文档，鲲鹏 920 aarch64，Node 24）**
  - 全量 `parseIncremental`（初始快照）：~130 ms
  - 纯 inline（zone 切分，softCap=64，~264 zone）：增量 ~12 ms → **约 10 倍加速**
  - 中等 raw/block 密度（~3700 zone）：增量 ~15 ms → **约 9 倍加速**
  - 密集 raw/block（~17000+ zone）：增量 ~38 ms → ~3.5 倍（zone 组装开销占主导）
  - GC 稳定性：50 次连续 inline 编辑无手动 GC，median ~9 ms，无退化
- 无公共 API 破坏性变化（会话选项 `softZoneNodeCap` 为可选新增）

### 1.2.3

- **增量 API 导出面清理**
  - 从公共导出中移除 low-level updater：`updateIncremental(...)` / `tryUpdateIncremental(...)`。
  - 公共接入收敛为 session-first：`createIncrementalSession(...)`（`parseIncremental(...)` 负责初始化快照）。
  - 精简 session-only 类型导出。
  - `optionsFingerprint` 改为内部状态，不再暴露在 `IncrementalDocument`。
- **Session mode 语义修正**
  - 修复 mode 失真：当增量保护路径内部升级为全量重建时，`applyEdit(...)` 现在返回：
    - `mode: "full-fallback"`
    - `fallbackReason: "INTERNAL_FULL_REBUILD"`
  - 外部监控 / benchmark 与真实执行一致。
- **Options 快照正确性加固**
  - `handlers` 快照升级为对 plain object/array 字段递归克隆。
  - 为快照克隆增加循环引用保护（自引用 metadata 可安全处理）。
  - 即使 options fingerprint 等价，只要显式传入 `applyEdit(..., options)`，该次 options 仍会被捕获并继承到会话快照。
  - options fingerprint 计算移除 `JSON.stringify`，改为数值哈希，降低高频编辑常数开销。

### 1.2.2

- **会话回退统计修正（auto 策略）**
  - 修复 `updateIncremental(...)` 在内部走 `parseIncremental(...)` 全量重建时，session 回退率采样失真的问题
  - `createIncrementalSession(...).applyEdit(...)` 现在会把这类“内部全量重建”计入 fallback marks，确保 `maxFallbackRate` / cooldown 自适应判断更准确
  - 无破坏性 API 变更；本次仅修复统计语义
- **增量正确性加固（右侧复用安全门）**
  - `updateIncremental(...)` 不再仅凭拼接边界复用右侧 zones；新增 seam probe 窗口校验
  - 当探测区的 zone 结构 / 签名不一致时，拒绝复用并自动回退全量重建
  - 增加 probe 窗口常量与额外 margin zone，降低 seam 邻近闭合场景下的误判回退
- **增量选项兼容指纹**
  - 在增量文档快照中新增内部 `optionsFingerprint`
  - 复用前统一比较规范化 parse-options 指纹（syntax / allowForms / handlers 引用身份 / tagName 引用身份）
  - 在类型说明中明确：保持 `handlers` 引用稳定可提升增量复用命中率
- **哈希内部实现收敛**
  - 新增共享 `src/hash.ts`（FNV 工具）
  - 增量 seam 签名与 stable-id 内部实现统一复用共享哈希能力
  - 移除重复的本地哈希实现
- **增量可观测性与回归测试**
  - 新增内部 debug sink（用于测试采集重解析 / probe 统计）
  - 扩充 incremental 用例：seam 命中 / 拒绝、fingerprint 触发回退、handlers 引用稳定性、extra-margin、生长文档性能 guard
- 现有 `parseRichText` / `parseStructural` 等公共 API 无破坏性变更

### 1.2.1

- **新增 API：`createIncrementalSession(...)`**
  - 新增面向编辑器工作流的 correctness-first 会话入口
  - `session.applyEdit(...)` 提供稳定的高层契约：可增量则增量，必要时自动回退全量重建
  - 增加会话结果元信息（`mode`、`fallbackReason`），便于观测与调优
- **自适应策略能力**
  - 新增 `sessionOptions.strategy`：`"auto"`（默认）、`"incremental-only"`、`"full-only"`
  - 新增 auto 策略参数（`maxEditRatioForIncremental`、回退率阈值、性能倍率、冷却窗口、采样窗口）
  - 目标是在保证语义正确的前提下，避免“过早全量”与“病态增量”两类极端
- **实验面收口说明**
  - 底层 `updateIncremental(...)` / `tryUpdateIncremental(...)` 现在在文档中明确为进阶 / 实验路径
  - 生产接入建议默认使用会话级 API
- **文档同步更新**
  - README / GUIDE 导出表补充 incremental session 新导出与类型
  - 增量解析 wiki（中英）更新为 session-first 示例，并补充自适应策略、边界规则、fallback reason 对照
- 现有 `parseRichText` / `parseStructural` 等公共 API 无破坏性变更

- **增量更新栈安全：** `updateIncremental` 右侧 zone 复用的深拷贝 + 位置平移从递归实现改为显式栈迭代，深层嵌套文档更新时不再依赖 JS 调用栈深度
- **边界扩展防退化：** 为右侧边界稳定循环增加累计重解析字节预算；当扩窗累计成本超过阈值时自动回退为全量 `parseIncremental`，避免异常场景下的过度反复扩窗
- **内部重构：** 合并 `inline/raw/block` 子节点平移中的重复流程为共享逻辑，减少重复代码并保持现有对外行为与错误语义不变
- 无公共 API 变化
- 对正常 `parseRichText` / `parseStructural` 使用者来说，没有预期中的输出格式变化

### 1.2.0

- **新功能：增量结构化解析 (Incremental Structural Parsing)**
  - 引入 `parseIncremental`、`updateIncremental` 和 `tryUpdateIncremental` API，为实时编辑器等高频更新场景提供结构化解析的高性能方案
  - 通过仅重解析一个保守的“脏区”切片，并把左右未命中的 zones 拼回去，增量维护 `StructuralNode[]` / `Zone[]` 快照
  - **右侧复用：** 脏区右侧 zones 通过递归深拷贝 + 位置平移复用（纯数据对象语义；不引入 Proxy）
  - **性能权衡：** 大文档头部编辑时可能仍会付出 O(右侧子树大小) 的复制成本；对这类工作负载，全量重建有时反而更快
  - **边界稳定 (Boundary Stabilization)：** 算法会自动向右扩展脏区域直到解析状态稳定，确保在块合并或拆分等复杂场景下的解析正确性
  - **Result 模式：** `tryUpdateIncremental` 提供了类型安全的错误处理方式，可捕获编辑范围校验失败等异常情况（如 `INVALID_EDIT_RANGE`）
- **文档更新：** README / GUIDE 与 wiki 同步更新了 [增量解析](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E5%A2%9E%E9%87%8F%E8%A7%A3%E6%9E%90)（含边界约束、错误码与编辑器接入说明）
- **内部实现：** 新增 `src/incremental.ts` 核心逻辑及 `tests/incremental.test.ts` 单元测试覆盖
- 现有 `parseRichText` 或 `parseStructural` 等公共 API 无破坏性变更

### 1.1.10

- 性能：降低 malformed nested tag 头场景下的 block-boundary 最坏扫描开销。`findBlockClose` 现在在单次调用内同时缓存 inline close 边界查询和 tag arg close 查询，避免 block 内容中出现大量 malformed nested inline 头时反复扫描到 EOF
- 内部：为带缓存的 inline 边界扫描补充了显式同步说明，要求其 escape/head/end-tag 语义与 `scanInlineBoundary` 保持一致
- 内部：`findBlockClose` 改为惰性分配缓存，简单 block 路径不再无条件创建 `Map`
- 无公共 API 变化
- 对正常 `parseRichText` / `parseStructural` 使用者来说，没有预期中的输出格式变化

### 1.1.9

- 栈安全：`printStructural` 与 `mapTokens` 从原生递归改为显式栈迭代。至此，所有核心树处理与转换 API（包括解析、序列化、遍历、映射）均已完成栈安全转换，确保即使是极深层级（数万层）的树结构在处理时也不会有调用栈溢出风险
- 内部：重构了 `printNodes` 与 `mapTokens` 的逻辑，引入了更清晰的调度器与状态帧（Frame）以提升可维护性
- 无公共 API 变化
- 对正常 `printStructural` / `mapTokens` 使用者来说，没有预期中的行为或输出格式变化
- 性能：`resolveBaseOptions` 现在会检测 `options.tracker`，如果外部已提供则不再重复构建本地位置追踪器
- 性能：`materializedTailTokens` 移除了 `slice().flat()` 调用。针对单段内容走快速路径，多段内容使用 `for` 循环手动合并，减少临时数组分配
- 性能：`renderRawNode` 优化了原始块内容的行处理逻辑。使用 `charCodeAt` 预判首字符结合 `startsWith` 扫描替代 `split`/`join` 组合，实现零中间数组开销
- 性能：`materializeTextTokens` 增强了 Token 复用。当 `unescapeInline` 返回原字符串引用（即无转义）时，直接复用原 Token 对象而不进行对象展开（spread），降低堆内存压力
- 性能：`splitTokensByPipe` 引入快速路径。当不含 `escapeChar` 或 `tagDivider` 时直接推入原始 Token；在慢路径中若未发生切分，也尽可能复用原始 Token 引用
- 性能：`createEasyStableId` 默认指纹哈希从递归子树遍历改为迭代收集 + 自底向上哈希，并在生成器闭包内引入 `WeakMap<TextToken[], number>` 缓存（以 value 数组引用为键，该引用在 `TokenDraft` 与 `createToken` 的展开结果之间共享）。在正常自底向上的 `createToken` 流程中，子数组一定已被缓存，使单次 `hashDraft` 调用从 O(子树大小) 降为 O(type.length)；整个 parse 的总哈希开销从 O(N × 深度) 降为 O(N)。对手动构造的深层 `TokenDraft`，迭代收集器保证完全栈安全
- 无公共 API 变化
- 对正常 `parseRichText` / `parseStructural` 使用者来说，没有预期中的输出格式变化
- `createEasyStableId`（默认指纹）生成的 Stable ID 值因哈希缓存策略变更会与之前版本不同。相同输入产生相同输出的确定性和碰撞特性保持不变

### 1.1.8

- 栈安全：`walkTokens` 从原生递归改为显式栈迭代，与 `parseStructural` / `parseRichText` /
  `materializeTextTokens` 使用相同模式。深层 token 树（数万层级）遍历时不再有调用栈溢出风险
- 文档：新增**线性时间复杂度** wiki 专页
  （[EN](https://github.com/chiba233/yumeDSL/wiki/en-Linear-Time-Complexity) /
  [中文](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E7%BA%BF%E6%80%A7%E6%97%B6%E9%97%B4%E5%A4%8D%E6%9D%82%E5%BA%A6)），
  涵盖形式化上界证明（`T(n) ≤ C·n`）、最坏输入模型、单字符分支预算（_k_ ≈ 3–15）、经验常数
- 文档：README / GUIDE 补充了简要复杂度说明并链接到新 wiki 页
- 无公共 API 变化
- 对正常 `parseRichText` / `parseStructural` 使用者来说，没有预期中的输出格式变化

### 1.1.7

- 性能：render 层 `trimBlockBoundaryTokens` 不再对整个 children 数组做全量 clone，
  改为先检测首尾是否需要 trim，绝大多数情况直接返回原数组；需要时只 clone 被修改的 token
- 性能：structural 扫描 `flushBuffer` 对 1–2 对 segment 的常见情况直接字符串拼接，
  避免分配临时 parts 数组
- 修复：`trimBlockBoundaryTokens` 在空 collapse block 场景下的 `undefined` 崩溃——
  当唯一的 text token 被首部 trim 移除后，尾部 trim 没有检查数组是否为空
- 内部：`completeChild` 从 switch 改为 if/else，减少一层间接跳转
- 无公共 API 变化
- 对正常 `parseRichText` / `parseStructural` 使用者来说，没有预期中的输出格式变化

### 1.1.6

- 性能：`parseStructural` 热路径继续降常数
  - structural 扫描里的文本缓冲不再依赖反复字符串拼接
  - raw / block 子帧现在保存源码区间，不再提前切出中间字符串
- 兼容性说明：补齐了 `1.1.x` 各发布版的 `onError` 行为审计
  - `1.1.0` 和 `1.1.5` 一致
  - `1.1.1` 单独成组
  - `1.1.2` / `1.1.3` / `1.1.4` 三版完全一致，后续作为 `onError` 兼容性基线
- 无公共 API 变化
- 对正常 `parseRichText` / `parseStructural` 使用者来说，没有预期中的输出格式变化

### 1.1.5

- 优化：`parseStructural()` 不再先构建一棵内部 indexed tree，再通过 `_meta` 剥离生成第二棵 public
  tree。公开路径现在直接产出 `StructuralNode[]`
- 内部：public structural API 路径上的 `stripMetaForest` 转换阶段已经移除
- 内部：structural 扫描现在明确分成两条输出路径，不再共用一个带联合类型的热路径：
  internal 复用继续产出 `IndexedStructuralNode[]`，public API 直接产出 `StructuralNode[]`
- 清理：删除已无调用点的 `parseStructuralInternal`
- 基准：相对 `1.1.3`，同机（鲲鹏 920 / Node v24.14.0）下 structural parse 的内存占用有明确下降：
  - 200 KB dense inline 文档：parse 后 `heapUsed` 从 `56.72 MB` 降到 `45.52 MB`（约 `19.8%`）
  - 2 MB dense inline 文档：parse 后 `heapUsed` 从 `241.33 MB` 降到 `142.24 MB`（约 `41.1%`）
  - 20k nested inline 文档：parse 后 `heapUsed` 从 `68.02 MB` 降到 `62.93 MB`（约 `7.5%`）
- 无公共 API 变化
- 对正常 `parseStructural` 使用者来说，没有预期中的输出格式变化

一句话：这个补丁版把 public structural 路径上的“双树转换”彻底拿掉了，真实文档内存更低，
对外契约保持不变。

### 1.1.4

- 性能：`parseRichText` 现在会复用同一份基础配置解析结果，不再在进入 structural / render
  两条管线前重复 resolve 一次基础层
- 基准：200 KB 文档（鲲鹏 920 / Node v24.14.0）上，`parseRichText` 从 `1.1.3 ~27.4 ms`
  降到 `~22.6 ms`；`parseStructural` 从 `~19.3 ms` 降到 `~17.8 ms`
- 子字符串解析路径也重测了：`baseOffset` 和 `tracker` 两种场景相对 `1.1.3` 没有性能或位置语义回退
- 无公共 API 变化
- 对正常 `parseRichText` / `parseStructural` 使用者来说，没有预期中的输出格式变化
- 源码位置语义继续保持双轨：
  - `parseStructural.position` 仍然表示原始源码范围
  - `parseRichText.position` 仍然表示规范化后的渲染范围
- 新增了专门的回归测试，把“该不同的时候必须不同、该一致的时候仍然一致”锁死

一句话：这是一个补丁版性能更新。  
对用户最直接的价值是热路径更省、子串位置追踪没回退，同时公开契约不变。

### 1.1.3

- 延续 1.1.2 的深嵌套工作：1.1.2 已经消除的三个独立瓶颈在 1.1.3 中仍然保持消除状态；
  这次主要继续处理 public `parseStructural` 路径上剩余的内存峰值问题
- 优化：public `parseStructural` 的深嵌套内存画像 —— `stripMeta` 不再为整棵树构建
  `Map<IndexedStructuralNode, StructuralNode>`，改为迭代式父容器回填，直接产出 public forest，
  降低用户可见 API 路径上的峰值开销
- 基准：public `parseStructural(50000000)` 可完成，鲲鹏 920 / Node v24.14.0 实测 **~224.1 s**
- 文档：README / GUIDE / wiki 性能页从旧的 1000 万层 / internal 限制口径更新为新的
  5000 万层 public API 基准，并补充堆内存预算说明

### 1.1.2

- 修复：深层嵌套爆栈——`parseNodes`、`renderNodes`、`stripMeta`、`extractText`、
  `materializeTextTokens` 从递归改为显式栈迭代，嵌套深度仅受堆内存限制
  （1.1.1 在 ~1200–1800 层即爆栈）
- 优化：深嵌套 O(n)——5000 层 `parseRichText` 从 1.1.1 ~17 s 降至 **~23 ms**（~740 倍）。
  消除三个独立的 O(n²) 瓶颈：
    - `materializeTextTokens` 重复遍历：`WeakSet` 标记已处理子树，后续调用直接跳过
    - `findInlineClose` 前扫：inline 子帧改为 lazy close——在父帧 text 上继续扫描，
      通过 `parenDepth` 追踪裸括号深度，在匹配 `)` 处判定真实 form
      （`)$$` / `)%` / `)*`），不再预扫
    - `findTagArgClose`：inline 子帧内的嵌套标签直接 push 子帧，跳过 `getTagCloserType`，
      避免每层 O(n) 的 arg-close 扫描
- 内部：`parseNodes` 用显式 `ReturnKind` 分发（`completeChild`）替代所有 `resume` 闭包，
  帧完成逻辑集中在一个 switch 里
- 测试：新增 `[Edge/Depth]` 用例——2000 层 inline 嵌套 + `depthLimit: 3000`，
  验证 `parseStructural` 和 `parseRichText` 均可正常完成，不会爆栈

### 1.1.1

- 架构：`parseRichText` 内部从单遍字符扫描重构为"结构解析 → 渲染遍历"两阶段管线。
  旧版单遍扫描设计优雅简洁，是值得骄傲的工程作品——但在深层嵌套 block 标签上存在 O(n²)
  重复扫描，大文档性能无法接受，不得不忍痛重写
- 性能：200 KB `parseRichText` ~4400 ms → ~33 ms（提升 ~133 倍），与 `parseStructural`（~29 ms）
  几乎持平
- 内部文件整理：`complex.ts` 删除；`consumers.ts` / `context.ts` 合并至其他模块后删除；
  新增 `render.ts`
- 修复：移除 `parseRichText` 对 complex form 标签的 4 个伪 `INLINE_NOT_CLOSED` 错误上报
- 改进：`parseStructural` 新增 6 个错误上报点（`INLINE_NOT_CLOSED` / `BLOCK_NOT_CLOSED`）
- 修复：`tryConsumeEscape` 现在使用 `startsWith` 代替单字符比较来匹配转义字符。
  之前自定义多字符 `escapeChar` 时转义处理会静默失效。默认单字符 `\` 不受影响

### 1.1.0

- 新增：`NarrowToken<TType, TExtra?>` —— 把 `TextToken` 收窄为特定 `type` 字面量 + 已知额外字段的子类型，
  从 index signature 中恢复类型安全
- 新增：`NarrowDraft<TType, TExtra?>` —— 同理收窄 `TokenDraft`，用于 handler 返回类型标注
- 新增：`NarrowTokenUnion<TMap>` —— 从 token map 批量生成 `NarrowToken` 判别联合
- 新增：`createTokenGuard<TMap>()` —— 运行时类型守卫工厂，在 `if` 分支中按 `type` 键收窄 `TextToken`，
  TypeScript 自动推导额外字段
- 新增：`Parser.print()` 现在接受可选的 `PrintOptions` 覆盖 —— syntax 与 defaults 深合并，
  与 `parse()` / `structural()` 的 per-call override 行为一致。此前 `print` 始终绑定 `defaults.syntax`，
  使用 syntax override 解析后 round-trip 会输出错误语法
- 修复：`deriveBlockTags` / `resolveBlockTags` 参数类型从 `Record<string, unknown>` 收窄为
  `Record<string, TagHandler>`，消除了不安全的 `as Record<string, unknown>` 类型断言
- 优化：`unescapeInline` 性能 —— 批量 `slice()` 非转义区间代替逐字符 `readEscaped()` 调用；
  无转义时直接返回原字符串（零分配）
- 优化：`extractText` 性能 —— `string[]` + `join("")` 代替递归 `+=`
- 优化：`splitTokensByPipe` 性能 —— 追踪 run 起点代替逐字符 `buffer +=`
- 内部：`TagStartInfo.inlineContentStart` 更名为 `argStart`（内部类型，不影响公共 API）

### 1.0.15

- 新增：`buildZones(nodes)` — 将带 `trackPositions: true` 的 `StructuralNode[]` 分组为连续的 `Zone[]`。
  相邻 text / escape / separator / inline 节点合并为一个 zone；每个 raw 或 block 节点独占一个 zone。
  适用于编辑器中的 zone 级缓存
- 新增：导出 `Zone` 类型
- 修复：block / raw 标签内容不再包含 `*end$$` / `%end$$` 前面的结构性尾部 `\n`。这个换行是语法要求
  （closer 必须独占一行），不是内容。此前 `$$note()*\ncontent\n*end$$` 产出 `"content\n"`，
  现在产出 `"content"`。连续 block 标签之间不再出现多余空行
- 改进：`buildZones()` 在节点缺少 `position` 时（忘记开启 `trackPositions: true`）抛出明确错误，
  不再静默返回空数组
- 测试：8 个 zone 测试用例（分组、breaker 隔离、边界对齐、覆盖、空输入、无 position 报错、类型 smoke）；
  dist smoke 和类型断言新增 `buildZones` / `Zone` 导出覆盖（ESM + CJS）
- 文档：
    - README / GUIDE：特性列表新增 200 KB 基准数据、在线演示链接、导出表更新
    - 源码位置追踪 wiki：基准数据更新为 200 KB，新增 `parseSlice` 章节含实测数据（中英双语）
    - 稳定 Token ID wiki：新增 `createEasyStableId` 性能章节（中英双语）
    - token-walker README：新增 `parseSlice` 性能章节含 wiki 链接（中英双语）

### 1.0.14

- `declareMultilineTags` 新增 `"inline"` 形式支持——剥掉 inline close `$$` 后紧跟的 `\n`，
  适用于虽然用 inline 语法但渲染为块级元素的标签（如 `$$center(...)$$`）
- 传**字符串**给 `declareMultilineTags` 现在启用三种形式全部规范化（raw + block + inline）。
  对象形式不写 `forms` 时仍默认 `["raw", "block"]`，保持向后兼容
- `MultilineForm` 类型扩展为 `"raw" | "block" | "inline"`（现在是 `TagForm` 的别名）
- inline 规范化**永远不会自动推导**——必须通过 `blockTags` 显式声明
- 文档：README、GUIDE 及 wiki 各页面的 `declareMultilineTags` 章节全面升格，
  补充问题说明、per-form 表格、自动推导规则和最佳实践

### 1.0.13

- 文档
    - README / GUIDE 介绍区新增 Vue 3 和 React 渲染代码片段——新用户无需滚动即可看到渲染方式
    - 新增 [Wiki](https://github.com/chiba233/yumeDSL/wiki/)，包含完整 API 文档、处理器工具函数详解，
      以及三篇手把手实战教程：
        - [从零实现 link 标签](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-link-%E6%A0%87%E7%AD%BE)
        - [游戏对话标签](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-%E6%B8%B8%E6%88%8F%E5%AF%B9%E8%AF%9D)
        - [安全 UGC 聊天](https://github.com/chiba233/yumeDSL/wiki/zh-CN-%E6%95%99%E7%A8%8B-%E5%AE%89%E5%85%A8UGC)
    - 新增 [React 渲染](https://github.com/chiba233/yumeDSL/wiki/zh-CN-React-%E6%B8%B2%E6%9F%93) wiki 页面——
      递归组件、`useMemo` 集成、Material UI / Ant Design / 语法高亮示例
    - Vue 3 渲染 demo 从 README 迁移至
      [Wiki](https://github.com/chiba233/yumeDSL/wiki/zh-CN-Vue-3-%E6%B8%B2%E6%9F%93)——README 改为链接引导
    - 删除 README / GUIDE 中的目录（已被 wiki 导航替代）
    - README / GUIDE 顶部徽章区新增 Wiki 徽章
    - 处理器工具函数、导出一览、错误处理、安全策略章节新增 wiki 交叉引用链接

### 1.0.12

- 新增结构打印 API：
    - `printStructural(nodes, options?)` — 无损序列化器，始终打印完整 tag 语法
    - `PrintOptions` 接受 `syntax` 覆盖，用于自定义语法的往返序列化
    - 支持往返序列化：当使用相同的 syntax 时，
      `printStructural(parseStructural(input)) === input` 对良好输入成立
- `createParser` 现在返回 `print(nodes)` 方法，自动继承闭包中的 `syntax`

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
