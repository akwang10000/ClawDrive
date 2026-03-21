# ClawDrive for VS Code

ClawDrive is the VS Code bridge that lets OpenClaw drive IDE-native workflows through a real Gateway session and a provider-backed task model.

Chinese version:
- [README.md](README.md)

## Current Status

The repository has moved beyond the original Phase 1 transport slice.

The current validated path now includes:

- Gateway connection and signed device identity reuse
- a read-only command surface for file, directory, editor, diagnostics, and workspace inspection
- provider-backed long tasks through `vscode.agent.task.*`
- Codex CLI as the first provider adapter
- persisted task snapshots and event history
- task recovery for `waiting_decision` and `interrupted`
- a VS Code activity view for recent tasks
- dashboard, settings, diagnosis, status bar, and output logging
- optional auto-connect on VS Code startup
- structured diagnosis for `connected`, `callable`, `provider ready`, and latest-task failure context
- automated regression coverage for routing, provider argument shaping, task recovery, and timeout handling

Validated end-to-end flows:

- `OpenClaw -> Gateway -> ClawDrive -> vscode.workspace.info -> Gateway result`
- `OpenClaw -> vscode.agent.task.start -> Codex CLI provider -> task execution/result`
- `OpenClaw -> vscode.agent.route -> direct inspect/analyze/plan/continue routing`

## What Exists Now

Implemented remote commands:

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

Implemented long-task modes:

- `analyze`
- `plan`

Current natural-language behavior:

- direct inspect requests can resolve synchronously through read-only commands
- broader explanation requests route to `analyze`
- option-seeking requests route to `plan`
- `continue` / `use the recommended option` resolve against recent tasks
- status and failure questions resolve through a synchronous diagnosis summary
- write intent is redirected back to planning

Current task states:

- `queued`
- `running`
- `waiting_decision`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

## What Is Not Implemented Yet

- write-capable `apply` task execution
- file mutation commands such as `vscode.file.write` or `vscode.file.edit`
- broader language, git, test, debug, and terminal command families
- providers beyond Codex CLI
- polished task timeline UI beyond the current activity list and result view

## Product Goal

The primary goal is not raw remote command execution.

The goal is:

- users speak to OpenClaw in normal language
- ClawDrive routes that request into the right IDE path
- simple inspection requests stay on direct read-only commands
- broader explanation and planning requests enter the task framework
- progress and results come back in human-readable form
- provider choice stays behind a stable task contract

## Operator Flow

Recommended setup:

1. Open `ClawDrive: Settings`.
2. Configure Gateway host, port, token, and provider settings.
3. Leave auto-connect enabled unless you explicitly want manual connection.
4. Save settings. The extension connects immediately.
5. If needed, open `ClawDrive: Dashboard` to inspect `connected`, `callable`, and `provider ready`.

The dashboard is intentionally reduced to the essential actions:

- connect or reconnect
- open settings
- run diagnosis

Advanced actions such as disconnect or detailed status remain available from the command palette.

If the Gateway uses `gateway.nodes.allowCommands`, you must also allow newly added commands after upgrades.

At the current milestone, the minimum recommended allowlist includes:

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

## Compatibility Notes

Gateway pairing is sensitive to device identity compatibility.

ClawDrive therefore needs to:

- derive `deviceId` from the Ed25519 public key fingerprint
- reuse the legacy `~/.openclaw-vscode/device.json` identity when available

If that compatibility is broken, the observed failure mode is:

- `Connect rejected: device identity mismatch`

Provider-backed tasks currently depend on a locally runnable Codex CLI.

Common provider failure modes now covered by the docs and diagnostics include:

- executable not found
- provider disabled
- incompatible CLI argument shape
- policy or environment friction during read-only analysis

## Documentation

- [docs/03-command-surface.md](docs/03-command-surface.md)
- [docs/06-intent-routing.md](docs/06-intent-routing.md)
- [docs/07-validation-goals.md](docs/07-validation-goals.md)
- [docs/08-task-semantics.md](docs/08-task-semantics.md)
- [docs/09-operator-setup-and-diagnosis.md](docs/09-operator-setup-and-diagnosis.md)
- [docs/10-natural-language-calling.md](docs/10-natural-language-calling.md)
- [docs/10-natural-language-calling.zh-CN.md](docs/10-natural-language-calling.zh-CN.md)

## Local Development

```powershell
npm install
npm run compile
```

Then open this folder in VS Code and press `F5` to launch the extension development host.

## Reference Boundary

Behavior analysis reference only:

- `https://github.com/akwang10000/openclaw-vscode.git`

This repository should not copy source code, tests, assets, or wording from that reference repository.
