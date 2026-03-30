# Intent Routing Specification

## Why This Exists

The rewrite is not successful if it only exposes more `vscode.*` commands.

The primary user-facing contract is:

- a person talks to OpenClaw in normal language
- OpenClaw or the extension resolves that request into the right IDE path
- long-running work is expressed as an assistant task, not as a manual protocol script
- the reply back should sound like assistant progress, not transport chatter

This document defines that routing contract.

## Primary Rule

Natural language is the default control surface.

Raw command names remain useful for:

- debugging
- narrow operator control
- compatibility testing

They are not the preferred way to drive normal coding workflows.

## Intent Classes

The system should classify incoming requests into a small number of stable intent classes.

### Read And Inspect

Examples:

- read a file
- inspect the workspace
- check diagnostics
- summarize a named file
- summarize a named directory such as `src`

Expected route:

- direct read-only `vscode.*` commands

Expected behavior:

- no task orchestration unless the request becomes broad enough that multi-step analysis is clearer
- prefer grounded local summaries when the prompt explicitly names files or directories

### Analyze And Explain

Examples:

- summarize this repository
- explain how the gateway works
- explain the provider contract
- compare two implementations

Expected route:

- start with read-only commands
- escalate to a provider task in analysis mode when the request is broad, multi-file, or benefits from iterative reasoning

Expected behavior:

- read-first
- no file mutation
- concise explanation back to the user
- do not treat a generic mention of `provider` as a diagnosis request by itself

### Plan And Choose

Examples:

- give me options
- analyze the best next step
- plan first and do not modify anything

Expected route:

- provider task in planning mode

Expected behavior:

- produce candidate options
- expose a recommended choice
- wait for a user decision when the next step is materially different across options

### Apply And Modify

Examples:

- fix this bug
- implement the recommended plan
- update the docs

Expected route:

- provider-backed `apply` task
- explicit approval before local mutation

Expected behavior:

- use assistant-task orchestration rather than requiring the user to assemble task lifecycle calls manually
- keep planning and approval as distinct pauses
- report progress in natural language
- return a plain summary of what changed

### Continue And Recover

Examples:

- continue
- use the recommended option
- keep going
- why did the task fail

Expected route:

- resolve the most recent active or waiting task when unambiguous
- use diagnostics and status inspection when the user is debugging a failed or disconnected workflow

Expected behavior:

- avoid asking for a `taskId` unless there are multiple plausible tasks
- keep recovery language human-readable

## Routing Policy

The routing layer should follow these rules in order.

1. Prefer read-only handling when the request is inspection, explanation, or diagnosis.
2. Prefer grounded local inspect when the request explicitly names files, directories, or extension-wiring artifacts that can be read directly.
3. Prefer planning mode when the user asks for options, tradeoffs, or explicitly says not to change anything.
4. Do not enter write execution immediately on a broad modification request unless the intended scope is already clear.
5. Treat `continue`, `keep going`, or `use the recommended one` as task-resolution requests before treating them as new work.
6. Hide command names, task identifiers, and JSON payloads unless the user is debugging or asks for them directly.
7. When a task must pause for a choice, surface the choice in plain language and keep the recommended option obvious.
8. Route into diagnosis only for explicit status, readiness, connection, or failure-debugging prompts. Architecture questions that mention `provider` still belong to inspect or analyze.

## Provider-Neutral Execution Model

This routing contract must not depend on Codex-specific wording.

The stable layers should be:

- natural-language intent
- task mode selection
- task lifecycle and decision handling
- human-readable progress and result messages

Provider-specific logic belongs behind that layer.

The first implementation may support only Codex.
The design should still permit later adapters such as Claude without changing the OpenClaw-facing conversation model.

## Assistant Response Contract

The user should normally see:

- what the assistant is about to do
- whether the system is still analyzing, waiting, or applying
- what decision is needed, if any
- what happened in the end

The user should not normally need to see:

- raw `vscode.agent.task.*` command names
- raw lifecycle payloads
- provider event names
- internal session IDs

Good response style:

- short
- concrete
- action-oriented
- framed as assistant work inside the IDE

## Write Safety Rules

For requests that may modify code, files, git state, or external process state:

- inspect first when the change scope is unclear
- plan first when there are multiple valid directions
- require explicit write intent before broad changes
- preserve cancellation, timeout, failure, and waiting-for-decision as distinct user-visible states

## Success Criteria

This routing layer is working when:

- a user can start with normal language instead of raw commands
- the system chooses inspect, analyze, plan, or apply paths without hand-written protocol choreography
- the user can continue a waiting plan with natural language instead of manually providing internal identifiers
- progress and failure text read like assistant updates rather than transport logs
