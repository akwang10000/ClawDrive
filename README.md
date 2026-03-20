# ClawDrive for VS Code

ClawDrive is the VS Code agent bridge for OpenClaw.

This repository is a clean-room restart for a new VS Code extension that lets OpenClaw drive IDE-native AI agent workflows through natural language.

## Status

This repository is currently in bootstrap phase.

What exists now:

- product and protocol specifications for the rewrite
- a minimal VS Code extension scaffold
- a stable naming baseline for the new implementation

What does not exist yet:

- the full Gateway runtime
- the full `vscode.*` command surface
- provider adapters such as Codex
- task orchestration and recovery flows

## Naming

- product name: `ClawDrive`
- extension display name: `ClawDrive for VS Code`
- repository name: `clawdrive-vscode`
- package name: `clawdrive-vscode`
- extension identifier: `wangtuo.clawdrive-vscode`
- configuration prefix: `clawdrive`
- command prefix: `clawdrive.`

## Product Goal

The primary goal is not just remote command execution.

The goal is:

- OpenClaw speaks to the IDE in natural language
- ClawDrive routes that intent into VS Code-native agent workflows
- progress and results come back in human-readable form
- provider choice stays behind a stable task contract

Codex can be the first provider.
Claude and other providers should be possible later without changing the user-facing workflow model.

## Documentation

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
