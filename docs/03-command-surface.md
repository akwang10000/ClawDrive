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
- `apply`

`apply` is intentionally narrow:

- the provider proposes options and then a structured approval payload
- local VS Code execution applies supported file operations only after explicit approval
- supported local operations are currently limited to `write_file` and `replace_text`

## Current Task States

The current repository uses these lifecycle states:

- `queued`
- `running`
- `waiting_decision`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

These states are persisted and also surfaced through the activity view and task APIs.

## Routing Split

The intended split for the current milestone is:

- normal natural-language entry -> `vscode.agent.route`
- simple inspect and query -> direct read-only commands
- explicit file, directory, and plugin-wiring inspection -> grounded local inspect summaries when possible
- broad explanation and multi-file understanding -> `analyze`
- options, tradeoffs, and "do not modify anything" -> `plan`
- write intent -> `apply` with decision and approval pauses

## Activity And Recovery Surface

The current repository also includes operator-side support for task execution:

- persisted task snapshots in extension global storage
- persisted event history
- one active provider-backed task at a time with FIFO queueing
- activity view actions for open result, continue, approve, reject, and cancel
- restart recovery where `running` becomes `interrupted`

## Current Provider Reality

The public task contract is provider-neutral.

The current implementation reality is:

- provider kinds: `codex`, `claude`
- runtimes: local Codex CLI executable and local Claude Code CLI executable
- readiness depends on enablement, executable discovery, and runnable CLI state
- Claude Code for VS Code handoff is separate from background task execution; it is an explicit handoff route, not a long-running task provider

This is acceptable for v1 as long as the public task API does not need to change to add or refine providers later.

## Not Implemented Yet

The following command families are still roadmap items, not current implementation:

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
- honest about grounded inspect coverage versus provider-backed analysis
- honest about the narrow `apply` slice and explicit approval requirement
- honest about Codex and Claude as implemented providers
- honest that `completed` may still be degraded when bounded local fallback is used
