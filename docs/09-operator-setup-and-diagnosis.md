# Operator Setup And Diagnosis

## Why This Matters

This product fails in practice if operators cannot tell:

- whether the node is connected
- whether commands are callable
- whether the selected provider is actually usable
- whether a task is queued, running, waiting, or failed

Setup and diagnosis are part of the core product surface, not optional tooling.

## State Layers

The current rewrite distinguishes these states:

- `connected`: the VS Code extension has an accepted Gateway session
- `callable`: the node is advertising a usable direct command surface
- `provider ready`: the selected provider is installed, enabled, and locally runnable
- task state: queued, running, waiting, completed, failed, cancelled, or interrupted

These states should not be collapsed into one generic "connected" label.

## Current Operator Surfaces

The current repository includes:

- `ClawDrive: Dashboard`
- `ClawDrive: Settings`
- `ClawDrive: Connect`
- `ClawDrive: Disconnect`
- `ClawDrive: Show Status`
- `ClawDrive: Diagnose Connection`
- `ClawDrive Activity` view
- `ClawDrive` output log

The dashboard is intentionally simplified to the essential actions:

- connect or reconnect
- open settings
- run diagnosis

Advanced actions remain in the command palette.

## First-Run Setup Goals

The first-run path should make these items explicit:

- Gateway host and port
- token or other required auth input
- Gateway TLS on or off
- whether startup should auto-connect
- display name and node identity
- provider enablement
- provider binary path or discovery
- model selection when applicable

These fields are currently exposed through the VS Code settings UI and the `ClawDrive: Settings` panel.

## Current Recommended Setup Flow

1. Open `ClawDrive: Settings`.
2. Fill in Gateway host, port, token, and TLS choice.
3. Leave auto-connect enabled unless you explicitly want manual connection.
4. Configure provider settings if you want task commands to work.
5. Save settings. The extension connects immediately.
6. Open `ClawDrive: Dashboard` only if you need to verify connection or run diagnosis.

## Common Failure Matrix

### Gateway Unreachable

Symptoms:

- cannot connect
- repeated reconnect loop

Recommended action:

- verify host and port
- verify the Gateway process is running
- verify local firewall or network path

### Token Missing Or Invalid

Symptoms:

- connect rejected
- node appears unauthorized

Recommended action:

- verify the configured token exists
- verify it matches the Gateway configuration

### Device Identity Mismatch

Symptoms:

- WebSocket opens successfully
- `connect` is rejected
- logs contain `device identity mismatch`

Recommended action:

- verify the node is using a compatible existing device identity
- verify `deviceId` is derived from the signing public key
- avoid silently generating a fresh unrelated identity when the Gateway already knows an older one

### Command Surface Empty Or Incomplete

Symptoms:

- node appears connected
- remote side cannot call expected read-only commands

Recommended action:

- verify the Gateway allowlist
- verify exact command-name matching
- compare the extension's advertised command inventory with the Gateway-visible one

### Provider Not Ready

Symptoms:

- task commands exist
- provider-backed execution fails immediately

Recommended action:

- verify the provider is enabled
- verify the provider binary or executable path
- verify the CLI can be launched locally
- verify the selected model or runtime is valid

### Provider Runtime Friction

Symptoms:

- tasks start but fail during execution
- errors mention missing executable, incompatible CLI arguments, or blocked shell behavior

Recommended action:

- verify the installed Codex CLI version
- verify executable discovery and argument compatibility
- verify read-only analysis is not assuming unavailable tools such as `rg`

## Diagnosis Rules

The operator experience should support these questions directly:

- why is the node disconnected
- why is the node connected but not callable
- why are task commands available but provider execution failing
- what is the current task waiting on

The system should answer them with short guidance first and deeper technical detail second.

## Verified Current Flow

The currently verified operator flow is:

1. Save Gateway and provider settings.
2. Let the extension auto-connect, or trigger connect manually.
3. Confirm `connected`, `callable`, and `provider ready`.
4. Trigger a direct read command such as `vscode.workspace.info`.
5. Trigger a long task through `vscode.agent.task.start`.
6. Confirm task progress or result from OpenClaw, the activity view, or the output log.
