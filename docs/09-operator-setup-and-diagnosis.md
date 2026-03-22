# Operator Setup And Diagnosis

## Why This Matters

This product fails in practice if operators cannot tell:

- whether the node is connected
- whether commands are callable
- whether the selected provider is usable
- whether a task is queued, waiting, running, or failed
- whether a provider warning is fatal or only degraded noise

Setup and diagnosis are part of the product surface, not optional tooling.

## State Layers

The current rewrite distinguishes:

- `connected`: the VS Code extension has an accepted Gateway session
- `callable`: the Gateway allowlist and node command surface permit invocation
- `provider ready`: the configured provider is enabled and locally runnable
- task state: `queued`, `running`, `waiting_decision`, `waiting_approval`, `completed`, `failed`, `cancelled`, `interrupted`

These should not be collapsed into one generic "connected" label.

## Operator Surfaces

The current repository includes:

- `ClawDrive: Dashboard`
- `ClawDrive: Settings`
- `ClawDrive: Connect`
- `ClawDrive: Disconnect`
- `ClawDrive: Show Status`
- `ClawDrive: Diagnose Connection`
- `ClawDrive Activity`
- `ClawDrive` output log

The dashboard intentionally keeps only the most necessary actions:

- connect or reconnect
- open settings
- run diagnosis

## Recommended Setup Flow

1. Open `ClawDrive: Settings`.
2. Configure Gateway host, port, token, and TLS.
3. Leave auto-connect enabled unless manual connection is required.
4. Configure provider settings if you want long tasks or route-backed analysis/planning/apply.
5. Save settings and let the extension connect.
6. Use `Dashboard`, `Activity`, or `Diagnose Connection` only when you need verification or recovery.

If the Gateway uses `gateway.nodes.allowCommands`, keep the allowlist aligned with the extension command surface.

Minimum recommended allowlist:

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

- verify the node is using a compatible existing identity
- verify `deviceId` is derived from the signing public key
- avoid silently rotating to a fresh identity when the Gateway already knows the old one

### Command Surface Blocked By Allowlist

Symptoms:

- node appears connected
- advertised commands are visible
- `callable` is still blocked

Recommended action:

- verify the Gateway allowlist
- verify exact command-name matching
- compare the extension's advertised inventory with the allowlist

### Provider Not Ready

Symptoms:

- task commands exist
- provider-backed execution fails immediately

Recommended action:

- verify the provider is enabled
- verify executable discovery
- verify the Codex CLI can be launched locally
- verify the selected model or runtime is valid

### Provider Runtime Friction

Symptoms:

- tasks start but fail or degrade during execution
- errors mention missing executable, unsupported arguments, blocked shell probing, or transport errors

Recommended action:

- verify the installed Codex CLI version
- verify executable discovery and argument compatibility
- verify read-only analysis does not depend on unavailable tools
- verify provider execution is isolated from unrelated external MCP configuration

## Current Diagnosis Rules

The operator experience should answer these questions directly:

- why is the node disconnected
- why is the node connected but not callable
- why are task commands available but provider execution failing
- what is the current task waiting on
- whether the latest provider warning was fatal, degraded, or non-fatal noise

The system should answer with short guidance first and deeper technical detail second.

## Current Diagnosis Snapshot

Current diagnosis and status summaries are built around:

- `connected`
- `callable`
- `provider ready`
- latest task state
- latest failure summary
- actionable next hint

Recent hardening also keeps provider execution more isolated by:

- using a ClawDrive-specific `CODEX_HOME` for provider runs
- preserving local auth and model configuration
- stripping unrelated external MCP server configuration from provider execution

That isolation is intended to reduce downstream transport issues caused by unrelated personal Codex setup.

## Warning Reality

Provider execution may still emit helper, sandbox, or transport-layer warnings.

Current product expectation:

- the main user flow should succeed when the warning is non-fatal
- diagnosis should preserve the warning as evidence
- non-fatal stderr noise should not be treated as a hard user-facing failure by default

## Verified Current Flow

The currently verified operator flow is:

1. Save Gateway and provider settings.
2. Let the extension auto-connect, or connect manually.
3. Confirm `connected`, `callable`, and `provider ready`.
4. Trigger a direct read command such as `vscode.workspace.info`.
5. Trigger a routed request such as `vscode.agent.route`.
6. Observe task progress or result from OpenClaw, the activity view, or the output log.
