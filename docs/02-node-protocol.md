# Node Protocol Summary

## Connection Model

The current behavior implies a Gateway-backed node connection over WebSocket.

The new implementation should assume:

- the extension connects to a Gateway host and port
- the transport uses protocol version `3`
- the node advertises a display name, version, capabilities, and exposed commands
- the node can authenticate with a token and device identity signature

## Connect Flow

The new repository should support this sequence:

1. Open a WebSocket connection to the Gateway.
2. Wait briefly for an optional `connect.challenge` event.
3. If a challenge nonce arrives, sign the connect payload with the device identity.
4. Send a `connect` request containing:
   - min/max protocol version
   - client identity
   - capabilities
   - command inventory
   - token auth when configured
   - signed device identity
5. Transition to `connected` only after the Gateway accepts the node.

Phase 1 implementation note:

- this flow is now implemented and verified against a real local Gateway
- the first accepted command surface is intentionally limited to `vscode.workspace.info`

Operational note:

- the command inventory advertised at connect time must match the command list the node is actually willing to execute
- if the Gateway allowlist is too narrow or does not exact-match command names, the node may appear connected while exposing an unexpectedly small or empty command set

## Device Identity Compatibility

The device identity rules are not optional details.
They are part of whether a node can connect at all.

The current implementation should assume:

- the signing key is Ed25519
- `device.id` must be derived from the public key, not generated as an unrelated UUID
- compatibility with an existing local VS Code node identity matters in practice

For the current local environment, the safe rule is:

1. Prefer reusing an existing `~/.openclaw-vscode/device.json` identity when it exists.
2. Derive `deviceId` from the raw Ed25519 public key fingerprint.
3. Persist the normalized identity into the current extension storage.

Observed failure mode when this is wrong:

- the Gateway rejects `connect` with `device identity mismatch`

## Runtime Frames

The current repository behavior implies two important frame classes:

- event frames
- response frames

The new implementation should at minimum handle:

- `connect.challenge`
- `node.invoke.request`
- normal request responses
- accepted/acknowledged async responses

## Invoke Model

When the Gateway emits `node.invoke.request`, the extension should:

1. Parse the target command.
2. Decode params JSON when present.
3. Dispatch to the registered handler.
4. Return either:
   - `{ ok: true, payload }`
   - `{ ok: false, error: { code, message } }`

## Timeouts

There are two separate timeout concerns:

- Gateway request timeout
- command execution timeout

The new repository should preserve both layers and keep them distinct in code and error reporting.
If the caller requests a shorter execution limit, the runtime may honor that shorter limit without erasing the distinction between transport timeout and local execution timeout.

## Node Event Emission

The old repository emits node-side events for agent task lifecycle changes.

The rewrite should support emitting structured lifecycle events for:

- task started
- task resumed
- task progress
- task output
- task waiting for decision
- task completed
- task failed
- task cancelled

## Reimplementation Rule

This document captures protocol behavior only.
It is not permission to copy transport code, request framing code, or legacy naming directly from the current repository.
