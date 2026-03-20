# Operator Setup And Diagnosis

## Why This Matters

This product fails in practice if operators cannot tell:

- whether the node is connected
- whether commands are callable
- whether the selected provider is actually usable

Setup and diagnosis are part of the core product surface, not optional tooling.

## State Layers

The rewrite should distinguish at least these states:

- `connected`: the VS Code extension has an accepted Gateway session
- `callable`: the node is advertising a usable command surface and the Gateway allowlist is not suppressing it
- `provider ready`: the selected provider is installed, enabled, authenticated, and locally runnable

These states should not be collapsed into one generic "connected" label.

## First-Run Setup Goals

The first-run path should make these items explicit:

- Gateway host and port
- token or other required auth input
- display name and node identity
- safe defaults for mutation policy
- provider enablement
- provider binary path or discovery
- model or provider-specific runtime selection when applicable

## Common Failure Matrix

The rewrite should document and diagnose these common failures:

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

### Command Surface Empty Or Incomplete

Symptoms:

- node appears connected
- remote side cannot call expected commands

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
- verify login or auth state if required
- verify the selected model or runtime is valid

## Diagnosis Rules

The operator experience should support these questions directly:

- why is the node disconnected
- why is the node connected but not callable
- why are task commands available but provider execution failing
- what is the current task waiting on

The system should answer them with short guidance first and deeper technical detail second.

## Local Versus Remote Diagnosis

The rewrite should preserve separate diagnosis paths for:

- local Gateway and local provider execution
- remote Gateway with local provider execution

The UI should make clear whether a failure is likely:

- transport-side
- allowlist-side
- provider-side
- task-state-side

## Minimum Operator Surfaces

The first usable release should include:

- connection status
- command-surface status
- provider readiness status
- a recent activity view
- a short diagnosis surface for common misconfiguration cases
