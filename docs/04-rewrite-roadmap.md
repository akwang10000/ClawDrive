# Rewrite Roadmap

## Status Note

This document is now historical roadmap context.

Use it for:

- understanding the earlier phase framing of the rewrite
- understanding why the repository moved through transport, task framework, and natural-language milestones in that order

Do not use it as the current execution plan.

For the active next milestone, use:

- [12-next-step-plan.md](12-next-step-plan.md)

## Phase 0: Repository Setup

Create a new empty repository with:

- repository name `clawdrive-vscode`
- package name `clawdrive-vscode`
- extension identifier `wangtuo.clawdrive-vscode`
- configuration prefix `clawdrive`
- a new publisher identity
- a new README
- a new LICENSE decision
- a new icon and release metadata

Do not copy old repository assets or wording into the new project.

## Phase 1: Core Runtime

Build from scratch:

- extension activation
- configuration loading
- output logging
- status indicator
- WebSocket Gateway client
- request/response bookkeeping

Acceptance:

- the extension can connect and reconnect
- the node can advertise a small command list
- `vscode.workspace.info` can be invoked remotely

Note:

- this phase only proves transport
- it does not yet satisfy the primary requirement of natural-language-driven Codex or agent work

## Phase 2: Security Foundations

Build from scratch:

- workspace containment helper
- mutation policy helper
- safe command-line parsing for terminal execution
- CLI path validation helper
- timeout helper

Acceptance:

- containment rejects traversal and out-of-workspace targets
- mutating behavior can be blocked globally
- terminal execution remains off by default

## Phase 3: Read-Only Command Set

Implement:

- workspace info
- file read
- directory list
- editor context
- diagnostics
- selected language-read actions

Acceptance:

- the IDE node is useful for inspection before any write capability is enabled

## Phase 4: Mutating Command Set

Implement:

- file write/edit/delete
- selected language mutating actions
- optional format support

Acceptance:

- every mutating path runs through the same policy gate

## Phase 5: Task Framework

Build from scratch:

- task snapshot model
- task storage
- task orchestrator
- provider interface
- task result and decision APIs

Acceptance:

- plan tasks can pause for a decision and resume
- timeout, failure, cancellation, and interruption are distinct

Primary requirement check:

- OpenClaw must be able to hand natural-language work into this task framework without forcing the user to assemble raw protocol steps manually
- the framework must be provider-capable rather than permanently tied to a single backend

Before this phase is considered stable, write and lock:

- an intent-routing specification
- end-to-end validation goals for natural-language assistant behavior
- a first-class task-semantics specification covering lifecycle, persistence, interruption, and decision handling
- an operator setup and diagnosis specification covering connected, callable, and provider-ready states

## Phase 6: Activity UX

Build:

- activity store
- activity view
- deterministic task template layer

Acceptance:

- queued, running, waiting, completed, and failed task states read naturally
- progress noise does not dominate task identity
- task progress reads like assistant work, not protocol lifecycle noise

## Phase 6.5: Natural-Language Experience

Build:

- intent classification and routing rules
- default assistant reply patterns
- decision and continuation handling that does not depend on users knowing raw protocol details

Acceptance:

- a user can ask for inspection, planning, application, and continuation in ordinary language
- common follow-ups such as "continue" or "use the recommended option" resolve against the existing task flow
- raw command names are unnecessary for the normal path

## Cross-Phase Product Rule

Across all phases, the main product target is:

- OpenClaw natural language
- routed into VS Code AI agent execution through a provider layer
- with human-readable status back out

Any implementation choice that improves raw command coverage but weakens that chain should be treated as secondary.

## Provider Strategy

Recommended sequence:

1. Define the provider-neutral task contract first.
2. Implement Codex as the first provider adapter.
3. Keep storage, status text, and task APIs generic enough for additional providers.
4. Add later providers, such as Claude, without changing the OpenClaw-facing task model.

## Phase 7: Hardening

Add:

- regression tests for protocol, security, and task state transitions
- more complete git/test/debug coverage
- setup and diagnosis flows
- end-to-end validation for natural-language assistant scenarios, not just command execution

Acceptance:

- operator-facing diagnosis can explain common misconfiguration paths
- task restore, interruption, and history-pruning behavior are verified
- command-surface documentation stays aligned with real behavior, including known shim-style implementations

## Recommended Order For Early Delivery

If speed matters, the best first thin slice is:

1. connection
2. `workspace.info`
3. file read
4. directory list
5. activity view
6. task framework
7. write actions
