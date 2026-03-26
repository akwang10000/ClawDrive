# 自然语言调用指南

## 用途

这份文档定义了当前阶段 OpenClaw 使用 `ClawDrive for VS Code` 的自然语言调用约定。

它主要面向操作人员、提示词编写者和集成方，而不是协议级调试。

## 公共入口

推荐入口：

- `vscode.agent.route`

输入：

- `prompt: string`
- `paths?: string[]`

通常只需要传自然语言 `prompt`，必要时再补充 `paths` 作为聚焦上下文。

## 意图分类

### 1. 读取与查询

示例：

- “读取 README，并总结安装步骤。”
- “读取 `package.json`，告诉我真实的 `main`、`activationEvents`、`contributes.commands` 值。”
- “列出 `src` 目录。”
- “看当前诊断。”

预期路由：

- 同步只读命令

当前补强：

- 像 `README.md`、`package.json`、`src/extension.ts` 这类显式路径，现在可以直接从 prompt 中推断，不必一定额外传 `paths`

### 1A. 基于真实文件的插件审计

示例：

- “读取 `package.json`，告诉我真实的 `main`、`activationEvents`、`contributes.commands` 值。”
- “检查这个插件的入口、激活事件和命令注册是否一致。”
- “读取 `src/extension.ts` 和 `out/extension.js`，确认构建产物和源码入口是否一致。”

预期路由：

- 本地只读读取 + 基于真实文件内容的总结

当前行为：

- 读取 `package.json`
- 检查常见源码入口，如 `src/extension.ts`
- 如果 `main` 指向构建产物，例如 `out/extension.js`，则继续读取该文件
- 对命令注册和构建入口一致性给出基于真实工作区内容的结论，而不是直接起 provider 任务

### 1B. 基于真实文件的多文件总结

示例：

- “读取 `README.md`，并总结安装步骤。”
- “比较 `package.json` 和 `src/extension.ts`。”
- “读取 `package.json`、`src/extension.ts`、`out/extension.js`，总结入口链路。”

预期路由：

- 本地同步读取最多四个显式文件，并直接给出总结

当前行为：

- 如果 prompt 明确提到 1 到 4 个文件，并要求总结、比较、确认或解释，router 会直接读取这些文件
- markdown 文件会按标题做总结
- 代码文件会尽量总结导出函数和 `registerCommand(...)`
- JSON 文件会总结关键字段或顶层键

### 1C. 基于真实目录的结构总结

示例：

- “总结一下 `src` 目录。”
- “看下 `src` 下面主要模块。”
- “看看 `docs` 里有什么并总结一下。”

预期路由：

- 先同步列目录，再少量读取代表文件做 grounded summary

当前行为：

- 如果 prompt 明确是在总结或检查一个目录，例如 `src`、`docs`
- router 会先列出目录内容
- 然后最多读取三个顶层代表文件，例如 `README.md`、`index.ts`、`extension.ts`、`package.json`
- 最终返回顶层目录结构和代表文件摘要，而不是起 provider 任务

### 1D. 仓库浅层结构总结

示例：

- “总结这个仓库的结构。”
- “看一下 `src`，解释主要模块。”
- “给我一个项目布局的快速概览。”

预期路由：

- 先做工作区根目录摘要，再对 1 到 2 个相关子目录做一级跟进

当前行为：

- 当 prompt 明确在问仓库结构、项目布局或主要模块时，router 先总结工作区根目录
- 然后最多继续查看 1 到 2 个相关子目录，例如 `src` 或 `docs`
- 每个子目录仍然保持浅层：一次列目录，加少量代表文件读取
- 如果请求已经超出浅层结构理解，仍然回退到 `analyze`

### 1E. 基于真实文件的主链路审计

示例：

- “解释一下 route、task service 和 provider 是怎么串起来的。”
- “给我看从 `vscode.agent.route` 到 provider 的主运行链路。”
- “解释一下本地 route-task-provider 主链路。”

预期路由：

- 同步读取一小组固定运行时文件，再给出 grounded summary

当前行为：

- router 会读取少量固定文件，例如 `src/extension.ts`、`src/commands/registry.ts`、`src/routing/service.ts`、`src/tasks/service.ts` 和 provider 文件
- 它会基于本地证据总结激活接线、命令面、route 分流、task 编排和 provider 契约
- 这条路径只用于解释明确的主链路问题，不替代更宽范围的 `analyze`

### 1F. 受限代码定位

示例：

- “`vscode.agent.route` 在哪里接线？”
- “哪个文件定义了 `TaskService`？”
- “`clawdrive.dashboard` 在哪里注册？”

预期路由：

- grounded inspect 内部的受限本地搜索

