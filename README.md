# ClawDrive for VS Code

ClawDrive 是 OpenClaw 到 VS Code 的桥接扩展，用来把自然语言请求路由到 IDE 内的只读命令和 provider-backed 长任务。

English version:
- [README.en.md](README.en.md)

## 当前状态

仓库已经不再只是最早的 Phase 1 传输薄片。

当前已经打通并验证：

- Gateway 连接与设备身份复用
- 只读命令面：工作区、文件、目录、活动编辑器、诊断
- `vscode.agent.task.*` 长任务接口
- Codex CLI 首个 provider 适配器
- 任务快照与事件持久化
- `waiting_decision` / `interrupted` 恢复
- VS Code Activity View 最近任务列表
- 控制台、设置、诊断、状态栏、输出日志
- VS Code 启动后可选自动连接

已经验证通过的端到端链路：

- `OpenClaw -> Gateway -> ClawDrive -> vscode.workspace.info -> Gateway result`
- `OpenClaw -> vscode.agent.task.start -> Codex CLI provider -> task execution/result`
- `OpenClaw -> vscode.agent.route -> direct inspect/analyze/plan/continue routing`

## 当前已实现

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

当前自然语言路由行为：

- 简单 inspect 请求会直接落到只读命令
- 宽范围解释类请求会落到 `analyze`
- 要方案、要权衡、明确“先别改”的请求会落到 `plan`
- `继续` / `用推荐方案` 会优先命中最近任务
- 写入意图当前仍会被挡回 planning-first

当前任务状态：

- `queued`
- `running`
- `waiting_decision`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

## 当前未实现

- 写入型 `apply` 任务执行
- `vscode.file.write`、`vscode.file.edit` 等写命令
- 更完整的 lang、git、test、debug、terminal 命令族
- Codex CLI 之外的 provider
- 比当前 Activity View 更完整的任务时间线 UI

## 产品目标

项目目标不是单纯暴露远程命令。

目标是：

- 用户对 OpenClaw 说自然语言
- ClawDrive 负责把请求路由到合适的 IDE 路径
- 简单读取走直接只读命令
- 宽范围解释和规划走任务框架
- 返回给用户的是自然语言进度和结果，而不是协议细节
- provider 选择被收敛在稳定任务契约之后

## 操作路径

推荐流程：

1. 打开 `ClawDrive: Settings`
2. 配置 Gateway host / port / token 和 provider 相关设置
3. 保持“启动后自动连接 Gateway”为开启，除非你明确想手动连接
4. 保存设置，扩展会立即尝试连接
5. 如需查看状态，再打开 `ClawDrive: Dashboard`

控制台现在只保留必要操作：

- 连接或重连
- 打开设置
- 运行诊断

断开连接、详细状态等高级操作仍然可以从命令面板进入。

如果 Gateway 启用了 `gateway.nodes.allowCommands`，升级后还需要同步放行新增命令。

当前阶段建议至少允许这些命令：

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

## 兼容性说明

Gateway 配对对设备身份兼容性比较敏感。

ClawDrive 当前需要：

- 从 Ed25519 公钥指纹派生 `deviceId`
- 优先复用旧的 `~/.openclaw-vscode/device.json`

如果这里不兼容，常见报错是：

- `Connect rejected: device identity mismatch`

当前长任务依赖本机可运行的 Codex CLI。

这一层已经处理过的典型问题包括：

- 可执行文件找不到
- provider 未启用
- CLI 参数位置不兼容
- 只读分析时的 policy / 环境摩擦

## 文档

- [docs/03-command-surface.md](docs/03-command-surface.md)
- [docs/06-intent-routing.md](docs/06-intent-routing.md)
- [docs/07-validation-goals.md](docs/07-validation-goals.md)
- [docs/08-task-semantics.md](docs/08-task-semantics.md)
- [docs/09-operator-setup-and-diagnosis.md](docs/09-operator-setup-and-diagnosis.md)
- [docs/10-natural-language-calling.md](docs/10-natural-language-calling.md)
- [docs/10-natural-language-calling.zh-CN.md](docs/10-natural-language-calling.zh-CN.md)

## 本地开发

```powershell
npm install
npm run compile
```

然后在 VS Code 里打开这个目录，按 `F5` 启动 Extension Development Host。

## 参考边界

仅用于行为分析参考：

- `https://github.com/akwang10000/openclaw-vscode.git`

本仓库不应复制参考仓库中的源码、测试、资源文件或文案。
