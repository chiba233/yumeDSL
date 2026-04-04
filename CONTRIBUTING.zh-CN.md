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

1. 从 `main` 创建分支：
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

- **禁止 `as any`**：优先修类型，不要绕过检查器
- **尽量避免 `any`**：只在明确边界且更窄类型已穷尽时使用
- **优先类型守卫和联合收窄**，少用断言
- **零运行时依赖**：`yume-dsl-rich-text` 设计上保持无运行时依赖，除非先和维护者讨论

## structural 解析器维护边界

`src/structural.ts` 已经不再是一个“小解析辅助文件”，它实际上更像一个解析状态机 / 虚拟机。
对这个文件做“大而全、行为不变”的重写，现实里很难安全 review。

- 触碰 `src/structural.ts` 的 PR 应尽量限制在 bug 修复、正确性修复、窄范围回归修复
- 不要提交这个文件的功能扩张、纯清理重构、架构重写，或“把 parser 写简单一点”的 PR，除非维护者事先明确要求
- 如果必须改它，请保持补丁最小，并附最小复现或回归测试

## 默认不建议外部直接贡献的区域

这个解析器已经到了“有些部分更像语言运行时，而不是普通业务代码”的阶段。
很多看起来只是“顺手清理一下”的改动，实际上会悄悄改变语义、时序或热路径性能。

除非维护者事先明确要求，否则默认不要直接提交以下类型的 PR：

- **解析热路径重写**
    - 包括 `src/structural.ts`、`src/parse.ts`、`src/render.ts`
    - 不要做架构重写、parser 简化、虚拟机改递归、纯风格重构
    - 不要做“这个 helper / 对象 / 闭包看起来更优雅”的改动，除非它绑定到一个明确 bug 且带测试
- **公开契约重塑**
    - 不要扩大 `StructuralParseOptions`
    - 不要把 `createId`、`blockTags`、`mode`、`onError` 这类渲染层字段搬进 structural API
    - 不要试图统一 `parseRichText.position` 和 `parseStructural.position`
- **性能敏感抽象改造**
    - 不要在主解析路径上新增包装层、便捷 helper、对象重组、额外遍历，除非有 benchmark 支撑
    - “JS API 更干净”本身，不足以构成触碰热路径的理由
- **仅清理 position / error 路由**
    - `baseOffset`、`tracker`、`_meta`、内部错误通道各自职责不同
    - 如果你动这里，PR 必须明确说明保住了哪条语义边界

这些区域不是“永远不能动”，而是“默认只接受维护者主导”，除非是明确 bug、明确回归、或维护者指定任务。

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
