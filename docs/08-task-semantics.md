# Task Semantics

## Purpose

The task layer is the real execution backbone of this product.

It is not enough to document "start a provider and get text back".
The rewrite needs an explicit task contract so OpenClaw, the extension, and future providers all agree on the same lifecycle.

## Stable Task Concepts

The task model should preserve these concepts:

- one task identifier per long-running unit of work
- a task mode such as inspect-like analysis, planning, or write-capable execution
- one stable lifecycle that OpenClaw can observe
- resumable turns rather than one opaque provider run
- decision pauses as first-class task states

## Lifecycle Requirements

The rewrite should preserve these distinct states:

- `queued`
- `running`
- `waiting_decision`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

These states must stay distinct in storage, UI, and OpenClaw-facing reporting.
Timeout, user cancellation, provider failure, and IDE restart are not the same event.

## Turn Model

A task should be able to span multiple turns.

Minimum behavior:

- the first turn starts from the original user request
- later turns may continue after a user decision
- each turn can produce progress, output, a decision request, a final result, or an error

This is especially important for plan-then-apply workflows.

## Queueing And Concurrency

The current implementation runs one active provider task at a time and queues later tasks behind it.

The rewrite may keep or revise that rule, but it should decide explicitly and document it.

If the first release keeps single-active-task behavior, the docs should say so plainly.

## Persistence Requirements

Long-running tasks should survive normal reconnect boundaries.

Minimum expectations:

- task snapshots are persisted
- event history is persisted
- terminal tasks can be pruned by a history limit
- a task that was `running` when VS Code shuts down is restored as `interrupted`, not silently forgotten

## Decision Contract

Planning is not just read-only chat.

The planning path should support:

- 2-4 meaningful options when multiple directions exist
- one recommended option
- a short context summary that explains the tradeoff
- a clean resume path after the user chooses

This decision contract should be provider-neutral even if Codex is the first implementation.

## Recovery And Resume Rules

The rewrite should define recovery behavior in user terms, not only provider terms.

Minimum rules:

- `continue` should resolve the most recent active or waiting task when there is no ambiguity
- `use the recommended option` should map onto the current waiting decision when one exists
- `failed`, `cancelled`, `timed out`, and `interrupted` should lead to different recovery suggestions
- if multiple tasks could match a continuation request, the user should be asked to disambiguate in plain language

Recommended restart behavior:

- `waiting_decision` tasks remain resumable after reconnect
- `running` tasks interrupted by extension restart return as `interrupted`
- resumption should favor reusing existing task context rather than silently creating a new unrelated task

## Provider Reality And Roadmap

The rewrite docs should be explicit about the difference between architecture target and v1 reality.

Architecture target:

- provider-neutral task model
- provider-neutral lifecycle
- provider-neutral OpenClaw-facing commands

Possible v1 reality:

- Codex is the only implemented provider

That is acceptable for a first version as long as the public task contract does not need to be redesigned to add Claude or another provider later.

## Relation To Legacy Agent Commands

The current repository exposes both:

- legacy `vscode.agent.*` commands
- resumable `vscode.agent.task.*` commands

The rewrite should decide early whether:

- both surfaces remain
- legacy commands become setup and diagnostics only
- all long-running assistant work converges onto the task model

That decision should be documented before implementation spreads both models further.
