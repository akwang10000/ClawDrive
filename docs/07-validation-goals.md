# Validation Goals

## Purpose

The rewrite needs explicit success criteria.

Without them, it is too easy to ship a node that can technically execute commands but still fails the actual product goal of letting OpenClaw drive IDE agents naturally inside VS Code.

## Phase 1 Slice Status

Phase 1 is intentionally narrower than the full product target.

The first thin slice is considered complete only when all of these are true:

- the VS Code extension reaches `connected` against a real Gateway
- the node advertises `vscode.workspace.info`
- OpenClaw can invoke `vscode.workspace.info` through the Gateway
- ClawDrive returns a successful structured result
- the operator can confirm the flow from Dashboard, diagnosis output, and logs

That thin slice has now been validated locally.

## Product-Level Acceptance

The rewrite should not be considered successful until all of these are true.

### Natural-Language Entry

- a user can ask for inspection, analysis, planning, continuation, or implementation in ordinary language
- normal use does not require the user to type raw `vscode.*` commands
- normal use does not require the user to know task IDs or provider session IDs

### IDE Agent Routing

- OpenClaw requests can be routed into VS Code task execution through one stable task contract
- the first provider can be Codex
- later providers such as Claude can be added without changing the user-facing workflow shape

### Human-Readable Progress

- queued, running, waiting, completed, failed, cancelled, and interrupted states are distinguishable
- progress text is understandable without reading provider event internals
- waiting-for-decision states show what choice is needed and which option is recommended

### Safe Mutation

- broad write requests do not silently jump into uncontrolled execution
- read-only analysis remains available before mutation
- mutation policy and workspace containment still apply even when the task begins from natural language

## Minimum End-To-End Scenarios

The new repository should pass these end-to-end checks.

### Scenario 1: Inspect

User goal:

- ask what workspace is open or ask to read a file

Expected result:

- the system completes the request through read-only capability
- the reply is phrased as assistant help, not protocol output

### Scenario 2: Analyze

User goal:

- ask for an explanation of how part of the project works

Expected result:

- the system performs multi-file inspection as needed
- the answer returns as a readable explanation
- no write path is entered

### Scenario 3: Plan

User goal:

- ask for two implementation directions and explicitly defer changes

Expected result:

- the system enters planning behavior
- at least one recommended option is surfaced
- the task can pause and resume cleanly after a user decision

### Scenario 4: Apply

User goal:

- ask to implement the chosen plan

Expected result:

- the system enters write-capable task execution
- progress remains readable
- the final answer summarizes what changed and whether any follow-up is needed

### Scenario 5: Continue

User goal:

- say "continue", "keep going", or "use the recommended option"

Expected result:

- the system resolves the correct active or waiting task when unambiguous
- it does not require raw lifecycle commands for the common case

### Scenario 6: Failure And Recovery

User goal:

- understand why a task failed or timed out

Expected result:

- the user gets a short explanation
- timeout, cancellation, interruption, and execution failure are not collapsed into one generic error
- the system can either resume, retry, or explain why not

## Operator Validation

These checks matter even if the user never sees them directly.

- the command surface advertised by the node matches the implementation that actually exists
- task storage, event emission, and activity summaries stay consistent across restart and reconnect
- provider-specific failures are translated into stable task states
- route decisions can be reasoned about during debugging

## Phase 1 Evidence

The current repository now has direct evidence for the minimum connection path:

- Dashboard-triggered connect succeeds
- diagnosis reports `connected` and `callable`
- ClawDrive logs show:
  - `Connected to Gateway`
  - `invoke request: vscode.workspace.info`
  - `invoke result: vscode.workspace.info ok=true`

This is enough to close the transport-side Phase 1 slice.
It is not enough to claim that the full natural-language product goal is complete.

## Scope Guard

If a build only proves:

- WebSocket connectivity
- remote invocation
- a growing `vscode.*` list

but it does not prove natural-language-driven assistant behavior, it is not yet at the target product bar.
