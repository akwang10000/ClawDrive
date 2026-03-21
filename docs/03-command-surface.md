# Command Surface Summary

## Implemented Command Surface

The current repository exposes these stable remote commands:

### Natural-Language Entry

- `vscode.agent.route`

This is the preferred OpenClaw-facing entrypoint for ordinary prompts.
It classifies requests and then routes internally to either direct read-only commands or provider-backed task commands.

### Direct Read-Only Commands

- `vscode.workspace.info`
- `vscode.file.read`
- `vscode.dir.list`
- `vscode.editor.active`
- `vscode.diagnostics.get`

These are intended for narrow inspection and lightweight read flows.
They do not enter the task queue.

### Long-Running Task Commands

- `vscode.agent.task.start`
- `vscode.agent.task.status`
- `vscode.agent.task.list`
- `vscode.agent.task.respond`
- `vscode.agent.task.cancel`
- `vscode.agent.task.result`

These are the stable public task surface for provider-backed work.

## Current Task Modes

The current implementation supports:

- `analyze`
- `plan`

It does not currently expose write-capable `apply`.

If a request is clearly asking for code changes, the expected v1 behavior is:

- do not execute writes
- steer the request back into planning first

## Current Task States

The current repository uses these lifecycle states:

- `queued`
- `running`
- `waiting_decision`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

These states are persisted and also surfaced through the activity view and task APIs.

## Routing Split

The intended split for the current milestone is:

- normal natural-language entry -> `vscode.agent.route`
- simple inspect and query -> direct read-only commands
- broad explanation and multi-file understanding -> `analyze`
- options, tradeoffs, and "do not modify anything" -> `plan`
- write intent -> blocked in v1 and redirected toward planning

## Activity And Recovery Surface

The current repository also includes operator-side support for task execution:

- persisted task snapshots in extension global storage
- persisted event history
- one active provider-backed task at a time with FIFO queueing
- activity view actions for open result, continue, and cancel
- restart recovery where `running` becomes `interrupted`

## Current Provider Reality

The public task contract is provider-neutral.

The current implementation reality is:

- provider kind: `codex`
- runtime: local Codex CLI executable
- readiness depends on enablement, executable discovery, and runnable CLI state

This is acceptable for v1 as long as the public task API does not need to change to add another provider later.

## Not Implemented Yet

The following command families are still roadmap items, not current implementation:

- write-oriented file commands
- language intelligence commands
- git command family
- test command family
- debug command family
- terminal execution commands
- legacy `vscode.agent.*` expansion beyond setup and compatibility use

## Surface Honesty Rule

Docs for this repository should distinguish clearly between:

- what command names are already stable and callable
- what is implemented behind those names today
- what is still roadmap only

The current repository should be documented as:

- honest about direct read-only coverage
- honest about planning-only task execution
- honest about Codex CLI being the only implemented provider