当前行为：

- 当 prompt 明确带有命令 id、符号名等稳定 token 时，router 可以先做一次受限本地定位
- 这个 helper 只扫描有限范围内的高概率文件和目录
- 它只作为 route 内部 grounding helper，不形成新的公开搜索命令

### 2. 分析与解释

示例：

- “解释一下这个仓库的结构。”
- “比较这两个模块。”
- “总结当前架构。”

预期路由：

- `analyze`

### 3. 规划与决策

示例：

- “给我两个实现方案。”
- “先规划一下。”
- “先别改，我来决定。”

预期路由：

- `plan`

### 4. 受控写入

示例：

- “修这个 bug。”
- “实现这个行为。”
- “修改 README。”

预期路由：

- `apply`

预期任务流：

- 启动 `apply`
- 返回方案并进入 `waiting_decision`
- 用户选定方案
- 返回结构化修改预览并进入 `waiting_approval`
- 用户显式批准或拒绝

### 5. 继续、批准、拒绝、诊断

示例：

- “继续。”
- “用推荐方案。”
- “批准执行。”
- “不要改了。”
- “为什么刚才失败了？”

预期路由：

- 无歧义时继续最近相关任务
- 批准与拒绝优先命中最近的 `waiting_approval`
- 状态与失败原因优先走同步诊断摘要

## 路由规则

按以下顺序理解请求：

1. 明确读取类请求优先走同步只读命令。
2. 明确在问插件入口、激活事件、命令注册、构建产物一致性的请求，优先走本地只读审计总结。
3. 明确在问仓库结构或主要模块时，优先走浅层 grounded summary，而不是直接起 `analyze`。
4. 明确在问 route、task、provider 主链路时，优先走本地主链路审计，而不是直接起 `analyze`。
5. 明确带有稳定 token 的代码定位问题，优先走受限本地定位，再决定是否升级到 `analyze`。
6. 宽范围解释类请求优先走 `analyze`。
7. 方案、权衡、“先别改”类请求优先走 `plan`。
8. 修复、实现、修改类请求优先走 `apply`。
9. “继续”优先命中最近相关任务，而不是重复新建任务。
10. “批准执行 / 拒绝执行”优先命中最近的 `waiting_approval`。
11. 状态与失败问题优先返回简短诊断摘要，除非调试需要才暴露协议细节。

## 当前继续优先级

普通 `continue` 优先级：

1. 最近的 `waiting_decision`
2. 最近的 `interrupted`
3. 最近的 `running`
4. 最近的 `queued`

显式批准或拒绝优先级：

1. 最近的 `waiting_approval`

如果同一优先级存在多个可疑任务，应返回简短澄清，而不是猜测。

## 当前写入规则

当前写入已不再是纯 planning-only，但范围仍然很窄。

当前行为：

- 写入意图进入 `apply`
- provider 先给方案，再给结构化修改提案
- 只有用户显式批准后，VS Code 本地执行层才真正写文件

当前仍不支持：

- delete
- rename
- 任意 shell 或 git 执行
- provider 直接写盘

## 回复风格

默认回复应当：

- 简短
- 自然
- 动作导向
- 除非调试需要，否则不主动暴露原始协议名

推荐表达：

- “我先检查当前工作区并给出总结。”
- “我整理了两个可行方向，你可以选一个。”
- “我正在等你批准这些文件修改后再执行。”

## 可直接使用的模板

### 读取

```text
读取当前 README，并总结安装步骤和当前限制。
```

### 基于真实文件的插件审计

```text
读取 package.json，告诉我真实的 main、activationEvents、contributes.commands，并确认 src/extension.ts 和 out/extension.js 是否一致。
```

### 代码定位

```text
`vscode.agent.route` 在哪里接线？
```

### 分析

```text
解释一下当前 Gateway 和任务编排流程是怎么工作的。
```

### 规划

```text
给我两个下一里程碑的实现方案，先别改。
```

### 写入

```text
修一个 README 的文案问题，但在改文件前先等我批准。
```

### 继续

```text
继续刚才那个任务，并使用推荐方案。
```

### 批准

```text
批准执行这些修改。
```

### 诊断

```text
为什么刚才那个 provider 任务失败了？
```

## 验收标准

这份指南成立时，应满足：

- 用户可以直接用自然语言描述目标
- 系统可以在 `inspect`、`analyze`、`plan`、`apply`、`continue`、`diagnose` 之间自动选择
- 正常流程不需要用户显式传 `taskId`
- 写入必须经过显式批准
- 进度和结果默认用自然语言表达
- 失败解释能优先指出真实阻塞层，例如 allowlist、provider readiness、CLI 兼容性或 transport/runtime 摩擦
