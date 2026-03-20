# ClawDrive for VS Code

ClawDrive 是 OpenClaw 的 VS Code agent bridge。

这是一个全新的 clean-room 重写仓库，目标是构建一个 VS Code 扩展，让 OpenClaw 可以通过自然语言驱动 VS Code 内的 IDE-native AI agent 工作流。

English version:
- [README.en.md](README.en.md)

## 当前状态

当前仓库还处于 bootstrap 阶段。

已经具备：

- 新项目的产品与协议规格文档
- 最小可编译的 VS Code 扩展骨架
- 已确定的命名、许可证与开发规则

尚未完成：

- 完整的 Gateway 连接运行时
- 完整的 `vscode.*` 能力面
- Codex 等 provider 适配层
- 统一任务编排、恢复、决策流

## 项目定位

这个项目的目标不是单纯做“远程命令调用”。

核心目标是：

- OpenClaw 用自然语言表达需求
- ClawDrive 将意图路由到 VS Code 内部能力或 provider-backed task
- 用户默认不需要记 raw `vscode.*` 命令、`taskId` 或 provider session
- 长任务通过统一任务模型执行
- 进度、等待决策、结果、失败都以人类可读方式反馈

第一阶段可以先实现 Codex。
但架构上不能把产品永久绑定到 Codex，后续应能支持 Claude 等其他 provider。

## 命名约定

- 产品名：`ClawDrive`
- 扩展显示名：`ClawDrive for VS Code`
- 仓库名：`clawdrive-vscode`
- 包名：`clawdrive-vscode`
- 扩展 ID：`wangtuo.clawdrive-vscode`
- 配置前缀：`clawdrive`
- 命令前缀：`clawdrive.`

## 文档

核心文档：

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

说明：

- 当前仓库以中文 `README.md` 作为主入口文档
- `docs` 下大部分规格文档目前仍以英文为主
- 中文化会逐步补齐，但不会牺牲当前实现推进速度

## 本地开发

```powershell
npm install
npm run compile
```

然后在 VS Code 中打开这个目录，按 `F5` 启动 Extension Development Host。

## 参考边界

仅作为行为分析参考：

- `https://github.com/akwang10000/openclaw-vscode.git`

这个新仓库不应复制旧仓库的源码、测试、资源文件或说明文案。
