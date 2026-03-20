# ClawDrive for VS Code

ClawDrive is the VS Code agent bridge for OpenClaw.

This repository is a clean-room restart for a new VS Code extension that lets OpenClaw drive IDE-native AI agent workflows through natural language.

Chinese version:
- [README.md](README.md)

## Status

Phase 1 now has a real end-to-end thin slice running locally:

`OpenClaw -> Gateway -> ClawDrive -> vscode.workspace.info -> Gateway result`

What exists now:

- a minimal VS Code extension runtime
- Gateway connect / disconnect flow
- signed device identity handshake with legacy identity reuse
- a minimal advertised command surface with `vscode.workspace.info`
- dashboard and settings UI
- output logging, status bar state, and connection diagnosis commands

What does not exist yet:

- the broader read-only command set
- security foundations beyond this slice
- provider adapters such as Codex or Claude
- task orchestration, resume, waiting-state, and natural-language routing

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

Phase 1 only proves node transport and the first callable command.
It does not yet prove the full natural-language task system described in the longer design documents.

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

## Phase 1 Commands

Current local commands:

- `ClawDrive: Dashboard`
- `ClawDrive: Settings`
- `ClawDrive: Connect`
- `ClawDrive: Disconnect`
- `ClawDrive: Show Status`
- `ClawDrive: Diagnose Connection`

Current remote command surface:

- `vscode.workspace.info`

Current payload shape:

- `name: string | null`
- `rootPath: string | null`
- `folders: string[]`

## Phase 1 Setup

Required settings:

- `clawdrive.gateway.host`
- `clawdrive.gateway.port`
- `clawdrive.gateway.token`

Recommended local defaults for an existing OpenClaw installation:

- `clawdrive.gateway.host = 127.0.0.1`
- `clawdrive.gateway.port = 18789`
- `clawdrive.gateway.tls = false`

If your Gateway uses `gateway.nodes.allowCommands`, make sure it includes:

- `vscode.workspace.info`

## Quick Test

1. Start your local OpenClaw Gateway.
2. Configure the ClawDrive Gateway settings in VS Code.
3. Run `ClawDrive: Dashboard`.
4. Open `Settings` from the dashboard and save the Gateway configuration.
5. Use `Connect` from the dashboard.
6. Run `ClawDrive: Diagnose Connection` if the node does not appear callable.
7. From OpenClaw, invoke `vscode.workspace.info`.

Expected ClawDrive log evidence:

- `Connected to Gateway`
- `invoke request: vscode.workspace.info`
- `invoke result: vscode.workspace.info ok=true`

This path has been verified locally.

## Important Compatibility Note

Gateway pairing is sensitive to device identity compatibility.

ClawDrive therefore needs to:

- derive `deviceId` from the Ed25519 public key fingerprint
- reuse the legacy `~/.openclaw-vscode/device.json` identity when available

If that compatibility is broken, the observed failure mode is:

- `Connect rejected: device identity mismatch`

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
