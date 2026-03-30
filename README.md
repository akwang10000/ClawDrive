# ClawDrive for VS Code

ClawDrive 是 OpenClaw 到 VS Code 的桥接扩展，用来把自然语言请求路由到 IDE 内的只读命令、长任务框架和受控文件修改闭环。

English version:
- [README.en.md](README.en.md)

## 当前状态

当前仓库已经不再是早期的 Gateway 命令桥原型，已验证的主流程包括：

- Gateway 连接与设备身份复用
- 只读命令面：工作区、文件、目录、活动编辑器、诊断
- `vscode.agent.route` 自然语言入口
- `vscode.agent.task.*` 长任务接口
- Codex CLI 作为首个 provider
- 任务快照与事件持久化
- `waiting_decision` / `waiting_approval` / `interrupted` 恢复与继续
- VS Code `ClawDrive Activity` 任务视图
- `ClawDrive: Dashboard` 控制台，可查看最近任务并执行本地取消/删除
- `apply` 薄切片：结构化修改 + 显式批准 + 本地受控落盘

当前已经跑通的端到端链路：

- `OpenClaw -> Gateway -> ClawDrive -> vscode.workspace.info -> Gateway result`
- `OpenClaw -> vscode.agent.route -> inspect/analyze/plan/apply/continue`
- `OpenClaw -> vscode.agent.task.start/respond/result -> Codex CLI provider -> task lifecycle`
- `apply -> waiting_decision -> waiting_approval -> approved/rejected -> completed/cancelled`

## 当前公开能力

远程命令面：

- `vscode.agent.route`
- `vscode.workspace.info`
- `vscode.file.read`
- `vscode.dir.list`
- `vscode.editor.active`
- `vscode.diagnostics.get`
- `vscode.agent.task.start`
- `vscode.agent.task.status`
- `vscode.agent.task.list`
- `vscode.agent.task.respond`
- `vscode.agent.task.cancel`
- `vscode.agent.task.result`

当前长任务模式：

- `analyze`
- `plan`
- `apply`

当前任务状态：

- `queued`
- `running`
- `waiting_decision`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

## 当前自然语言行为

- 简单 inspect 请求继续走同步只读命令
- 宽范围解释类请求进入 `analyze`
- “给我两个方案 / 先别改 / 我来决定”进入 `plan`
- 修复、实现、修改类请求默认进入 `apply`
- “继续”优先命中最近等待或活动中的任务
- “批准执行 / reject / 不要改了”优先命中最近 `waiting_approval`
- 状态、失败原因、provider 就绪度问题可通过同步诊断返回摘要

## 当前写入边界

`apply` 当前只支持受控结构化修改：

- `write_file`
- `replace_text`

当前明确不支持：

- delete / rename
- 任意 shell
- git 操作
- test / debug / terminal / formatter 执行
- provider 直接写文件

真正写盘由 VS Code 本地执行层负责，包含：

- 工作区 containment 校验
- 批量预校验
- `replace_text` 唯一精确匹配
- 写入失败后的回滚尝试

## 运行与诊断说明

推荐操作路径：

1. 打开 `ClawDrive: Settings`
2. 配置 Gateway host / port / token 和 provider 相关设置（必要时调整 `clawdrive.provider.sandboxMode`）
3. 默认 auto-connect 是关闭的，除非你明确要启用它
4. 点击“保存并连接”会立即应用设置并连接；上面的 auto-connect 开关只影响后续启动时是否自动连接
5. 需要查看连接状态、最近任务或快速取消/删除时，打开 `ClawDrive: Dashboard`；需要更细的任务结果与事件时，再看 `ClawDrive Activity` 或 `ClawDrive` 输出

如果 Gateway 使用 `gateway.nodes.allowCommands`，升级后仍需同步放行新增命令。
当前至少应允许：

- `vscode.agent.route`
- `vscode.workspace.info`
- `vscode.file.read`
- `vscode.dir.list`
- `vscode.editor.active`
- `vscode.diagnostics.get`
- `vscode.agent.task.start`
- `vscode.agent.task.status`
- `vscode.agent.task.list`
- `vscode.agent.task.respond`
- `vscode.agent.task.cancel`
- `vscode.agent.task.result`

Dashboard 中的任务管理是扩展本地 UI 能力，不会新增远程 `vscode.agent.task.*` 命令。

当前 provider 运行还可能出现 helper、sandbox 或 transport 层告警。
现阶段的目标是：

- 主流程优先成功
- 非致命底层噪声尽量不阻断结果返回
- 诊断与日志尽量给出更明确的根因摘要

## 兼容性与 provider 备注

Gateway 配对对设备身份兼容性比较敏感。ClawDrive 当前会：

- 由 Ed25519 公钥指纹派生 `deviceId`
- 优先复用历史 `~/.openclaw-vscode/device.json`

Codex provider 当前依赖本地可运行的 Codex CLI。
已处理过的典型问题包括：

- 可执行文件找不到
- provider 未启用
- CLI 参数不兼容
- 只读分析中的 policy / 环境摩擦
- 外部 MCP 配置干扰 provider 执行

## 当前未实现

- 更广泛的语言服务、git、test、debug、terminal 命令面
- delete / rename 类写入操作
- provider 直接写盘
- 完整 diff viewer 或复杂 approval dashboard
- Codex CLI 之外的 provider

## 文档

- [docs/00-document-map.md](docs/00-document-map.md)
- [docs/03-command-surface.md](docs/03-command-surface.md)
- [docs/06-intent-routing.md](docs/06-intent-routing.md)
- [docs/07-validation-goals.md](docs/07-validation-goals.md)
- [docs/08-task-semantics.md](docs/08-task-semantics.md)
- [docs/09-operator-setup-and-diagnosis.md](docs/09-operator-setup-and-diagnosis.md)
- [docs/10-natural-language-calling.md](docs/10-natural-language-calling.md)
- [docs/10-natural-language-calling.zh-CN.md](docs/10-natural-language-calling.zh-CN.md)
- [docs/12-next-step-plan.md](docs/12-next-step-plan.md)

## 本地开发

```powershell
npm install
npm run compile
npm test
```

然后在 VS Code 中打开仓库并按 `F5` 启动 Extension Development Host。
