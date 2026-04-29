# Task Semantics

## Purpose

The task layer is the execution backbone of ClawDrive.

It is the contract that keeps OpenClaw, the VS Code extension, and future providers aligned on:

- lifecycle
- persistence
- resume behavior
- approval behavior
- result reporting

## Stable Task Concepts

Each long-running task has:

- one `taskId`
- one `mode`
- one stable lifecycle
- one execution-health layer
- resumable turns rather than one opaque provider run
- decision and approval pauses as explicit states

## Current Modes

The current implementation exposes:

- `analyze`
- `plan`
- `apply`

Canonical internal modes remain those three.
For direct `vscode.agent.task.start` callers, the command layer also accepts compatibility aliases:

- `ask`, `chat`, `analysis`, `analyse` -> `analyze`
- `edit` -> `apply`

Meaning:

- `analyze`: repository understanding, explanation, comparison, summary
- `plan`: options, tradeoffs, recommended direction, no file mutation
- `apply`: plan first, then explicit approval, then local structured mutation

## Lifecycle

Current states:

- `queued`
- `running`
- `waiting_decision`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

These states are intentionally distinct in storage, UI, and OpenClaw-facing reporting.

The current implementation also tracks execution health independently from lifecycle:

- `clean`
- `warning`
- `degraded`
- `failed`

This lets ClawDrive distinguish "completed with warnings" from true task failure.

## Turn Model

A task may span multiple turns.

Current behavior:

- the first turn starts from the original prompt
- later turns may continue after a user decision
- `apply` may continue again after explicit approval
- each turn may emit progress, output, a decision request, an approval request, a final result, or an error

## Apply Thin Slice

The current write path is intentionally narrow.

Provider responsibilities:

- analyze the request
- return 2 to 4 options for `apply`
- after a decision, return a structured approval payload
- do not write files directly

Local executor responsibilities:

- validate all target paths stay inside the workspace
- prevalidate the full operation batch
- apply supported operations
- attempt rollback on partial failure

Supported operations:

- `write_file`
- `replace_text`

Out of scope:

- delete
- rename
- arbitrary shell
- git
- test, debug, or formatter execution

## Queueing And Concurrency

The current implementation runs one active provider task at a time and queues later tasks behind it.

Direct synchronous read commands do not enter this queue.

## Persistence Requirements

Long-running tasks survive reconnect and normal restart boundaries.

Current guarantees:

- task snapshots are persisted
- event history is persisted
- runtime signal summaries are persisted on the snapshot
- terminal history is pruned by a limit
- a task that was `running` during shutdown is restored as `interrupted`
- a task that was `waiting_decision` or `waiting_approval` remains resumable after restart
- a task that was restored as `interrupted` remains resumable and is not treated as terminal history for pruning

## Decision Contract

The planning and apply paths can pause for a user decision.

Current rules:

- return 2 to 4 meaningful options when multiple directions exist
- mark exactly one recommended option when appropriate
- store the decision summary and option list on the task snapshot
- allow the user to continue by `optionId` or message

## Approval Contract

`apply` introduces a second explicit pause:

- `waiting_approval`

Current rules:

- selecting a plan option is not the same as approving writes
- `approval: "approved"` triggers local apply execution
- `approval: "rejected"` cancels the task without mutating files
- approval details remain visible in result history for auditability

## Recovery And Resume Rules

Current recovery behavior is defined in user-facing terms.

Rules:

- `continue` prefers the latest `waiting_decision`
- then the latest `interrupted`
- then the latest `running` or `queued`
- explicit approval or rejection phrases prefer the latest `waiting_approval`
- if multiple tasks are plausible at the same priority, routing should return a plain-language clarification list instead of guessing
- cancelling an active task should return only after the task settles into its post-abort state, normally `cancelled`

## Provider Reality

Architecture target:

- provider-neutral task model
- provider-neutral lifecycle
- provider-neutral OpenClaw-facing commands

Current reality:

- Codex CLI and Claude Code CLI are implemented providers
- Claude Code for VS Code handoff is a separate explicit route, not a background task provider

That is acceptable as long as the public task contract does not need redesign to add more providers later.

The current provider runtime model also distinguishes between:

- non-fatal runtime noise
- degraded-but-successful execution
- fatal execution failure

Those runtime signals are surfaced through task results and diagnosis without changing the core task lifecycle.

A task may therefore be:

- `completed` with `clean` health because the provider finished normally
- `completed` with `degraded` health because provider execution degraded and ClawDrive completed via bounded local fallback
- `failed` when the provider failure is terminal and no bounded completion path is allowed

