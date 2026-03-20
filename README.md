# ClawDrive for VS Code

ClawDrive 是 OpenClaw 的 VS Code 侧 agent bridge。

这个仓库是一个全新的 clean-room 重写项目，目标是让 OpenClaw 通过自然语言驱动 VS Code 内的 IDE-native agent 工作流，而不是只暴露一组原始远程命令。

English version:
- [README.en.md](README.en.md)

## 当前状态

当前已经完成 Phase 1 的最小可联调薄切片，并已在本地真实跑通：

`OpenClaw -> Gateway -> ClawDrive -> vscode.workspace.info -> Gateway 返回结果`

当前已实现：

- 最小可运行的 VS Code 扩展运行时
- Gateway `connect` / `disconnect` 链路
- 设备身份签名握手与旧身份兼容迁移
- 最小远程命令面 `vscode.workspace.info`
- Dashboard / Settings 图形界面
- 输出日志、状态栏、连接诊断

当前仍未实现：

- 更完整的只读命令集
- 文件修改类命令与安全基础设施
- Codex、Claude 等 provider 适配层
- 统一任务编排、恢复、等待决策与自然语言路由

## 核心目标

这个项目的目标不是“让 OpenClaw 能远程调用几个 VS Code API”。

核心目标是：

- 用户通过自然语言表达 IDE 任务
- OpenClaw 将请求路由到 VS Code 内的 agent 工作流
- 进度、等待、结果、失败以人类可读方式返回
- provider 被收敛在稳定任务契约之后，而不是暴露给最终用户

Phase 1 只证明最小节点接入链路。后续阶段才进入 read-only command set、security foundations、task framework，以及 Codex / Claude provider integration。

## 命名约定

- 产品名：`ClawDrive`
- 扩展显示名：`ClawDrive for VS Code`
- 仓库名：`clawdrive-vscode`
- 包名：`clawdrive-vscode`
- 扩展 ID：`wangtuo.clawdrive-vscode`
- 配置前缀：`clawdrive`
- 命令前缀：`clawdrive.`

## 文档

- [docs/01-product-scope.md](docs/01-product-scope.md)
- [docs/02-node-protocol.md](docs/02-node-protocol.md)
- [docs/03-command-surface.md](docs/03-command-surface.md)
- [docs/04-rewrite-roadmap.md](docs/04-rewrite-roadmap.md)
- [docs/05-cleanroom-rules.md](docs/05-cleanroom-rules.md)
- [docs/06-intent-routing.md](docs/06-intent-routing.md)
- [docs/07-validation-goals.md](docs/07-validation-goals.md)
- [docs/08-task-semantics.md](docs/08-task-semantics.md)
- [docs/09-operator-setup-and-diagnosis.md](docs/09-operator-setup-and-diagnosis.md)
- [docs/10-natural-language-calling.md](docs/10-natural-language-calling.md)
- [docs/10-natural-language-calling.zh-CN.md](docs/10-natural-language-calling.zh-CN.md)
- [docs/11-development-rules.md](docs/11-development-rules.md)

## Phase 1 当前能力

本地命令：

- `ClawDrive: Dashboard`
- `ClawDrive: Settings`
- `ClawDrive: Connect`
- `ClawDrive: Disconnect`
- `ClawDrive: Show Status`
- `ClawDrive: Diagnose Connection`

当前远程命令面：

- `vscode.workspace.info`

返回结构：

- `name: string | null`
- `rootPath: string | null`
- `folders: string[]`

## Phase 1 接入要求

必需配置：

- `clawdrive.gateway.host`
- `clawdrive.gateway.port`
- `clawdrive.gateway.token`

推荐的本地默认值：

- `clawdrive.gateway.host = 127.0.0.1`
- `clawdrive.gateway.port = 18789`
- `clawdrive.gateway.tls = false`
- `clawdrive.displayName = ClawDrive`

如果 Gateway 启用了 `gateway.nodes.allowCommands`，至少需要包含：

- `vscode.workspace.info`

## 最小测试路径

1. 启动本地 OpenClaw Gateway。
2. 在 VS Code 中运行 `ClawDrive: Dashboard`。
3. 打开 `Settings`，填入 Gateway host / port / token。
4. 回到 Dashboard，执行 `Connect`。
5. 如果连接异常，执行 `Diagnose` 并查看 `Open Log`。
6. 在 OpenClaw 侧发起 `vscode.workspace.info` 调用。
7. 确认 ClawDrive 日志中出现：
   - `Connected to Gateway`
   - `invoke request: vscode.workspace.info`
   - `invoke result: vscode.workspace.info ok=true`

这条路径已经在本地真实验证通过。

## 已验证结论

当前已确认：

- ClawDrive 可以在不修改 OpenClaw 源码的前提下接入现有 Gateway
- Dashboard / Settings 足以支撑 Phase 1 接入与排障
- 设备身份必须与旧链路兼容，否则 Gateway 会返回 `device identity mismatch`
- 修复身份算法并复用旧 `~/.openclaw-vscode/device.json` 后，连接与调用恢复正常

## 本地开发

```powershell
npm install
npm run compile
```

然后在 VS Code 中打开这个目录，按 `F5` 启动 Extension Development Host。

## 参考边界

仅用于行为分析参考：

- `https://github.com/akwang10000/openclaw-vscode.git`

本仓库不应复制参考仓库中的源代码、测试、资源文件或文案内容。
